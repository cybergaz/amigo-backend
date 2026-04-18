import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import {
  message_model,
  message_info_model,
  DBMessageType,
  DBInsertMessageType,
} from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { broadcast_message } from "@/sockets/socket.handlers";
import {
  // ConversationMetadata,
  // MessageMetadata,
  PinMessageRequest,
  ReplyMessageRequest,
  ForwardMessageRequest,
  DeleteMessageRequest,
  ReactMessageRequest,
  MessageType
} from "@/types/chat.types";
import { ResultType } from "@/types/core.types";
import { ChatMessagePayload, MessagePinPayload, MessageReactPayload, } from "@/types/socket.types";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
    const pg_code = err?.cause?.code ?? err?.code;
    if (pg_code === '23505') {
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
  const first = await store_message(payload);
  if (first.success) return first;
  if (first.code !== 409) return first;

  for (let i = 0; i < retry_count; i++) {
    const new_id = randomUUIDv7();
    const result = await store_message(payload, new_id);
    if (result.success) return { ...result, new_id };
    if (result.code !== 409) return result;
  }

  return {
    success: false,
    code: 500,
    message: "Failed to store message after retries — ID collision persisted",
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
        message: "Coudn't pin the message",
      };
    }

    // Fetch sender name for the broadcast payload
    // const user = await get_user_info(payload.user_id);

    // Broadcast pin event to all members of the conversation
    const pinPayload: MessagePinPayload = {
      conv_id: payload.conv_id,
      message_id: payload.message_id,
      message_type: message.type as MessageType,
      sender_id: payload.user_id,
      // sender_name: user?.name ?? undefined,
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
    // const user = await get_user_info(payload.user_id);

    // Broadcast unpin event to all members of the conversation
    const unpinPayload: MessagePinPayload = {
      conv_id: payload.conv_id,
      message_id: payload.message_id,
      message_type: (message?.type ?? "text") as MessageType,
      sender_id: payload.user_id,
      // sender_name: user?.name ?? undefined,
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
      // sender_name: user_name,
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
  react_to_message,
};
