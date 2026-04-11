import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import {
  message_model,
  message_info_model,
  DBMessageType,
  DBUpdateMessageStatusType,
  DBInsertMessageStatusType,
  DBInsertMessageType,
} from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { broadcast_message } from "@/sockets/socket.handlers";
import {
  ConversationMetadata,
  MessageMetadata,
  PinMessageRequest,
  StarMessageRequest,
  ReplyMessageRequest,
  ForwardMessageRequest,
  DeleteMessageRequest,
  MediaMetadataRequest,
  ReactMessageRequest,
  MessageType
} from "@/types/chat.types";
import { ResultType } from "@/types/core.types";
import { ChatMessageAckPayload, ChatMessagePayload, MessagePinPayload, MessageReactPayload, SyncMessagesPayload } from "@/types/socket.types";
import { create_unique_id } from "@/utils/general.utils";
import Snowflake from "@/utils/snowflake.utils";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { log_current_cache_state, remove_pending_message } from "./cache-management/polling.cache";
import { randomUUIDv7 } from "bun";

// Helper function to verify user membership in conversation
const verify_user_membership = async (conversation_id: string, user_id: string) => {
  const membership = await db
    .select({ id: chat_member_model.id, role: chat_member_model.role })
    .from(chat_member_model)
    .where(
      and(
        eq(chat_member_model.chat_id, conversation_id),
        eq(chat_member_model.user_id, user_id),
        isNull(chat_member_model.removed_at)
      )
    );

  return membership.length > 0 ? membership[0] : null;
};

// Helper function to get user info
const get_user_info = async (user_id: string) => {
  const [user] = await db
    .select({ id: user_model.id, name: user_model.name })
    .from(user_model)
    .where(eq(user_model.id, user_id));

  return user;
};

const store_message = async (payload: ChatMessagePayload, custom_msg_id?: string): Promise<ResultType<DBInsertMessageType>> => {
  try {

    const [new_message] = await db
      .insert(message_model)
      .values({
        id: custom_msg_id ? custom_msg_id : payload.id,
        chat_id: payload.conv_id,
        replied_to: payload.replied_to || null,
        sender_id: payload.sender_id,
        type: payload.msg_type,
        body: payload.body,
        attachments: payload.attachments,
        sent_at: new Date(payload.sent_at),
      }).returning();

    if (!new_message) {
      return {
        success: false,
        code: 500,
        message: "Failed to store message",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message stored successfully",
      data: new_message,
    };
  }
  catch (error) {
    const err = error as any;
    // Handle unique constraint violation (message ID already exists)
    if (err.cause.code == '23505') {
      return {
        success: false,
        code: 409,
        message: "message id already exists",
      };
    }
    return {
      success: false,
      code: 500,
      message: "Failed to store message",
    };
  }
};


interface StoreWithRetryResultType extends ResultType<DBInsertMessageType> {
  new_id?: string; // If a new ID was generated due to collision, return it here
}

const store_message_with_retry = async (payload: ChatMessagePayload, retry_count: number): Promise<StoreWithRetryResultType> => {
  // first try with the provided ID (optimistic case — client generates UUIDv7)
  const store_result = await store_message(payload);

  if (store_result.success) {
    return store_result;
  }
  for (let i = 0; i < retry_count; i++) {
    // if failed due to ID collision, generate a new server-side ID and try again
    const new_id = randomUUIDv7();
    const store_result = await store_message(payload, new_id);
    if (store_result.success) {
      return { ...store_result, new_id };
    }
  }

  return {
    success: false,
    code: 500,
    message: "Failed to store message",
  };
};

// Pin a message in a conversation — stores message_id in chat_model.pinned_msg_id
// (only one pinned message per conversation; calling again overwrites the previous pin)
const pin_message = async (payload: PinMessageRequest) => {
  try {
    // Verify user is a member of the conversation
    const membership = await verify_user_membership(payload.conv_id, payload.user_id);
    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Verify message exists in this conversation and isn't deleted
    const [message] = await db
      .select({
        id: message_model.id,
        type: message_model.type,
      })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, payload.message_id),
          eq(message_model.chat_id, payload.conv_id),
          isNull(message_model.deleted_at)
        )
      )
      .limit(1);

    if (!message) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    // Store the pinned message ID on the chat
    const [updated] = await db
      .update(chat_model)
      .set({ pinned_msg_id: payload.message_id })
      .where(eq(chat_model.id, payload.conv_id))
      .returning({ id: chat_model.id });

    if (!updated) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    // Fetch sender name for the broadcast payload
    const user = await get_user_info(payload.user_id);

    // Broadcast pin event to all members of the conversation
    const pinPayload: MessagePinPayload = {
      conv_id: payload.conv_id,
      message_id: payload.message_id,
      message_type: message.type as MessageType,
      sender_id: payload.user_id,
      sender_name: user?.name ?? undefined,
      pin: true,
    };

    await broadcast_message({
      to: "conversation",
      conv_id: payload.conv_id,
      message: {
        type: "message:pin",
        payload: pinPayload,
        ws_timestamp: new Date(),
      },
    });

    return {
      success: true,
      code: 200,
      message: "Message pinned successfully",
      data: { conv_id: payload.conv_id, message_id: payload.message_id },
    };
  } catch (error) {
    console.error("pin_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: pin_message",
    };
  }
};

// Unpin a message — clears chat_model.pinned_msg_id, but only if the
// currently pinned message matches the requested message_id (idempotent guard).
const unpin_message = async (payload: PinMessageRequest) => {
  try {
    // Verify user is a member of the conversation
    const membership = await verify_user_membership(payload.conv_id, payload.user_id);
    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Get current pinned_msg_id to verify it matches
    const [conv] = await db
      .select({ pinned_msg_id: chat_model.pinned_msg_id })
      .from(chat_model)
      .where(eq(chat_model.id, payload.conv_id))
      .limit(1);

    if (!conv) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    if (conv.pinned_msg_id !== payload.message_id) {
      return {
        success: false,
        code: 409,
        message: "This message is not currently pinned",
      };
    }

    // Fetch message type for the broadcast payload (best-effort — may be deleted)
    const [message] = await db
      .select({ type: message_model.type })
      .from(message_model)
      .where(eq(message_model.id, payload.message_id))
      .limit(1);

    // Clear the pinned message
    await db
      .update(chat_model)
      .set({ pinned_msg_id: null })
      .where(eq(chat_model.id, payload.conv_id));

    // Fetch sender name for the broadcast payload
    const user = await get_user_info(payload.user_id);

    // Broadcast unpin event to all members of the conversation
    const unpinPayload: MessagePinPayload = {
      conv_id: payload.conv_id,
      message_id: payload.message_id,
      message_type: (message?.type ?? "text") as MessageType,
      sender_id: payload.user_id,
      sender_name: user?.name ?? undefined,
      pin: false,
    };

    await broadcast_message({
      to: "conversation",
      conv_id: payload.conv_id,
      message: {
        type: "message:pin",
        payload: unpinPayload,
        ws_timestamp: new Date(),
      },
    });

    return {
      success: true,
      code: 200,
      message: "Message unpinned successfully",
      data: { conv_id: payload.conv_id, message_id: payload.message_id },
    };
  } catch (error) {
    console.error("unpin_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: unpin_message",
    };
  }
};

// Reply to message
const reply_to_message = async (request: ReplyMessageRequest, user_id: string) => {
  try {
    // Verify user membership
    // const membership = await verify_user_membership(request.conversation_id, user_id);
    // if (!membership) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "You are not a member of this conversation",
    //   };
    // }

    // Get original message info
    const [originalMessage] = await db
      .select({
        id: message_model.id,
        body: message_model.body,
        sender_id: message_model.sender_id,
        created_at: message_model.created_at,
      })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, request.reply_to_message_id),
          eq(message_model.chat_id, request.conversation_id),
          isNull(message_model.deleted_at)
        )
      );


    if (!originalMessage) {
      return {
        success: false,
        code: 404,
        message: "Original message not found",
      };
    }

    // Create new reply message — replied_to column stores the reference
    const [replyMessage] = await db
      .insert(message_model)
      .values({
        id: request.message_id,
        chat_id: request.conversation_id,
        sender_id: user_id,
        type: "text",
        body: request.body,
        attachments: request.attachments,
        replied_to: originalMessage.id,
      })
      .returning();

    // Update conversation's last_msg_at
    await db
      .update(chat_model)
      .set({ last_msg_at: new Date(), last_msg_id: replyMessage?.id })
      .where(eq(chat_model.id, request.conversation_id));

    return {
      success: true,
      code: 200,
      message: "Reply sent successfully",
      data: replyMessage,
    };

  } catch (error) {
    console.error("reply_to_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: reply_to_message",
    };
  }
};

// Forward messages
const forward_messages = async (request: ForwardMessageRequest, user_id: string) => {
  try {

    // Get messages to forward
    const original_messages = await db
      .select()
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, request.message_ids),
          eq(message_model.chat_id, request.source_conversation_id),
          isNull(message_model.deleted_at)
        )
      )
      .orderBy(message_model.created_at);

    if (original_messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No valid messages found to forward",
      };
    }

    const forwardedMessages: Map<string, (DBMessageType & { conv_type: string; })[]> = new Map();

    for (const target_conv_id of request.target_conversation_ids) {

      const all_msgs: (DBMessageType & { conv_type: string; })[] = [];

      const [conv] = await db
        .select({ conv_type: chat_model.type })
        .from(chat_model)
        .where(eq(chat_model.id, target_conv_id));


      for (const message of original_messages) {
        const [inserted_msg] = await db
          .insert(message_model)
          .values({
            id: randomUUIDv7(),
            chat_id: target_conv_id,
            sender_id: user_id,
            type: message.type,
            body: message.body,
            attachments: message.attachments,
            sent_at: new Date(),
          }).returning();

        all_msgs.push({
          ...inserted_msg,
          conv_type: conv.conv_type
        });
      }

      forwardedMessages.set(target_conv_id, all_msgs);
    }

    return {
      success: true,
      code: 200,
      message: "Messages forwarded successfully",
      data: forwardedMessages,
    };

  } catch (error) {
    console.error("forward_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: forward_messages",
    };
  }
};

// Delete messages
const delete_messages = async (request: DeleteMessageRequest, user_id: string) => {
  try {
    // Verify user membership
    // const membership = await verify_user_membership(request.conversation_id, user_id);
    // if (!membership) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "You are not a member of this conversation",
    //   };
    // }

    // Get messages to delete
    const messages = await db
      .select()
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, request.message_ids),
          eq(message_model.chat_id, request.conversation_id),
          isNull(message_model.deleted_at)
        )
      );

    if (messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No valid messages found to delete",
      };
    }

    // Delete for everyone - only message sender or admin can do this
    // const validMessages = messages.filter(msg =>
    //   msg.sender_id === user_id || membership.role === "admin"
    // );
    //
    // if (validMessages.length === 0) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "You can only delete your own messages or you need admin privileges",
    //   };
    // }

    const deletedMessages = [];
    // Mark messages as deleted
    for (const message of request.message_ids) {
      const [deletedMessage] = await db
        .update(message_model)
        .set({
          deleted_at: new Date(),
        })
        .where(eq(message_model.id, message))
        .returning();

      deletedMessages.push(deletedMessage);
    }

    return {
      success: true,
      code: 200,
      message: "Messages deleted for everyone",
      data: deletedMessages,
    };

    // } else {
    //   // Delete for me only - store in user's metadata (not implemented in this basic version)
    //   // This would require a separate table or user-specific metadata to track deleted messages per user
    //   return {
    //     success: false,
    //     code: 501,
    //     message: "Delete for me only is not implemented yet",
    //   };
    // }

  } catch (error) {
    console.error("delete_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: delete_messages",
    };
  }
};

// Get pinned messages for a conversation
// TODO: needs dedicated pinned_message_id column on chat_model (metadata column was removed)
const get_pinned_messages = async (conversation_id: string, user_id: string) => {
  return {
    success: false,
    code: 501,
    message: "Get pinned feature pending migration — metadata column removed",
  };
};

// TODO: needs dedicated star tracking (e.g. via message_info_model) — metadata column was removed
const get_starred_messages = async (user_id: string, conversation_id?: string) => {
  return {
    success: false,
    code: 501,
    message: "Get starred feature pending migration — metadata column removed",
  };
};

const insert_message_status = async (msg_status: Pick<DBInsertMessageStatusType, "user_id" | "message_id" | "chat_id" | "delivered_at" | "read_at">) => {
  try {

    // Upsert message status
    const [inserted_status] = await db
      .insert(message_info_model)
      .values({
        user_id: msg_status.user_id,
        message_id: msg_status.message_id,
        chat_id: msg_status.chat_id,
        delivered_at: msg_status.delivered_at,
        read_at: msg_status.read_at,
      }).returning();

    if (!inserted_status) {
      return {
        success: false,
        code: 500,
        message: "Failed to store message status",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message status stored successfully",
      data: inserted_status,
    };

  } catch (error) {
    console.error("ERROR: store_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: store_message_status",
    };
  }
};

const update_message_status = async (msg_status: DBUpdateMessageStatusType) => {
  try {

    if (!msg_status.message_id || !msg_status.user_id) {
      return {
        success: false,
        code: 400,
        message: "message_id and user_id are required",
      };
    }

    let updated_status;
    if (msg_status.delivered_at && !msg_status.read_at) {

      updated_status = (await db
        .update(message_info_model)
        .set({
          delivered_at: msg_status.delivered_at,
        }).where(
          and(
            eq(message_info_model.message_id, msg_status.message_id),
            eq(message_info_model.user_id, msg_status.user_id)
          )
        ).returning())[0];
    }
    else if (!msg_status.delivered_at && msg_status.read_at) {
      updated_status = (await db
        .update(message_info_model)
        .set({
          read_at: msg_status.delivered_at,
        }).where(
          and(
            eq(message_info_model.message_id, msg_status.message_id),
            eq(message_info_model.user_id, msg_status.user_id)
          )
        ).returning())[0];
    }
    else {
      // Upsert message status
      updated_status = (await db
        .update(message_info_model)
        .set({
          delivered_at: msg_status.delivered_at,
          read_at: msg_status.read_at,
        }).where(
          and(
            eq(message_info_model.message_id, msg_status.message_id),
            eq(message_info_model.user_id, msg_status.user_id)
          )
        ).returning())[0];
    }

    if (updated_status === undefined || updated_status === null) {
      return {
        success: false,
        code: 500,
        message: "Failed to update message status",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message status updated successfully",
      data: updated_status,
    };

  } catch (error) {
    console.error("ERROR: update_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: update_message_status",
    };
  }
};

// Batch insert message statuses for multiple messages and users
// This is MUCH more efficient than calling insert_message_status in a loop
// 
// Example: For 20 messages forwarded to 30 conversations with 40 users each:
// - Old way: 20 * 30 * 40 = 24,000 DB calls
// - New way: 30 DB calls (one per conversation) or even 1 call if we batch everything
// 
// @param statuses Array of message status records to insert
// @returns Success/failure response
const batch_insert_message_status = async (
  statuses: Array<Pick<DBInsertMessageStatusType, "user_id" | "message_id" | "chat_id" | "delivered_at" | "read_at">>
) => {
  try {
    if (statuses.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No statuses to insert",
        data: [],
      };
    }

    // Prepare all records with timestamps
    const records = statuses.map(status => ({
      user_id: status.user_id,
      message_id: status.message_id,
      chat_id: status.chat_id,
      delivered_at: status.delivered_at || null,
      read_at: status.read_at || null,
    }));

    // Batch insert all records in a single query
    // This is exponentially faster than individual inserts
    const inserted_statuses = await db
      .insert(message_info_model)
      .values(records)
      .returning();

    return {
      success: true,
      code: 200,
      message: `Batch inserted ${inserted_statuses.length} message statuses`,
      data: inserted_statuses,
    };

  } catch (error) {
    console.error("ERROR: batch_insert_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: batch_insert_message_status",
    };
  }
};

// Batch update message statuses for multiple messages for a single user
// Useful for marking multiple messages as read/delivered when user opens a conversation
// 
// Example: User opens conversation with 50 unread messages
// - Old way: 50 individual update queries
// - New way: 1 batch update using SQL WHERE IN clause
// 
// @param user_id The user whose message statuses are being updated
// @param conv_id The conversation ID (optional, for more specific updates)
// @param message_ids Array of message IDs to update
// @param status_update Object containing delivered_at and/or read_at timestamps
// @returns Success/failure response
const batch_update_message_status = async (
  user_id: string,
  message_ids: string[],
  status_update: { delivered_at?: Date; read_at?: Date; },
  conv_id?: string
) => {
  try {
    if (message_ids.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No message statuses to update",
        data: [],
      };
    }

    // Build the update object dynamically
    const updateData: { delivered_at?: Date; read_at?: Date; } = {};

    if (status_update.delivered_at) {
      updateData.delivered_at = status_update.delivered_at;
    }
    if (status_update.read_at) {
      updateData.read_at = status_update.read_at;
    }

    // Build WHERE conditions
    const whereConditions = [
      eq(message_info_model.user_id, user_id),
      inArray(message_info_model.message_id, message_ids)
    ];

    // Optionally filter by conversation ID for more specific updates
    if (conv_id !== undefined) {
      whereConditions.push(eq(message_info_model.chat_id, conv_id));
    }

    // Update all message statuses in a single query
    const updated_statuses = await db
      .update(message_info_model)
      .set(updateData)
      .where(and(...whereConditions))
      .returning();

    return {
      success: true,
      code: 200,
      message: `Batch updated ${updated_statuses.length} message statuses`,
      data: updated_statuses,
    };

  } catch (error) {
    console.error("ERROR: batch_update_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: batch_update_message_status",
    };
  }
};

// Mark a message as delivered via API (typically from FCM when app was killed)
// This updates the database and broadcasts a WebSocket message to the sender.
// When is_active_in_conv is true (recipient is currently viewing the conversation)
// the message is also marked as read in the message_status table and the ack
// includes read_by so the sender's read-receipt widget updates in real time.
//
// @param message_id The ID of the message that was delivered
// @param conversation_id The conversation ID
// @param recipient_id The user ID who received the message
// @param is_active_in_conv Whether the recipient is currently active in the conv
// @returns Success/failure response
const mark_message_delivered = async (
  message_id: string,
  conversation_id: string,
  recipient_id: string,
  is_active_in_conv: boolean = false,
) => {
  try {
    // Get message details to find sender
    const [message] = await db
      .select({
        id: message_model.id,
        sender_id: message_model.sender_id,
        chat_id: message_model.chat_id,
      })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, message_id),
          eq(message_model.chat_id, conversation_id),
          isNull(message_model.deleted_at)
        )
      )
      .limit(1);

    if (!message) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    const sender_id = message.sender_id ?? "";
    const now = new Date();

    // Update message_status table — always set delivered_at; also set read_at
    // when the recipient is actively viewing the conversation.
    await update_message_status({
      message_id: message_id,
      user_id: recipient_id,
      delivered_at: now,
      ...(is_active_in_conv && { read_at: now }),
    });

    const ack_payload: ChatMessageAckPayload = {
      id: message_id,
      conv_id: conversation_id,
      sender_id: sender_id,
      delivered_at: now,
      delivered_to: is_active_in_conv ? [] : [recipient_id],
      read_by: is_active_in_conv ? [recipient_id] : [],
    };

    // Send ack to the original message sender
    await broadcast_message({
      to: "users",
      user_ids: [sender_id],
      message: {
        type: "message:ack",
        payload: ack_payload,
        ws_timestamp: new Date()
      },
    });

    // ------------------------------------------------------------------
    // WARNING: TEMP LOGIC
    // ------------------------------------------------------------------
    // remove the message:new from missed_msgs for the recipients
    const missed_msg_key = Snowflake.correlationId(recipient_id, "message:new", message_id);
    // console.log(`[API] Removing pending message key ${missed_msg_key} for recipient ${recipient_id}`);
    await remove_pending_message(recipient_id, missed_msg_key);
    // console.log(`[API] Removed pending message key ${missed_msg_key} for recipient ${recipient_id}`);
    // log_current_cache_state(recipient_id);

    // console.log(`[API] Delivery receipt processed: message ${message_id} delivered to user ${recipient_id}`);

    return {
      success: true,
      code: 200,
      message: "Message marked as delivered successfully",
      data: {
        message_id,
        conversation_id,
        recipient_id,
        delivered_at: new Date(),
      },
    };

  } catch (error) {
    console.error("ERROR: mark_message_delivered", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: mark_message_delivered",
    };
  }
};

const mark_messages_delivered_batch = async (
  messages: Array<{ message_id: string; conversation_id: string; }>,
  recipient_id: string
) => {
  const results = await Promise.allSettled(
    messages.map(({ message_id, conversation_id }) =>
      mark_message_delivered(message_id, conversation_id, recipient_id)
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value?.success).length;
  const failed = results.length - succeeded;

  // console.log(`[API] Batch delivery: ${succeeded} succeeded, ${failed} failed for user ${recipient_id}`);

  return {
    success: succeeded > 0,
    code: 200,
    message: `Batch delivery processed: ${succeeded}/${results.length} succeeded`,
    data: { succeeded, failed },
  };
};

const verify_message_ids = async (
  message_ids: string[],
  conversation_id: string,
  sender_id: string
): Promise<ResultType<{
  found: Record<string, { delivered_to: string[]; read_by: string[]; }>;
  not_found: string[];
}>> => {
  try {
    if (message_ids.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No IDs to verify",
        data: { found: {}, not_found: [] },
      };
    }

    // Only fetch messages where sender matches auth user (security)
    const rows = await db
      .select({ id: message_model.id })
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, message_ids),
          eq(message_model.chat_id, conversation_id),
          eq(message_model.sender_id, sender_id),
          isNull(message_model.deleted_at),
        )
      );

    const foundIds = new Set(rows.map((r) => r.id));
    const not_found = message_ids.filter((id) => !foundIds.has(id));

    const found: Record<string, { delivered_to: string[]; read_by: string[]; }> = {};
    if (rows.length > 0) {
      for (const r of rows) found[r.id] = { delivered_to: [], read_by: [] };

      const statusRows = await db
        .select({
          message_id: message_info_model.message_id,
          user_id: message_info_model.user_id,
          delivered_at: message_info_model.delivered_at,
          read_at: message_info_model.read_at,
        })
        .from(message_info_model)
        .where(
          and(
            inArray(message_info_model.message_id, rows.map((r) => r.id)),
            eq(message_info_model.chat_id, conversation_id),
          )
        );

      for (const s of statusRows) {
        const key = s.message_id;
        if (!found[key]) continue;
        if (s.delivered_at) found[key].delivered_to.push(s.user_id);
        if (s.read_at) found[key].read_by.push(s.user_id);
      }
    }

    return { success: true, code: 200, message: "OK", data: { found, not_found } };
  } catch (e) {
    console.error("verify_message_ids error", e);
    return { success: false, code: 500, message: "ERROR: verify_message_ids" };
  }
};

// React/unreact to a message - stores per-user reaction in message_status table
const react_to_message = async (request: ReactMessageRequest, user_id: string, user_name?: string) => {
  try {
    // Verify the message exists
    const [message] = await db
      .select({ id: message_model.id, chat_id: message_model.chat_id })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, request.message_id),
          eq(message_model.chat_id, request.conversation_id),
          isNull(message_model.deleted_at)
        )
      )
      .limit(1);

    if (!message) {
      return { success: false, code: 404, message: "Message not found" };
    }

    // Upsert the user's reaction into message_info
    const newReaction = request.action === 'add' ? request.emoji : null;
    await db
      .insert(message_info_model)
      .values({
        message_id: request.message_id,
        user_id,
        chat_id: request.conversation_id,
        reaction: newReaction,
      })
      .onConflictDoUpdate({
        target: [message_info_model.message_id, message_info_model.user_id],
        set: {
          reaction: newReaction,
        },
      });

    // Delta-only broadcast — send just the change, not the full reactions map
    const reactPayload: MessageReactPayload = {
      message_id: request.message_id,
      conv_id: request.conversation_id,
      sender_id: user_id,
      sender_name: user_name,
      emoji: request.emoji,
      action: request.action,
    };

    await broadcast_message({
      to: "conversation",
      conv_id: request.conversation_id,
      message: {
        type: "message:react",
        payload: reactPayload,
        ws_timestamp: new Date(),
      },
    });

    return { success: true, code: 200, message: "Reaction updated" };
  } catch (error) {
    console.error("react_to_message error", error);
    return { success: false, code: 500, message: "ERROR: react_to_message" };
  }
};

export {
  store_message,
  store_message_with_retry,
  pin_message,
  unpin_message,
  reply_to_message,
  forward_messages,
  delete_messages,
  get_pinned_messages,
  get_starred_messages,
  insert_message_status,
  update_message_status,
  batch_insert_message_status,
  batch_update_message_status,
  mark_message_delivered,
  mark_messages_delivered_batch,
  verify_message_ids,
  react_to_message,
};
