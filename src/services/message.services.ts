import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
  message_model,
  DBMessageType,
  DBUpdateMessageStatusType,
  message_status_model,
  DBInsertMessageStatusType,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  ConversationMetadata,
  MessageMetadata,
  PinMessageRequest,
  StarMessageRequest,
  ReplyMessageRequest,
  ForwardMessageRequest,
  DeleteMessageRequest,
  MediaMetadataRequest,
  MessageType
} from "@/types/chat.types";
import { ChatMessagePayload, MessagePinPayload } from "@/types/socket.types";
import { create_unique_id } from "@/utils/general.utils";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

// Helper function to verify user membership in conversation
const verify_user_membership = async (conversation_id: number, user_id: number) => {
  const membership = await db
    .select({ id: conversation_member_model.id, role: conversation_member_model.role })
    .from(conversation_member_model)
    .where(
      and(
        eq(conversation_member_model.conversation_id, conversation_id),
        eq(conversation_member_model.user_id, user_id)
      )
    );

  return membership.length > 0 ? membership[0] : null;
};

// Helper function to get user info
const get_user_info = async (user_id: number) => {
  const [user] = await db
    .select({ id: user_model.id, name: user_model.name })
    .from(user_model)
    .where(eq(user_model.id, user_id));

  return user;
};

const store_message = async (payload: ChatMessagePayload) => {
  try {

    // Handle reply metadata if applicable
    if (payload.reply_to_message_id) {
      // Fetch original message info
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
            eq(message_model.id, payload.reply_to_message_id),
            eq(message_model.conversation_id, payload.conv_id),
            eq(message_model.deleted, false)
          )
        );

      if (originalMessage) {
        // Create reply metadata
        const replyMetadata: MessageMetadata = {
          reply_to: {
            message_id: originalMessage.id,
            sender_id: originalMessage.sender_id,
            body: originalMessage.body?.substring(0, 100) || "", // Preview of original message
            created_at: originalMessage.created_at?.toISOString() || ""
          }
        };

        payload.metadata = {
          ...(payload.metadata || {}),
          ...replyMetadata
        };
      }
    }

    const [new_message] = await db
      .insert(message_model)
      .values({
        conversation_id: payload.conv_id,
        sender_id: payload.sender_id,
        type: payload.msg_type,
        body: payload.body,
        attachments: payload.attachments,
        metadata: payload.metadata,
        sent_at: new Date(payload.sent_at),
      }).returning()

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
    console.error("storing message", error);
    return {
      success: false,
      code: 500,
      message: "Failed to store message",
    };
  }
}

// Pin messages
const pin_message = async (payload: PinMessageRequest) => {
  try {
    // Get current conversation metadata
    const [conversation] = await db
      .select({ metadata: conversation_model.metadata })
      .from(conversation_model)
      .where(eq(conversation_model.id, payload.conv_id))
      .limit(1);

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    const currentMetadata = (conversation.metadata as ConversationMetadata) || {};

    // Check if this message is already pinned
    const isCurrentlyPinned = currentMetadata.pinned_message?.message_id === payload.message_id;

    let newMetadata: ConversationMetadata;

    if (isCurrentlyPinned) {
      // Unpin the message by removing pinned_message from metadata
      const { pinned_message, ...restMetadata } = currentMetadata;

      newMetadata = {
        ...restMetadata,
        pinned_message: {
          message_id: payload.message_id,
          user_id: payload.user_id,
          pinned_at: new Date().toISOString()
        }
      }
    } else {
      // Pin the new message (this will replace any existing pinned message)

      newMetadata = {
        ...currentMetadata,
        pinned_message: {
          message_id: payload.message_id,
          user_id: payload.user_id,
          pinned_at: new Date().toISOString()
        }
      };
    }

    // Update conversation metadata
    await db
      .update(conversation_model)
      .set({ metadata: newMetadata })
      .where(eq(conversation_model.id, payload.conv_id));

    return {
      success: true,
      code: 200,
      message: "Message pinned successfully",
      data: {
        conversation_id: payload.conv_id,
        message_id: payload.message_id,
        pinned: !isCurrentlyPinned,
        pinned_by: !isCurrentlyPinned ? {
          user_id: payload.user_id,
          pinned_at: new Date().toISOString()
        } : null
      },
    };
  }
  catch (error) {
    console.error("pin_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: pin_messages",
    };
  }
};

const unpin_message = async (payload: PinMessageRequest) => {
  try {
    // Get current conversation metadata
    const [conversation] = await db
      .select({ metadata: conversation_model.metadata })
      .from(conversation_model)
      .where(eq(conversation_model.id, payload.conv_id))
      .limit(1);

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    const currentMetadata = (conversation.metadata as ConversationMetadata) || {};

    // Check if this message is already pinned
    const isCurrentlyPinned = currentMetadata.pinned_message?.message_id === payload.message_id;

    let newMetadata: ConversationMetadata = currentMetadata;

    if (isCurrentlyPinned) {
      // Unpin the message by removing pinned_message from metadata
      const { pinned_message, ...restMetadata } = currentMetadata;
      newMetadata = restMetadata;
    }

    // Update conversation metadata
    await db
      .update(conversation_model)
      .set({ metadata: newMetadata })
      .where(eq(conversation_model.id, payload.conv_id));

    return {
      success: true,
      code: 200,
      message: "Message unpinned successfully",
      data: {
        conversation_id: payload.conv_id,
        message_id: payload.message_id,
        pinned: !isCurrentlyPinned,
        pinned_by: !isCurrentlyPinned ? {
          user_id: payload.user_id,
          pinned_at: new Date().toISOString()
        } : null
      },
    };
  }
  catch (error) {
    console.error("unpin_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: unpin_messages",
    };
  }
};

// Star/Unstar messages
const star_messages = async (request: StarMessageRequest, user_id: number) => {
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
    //
    // // Get user info
    // const user = await get_user_info(user_id);
    // if (!user) {
    //   return {
    //     success: false,
    //     code: 404,
    //     message: "User not found",
    //   };
    // }

    // Get messages to star
    const messages = await db
      .select()
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, request.message_ids),
          eq(message_model.conversation_id, request.conversation_id),
          eq(message_model.deleted, false)
        )
      );

    if (messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No valid messages found to star",
      };
    }

    // Update messages with star metadata
    const updatedMessages = [];
    for (const message of messages) {
      const currentMetadata = (message.metadata as MessageMetadata) || {};
      const starredBy = currentMetadata.starred_by || [];

      // Check if user already starred this message
      const existingStarIndex = starredBy.findIndex(star => star.user_id === user_id);

      let newStarredBy;
      if (existingStarIndex >= 0) {
        // Unstar - remove user from starred_by array
        newStarredBy = starredBy.filter((_, index) => index !== existingStarIndex);
      } else {
        // Star - add user to starred_by array
        newStarredBy = [
          ...starredBy,
          {
            user_id,
            starred_at: new Date().toISOString()
          }
        ];
      }

      const newMetadata: MessageMetadata = {
        ...currentMetadata,
        starred_by: newStarredBy.length > 0 ? newStarredBy : undefined
      };

      const [updatedMessage] = await db
        .update(message_model)
        .set({ metadata: newMetadata })
        .where(eq(message_model.id, message.id))
        .returning();

      updatedMessages.push(updatedMessage);
    }

    return {
      success: true,
      code: 200,
      message: "Messages star status updated successfully",
      data: updatedMessages,
    };

  } catch (error) {
    console.error("star_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: star_messages",
    };
  }
};

// Reply to message
const reply_to_message = async (request: ReplyMessageRequest, user_id: number) => {
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
          eq(message_model.conversation_id, request.conversation_id),
          eq(message_model.deleted, false)
        )
      );


    if (!originalMessage) {
      return {
        success: false,
        code: 404,
        message: "Original message not found",
      };
    }

    // Create reply metadata
    const replyMetadata: MessageMetadata = {
      reply_to: {
        message_id: originalMessage.id,
        sender_id: originalMessage.sender_id,
        body: originalMessage.body?.substring(0, 100) || "", // Preview of original message
        created_at: originalMessage.created_at?.toISOString() || ""
      }
    };

    // Create new reply message
    const [replyMessage] = await db
      .insert(message_model)
      .values({
        conversation_id: request.conversation_id,
        sender_id: user_id,
        type: "text",
        body: request.body,
        attachments: request.attachments,
        metadata: replyMetadata,
      })
      .returning();

    // Update conversation's last_message_at
    await db
      .update(conversation_model)
      .set({ last_message_at: new Date() })
      .where(eq(conversation_model.id, request.conversation_id));

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
const forward_messages = async (request: ForwardMessageRequest, user_id: number) => {
  try {

    // Get messages to forward
    const original_messages = await db
      .select()
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, request.message_ids),
          eq(message_model.conversation_id, request.source_conversation_id),
          eq(message_model.deleted, false)
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

    const forwardedMessages: Map<number, (DBMessageType & { conv_type: string })[]> = new Map();

    for (const target_conv_id of request.target_conversation_ids) {

      const all_msgs: (DBMessageType & { conv_type: string })[] = [];

      const [conv] = await db
        .select({ conv_type: conversation_model.type })
        .from(conversation_model)
        .where(eq(conversation_model.id, target_conv_id))


      for (const message of original_messages) {
        const [inserted_msg] = await db.insert(message_model).values({
          conversation_id: target_conv_id,
          sender_id: user_id,
          type: message.type,
          body: message.body,
          attachments: message.attachments,
          metadata: {
            ...message.metadata as MessageMetadata,
            forwarded_from: {
              original_message_id: message.id,
              original_conversation_id: request.source_conversation_id,
              original_sender_id: message.sender_id,
              forwarded_by: user_id,
              forwarded_at: new Date().toISOString()
            }
          },
          forwarded_from: request.source_conversation_id,
          sent_at: new Date(),
        }).returning()

        all_msgs.push({
          ...inserted_msg,
          conv_type: conv.conv_type
        })
      }

      forwardedMessages.set(target_conv_id, all_msgs)
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
const delete_messages = async (request: DeleteMessageRequest, user_id: number) => {
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
          eq(message_model.conversation_id, request.conversation_id),
          eq(message_model.deleted, false)
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
          deleted: true,
          // body: null, // Clear message content
          // attachments: null // Clear attachments
          metadata: {
            ...(messages.find(m => m.id === message)?.metadata as MessageMetadata || {}),
            deleted_by: {
              user_id,
              deleted_at: new Date().toISOString()
            }
          }
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
const get_pinned_messages = async (conversation_id: number, user_id: number) => {
  try {
    // Verify user membership
    // const membership = await verify_user_membership(conversation_id, user_id);
    // if (!membership) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "You are not a member of this conversation",
    //   };
    // }

    // Get conversation metadata to find pinned message
    const [conversation] = await db
      .select({ metadata: conversation_model.metadata })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .limit(1);

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    const conversationMetadata = (conversation.metadata as ConversationMetadata) || {};

    // If no pinned message, return empty array
    if (!conversationMetadata.pinned_message) {
      return {
        success: false,
        code: 404,
        message: "No pinned messages",
      };
    }

    // Get the pinned message details
    const pinnedMessage = await db
      .select()
      .from(message_model)
      .where(
        and(
          eq(message_model.id, conversationMetadata.pinned_message.message_id),
          eq(message_model.conversation_id, conversation_id),
          eq(message_model.deleted, false)
        )
      )
      .limit(1);

    // Add pinned metadata to the message
    const result = pinnedMessage.length > 0 ? [{
      ...pinnedMessage[0],
      pinned_by: {
        user_id: conversationMetadata.pinned_message.user_id,
        pinned_at: conversationMetadata.pinned_message.pinned_at
      }
    }] : [];

    return {
      success: true,
      code: 200,
      data: result,
    };

  } catch (error) {
    console.error("get_pinned_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: get_pinned_messages",
    };
  }
};

// Get starred messages for a user
const get_starred_messages = async (user_id: number, conversation_id?: number) => {
  try {
    let whereConditions = and(
      eq(message_model.deleted, false),
      sql`${message_model.metadata}->'starred_by' @> '[{"user_id": ${user_id}}]'`
    );

    if (conversation_id) {
      whereConditions = and(
        whereConditions,
        eq(message_model.conversation_id, conversation_id)
      );
    }

    const starredMessages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        metadata: message_model.metadata,
        created_at: message_model.created_at,
        sender_name: user_model.name,
        sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(user_model, eq(user_model.id, message_model.sender_id))
      .where(whereConditions)
      .orderBy(desc(message_model.created_at));

    return {
      success: true,
      code: 200,
      data: starredMessages,
    };

  } catch (error) {
    console.error("get_starred_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: get_starred_messages",
    };
  }
};

const store_media = async (request: MediaMetadataRequest, user_id: number) => {
  try {

    const { conversation_id, category, ...rest_of_the_request } = request;

    // Map category to message type
    let messageType: string = 'media'; // default
    if (category === 'images') {
      messageType = 'image';
    } else if (category === 'videos') {
      messageType = 'video';
    } else if (category === 'audios') {
      messageType = 'audio';
    } else if (category === 'docs') {
      messageType = 'document';
    }

    const [media] = await db
      .insert(message_model)
      .values({
        conversation_id: request.conversation_id,
        sender_id: user_id,
        type: messageType as MessageType,
        attachments: rest_of_the_request || null,
      })
      .returning();

    // Update conversation's last_message_at
    await db
      .update(conversation_model)
      .set({ last_message_at: new Date() })
      .where(eq(conversation_model.id, request.conversation_id));

    return {
      success: true,
      code: 200,
      message: "Media message stored successfully",
      data: media,
    };

  } catch (error) {
    console.error("store_media error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: store_media",
    };
  }
}

const insert_message_status = async (msg_status: Pick<DBInsertMessageStatusType, "user_id" | "message_id" | "conv_id" | "delivered_at" | "read_at">) => {
  try {

    // Upsert message status
    const [inserted_status] = await db
      .insert(message_status_model)
      .values({
        user_id: msg_status.user_id,
        message_id: msg_status.message_id,
        conv_id: msg_status.conv_id,
        delivered_at: msg_status.delivered_at,
        read_at: msg_status.read_at,
        updated_at: new Date()
      }).returning()

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
}

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
        .update(message_status_model)
        .set({
          delivered_at: msg_status.delivered_at,
          updated_at: new Date()
        }).where(
          and(
            eq(message_status_model.message_id, msg_status.message_id),
            eq(message_status_model.user_id, msg_status.user_id)
          )
        ).returning())[0]
    }
    else if (!msg_status.delivered_at && msg_status.read_at) {
      updated_status = (await db
        .update(message_status_model)
        .set({
          read_at: msg_status.delivered_at,
          updated_at: new Date()
        }).where(
          and(
            eq(message_status_model.message_id, msg_status.message_id),
            eq(message_status_model.user_id, msg_status.user_id)
          )
        ).returning())[0]
    }
    else {
      // Upsert message status
      updated_status = (await db
        .update(message_status_model)
        .set({
          delivered_at: msg_status.delivered_at,
          read_at: msg_status.read_at,
          updated_at: new Date()
        }).where(
          and(
            eq(message_status_model.message_id, msg_status.message_id),
            eq(message_status_model.user_id, msg_status.user_id)
          )
        ).returning())[0]
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
}

/**
 * Batch insert message statuses for multiple messages and users
 * This is MUCH more efficient than calling insert_message_status in a loop
 * 
 * Example: For 20 messages forwarded to 30 conversations with 40 users each:
 * - Old way: 20 * 30 * 40 = 24,000 DB calls
 * - New way: 30 DB calls (one per conversation) or even 1 call if we batch everything
 * 
 * @param statuses Array of message status records to insert
 * @returns Success/failure response
 */
const batch_insert_message_status = async (
  statuses: Array<Pick<DBInsertMessageStatusType, "user_id" | "message_id" | "conv_id" | "delivered_at" | "read_at">>
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
      conv_id: status.conv_id,
      delivered_at: status.delivered_at || null,
      read_at: status.read_at || null,
      updated_at: new Date()
    }));

    // Batch insert all records in a single query
    // This is exponentially faster than individual inserts
    const inserted_statuses = await db
      .insert(message_status_model)
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
}

/**
 * Batch update message statuses for multiple messages for a single user
 * Useful for marking multiple messages as read/delivered when user opens a conversation
 * 
 * Example: User opens conversation with 50 unread messages
 * - Old way: 50 individual update queries
 * - New way: 1 batch update using SQL WHERE IN clause
 * 
 * @param user_id The user whose message statuses are being updated
 * @param conv_id The conversation ID (optional, for more specific updates)
 * @param message_ids Array of message IDs to update
 * @param status_update Object containing delivered_at and/or read_at timestamps
 * @returns Success/failure response
 */
const batch_update_message_status = async (
  user_id: number,
  message_ids: number[],
  status_update: { delivered_at?: Date; read_at?: Date },
  conv_id?: number
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
    const updateData: { delivered_at?: Date; read_at?: Date; updated_at: Date } = {
      updated_at: new Date()
    };

    if (status_update.delivered_at) {
      updateData.delivered_at = status_update.delivered_at;
    }
    if (status_update.read_at) {
      updateData.read_at = status_update.read_at;
    }

    // Build WHERE conditions
    const whereConditions = [
      eq(message_status_model.user_id, user_id),
      inArray(message_status_model.message_id, message_ids)
    ];

    // Optionally filter by conversation ID for more specific updates
    if (conv_id !== undefined) {
      whereConditions.push(eq(message_status_model.conv_id, conv_id));
    }

    // Update all message statuses in a single query
    const updated_statuses = await db
      .update(message_status_model)
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
}

export {
  store_message,
  pin_message,
  unpin_message,
  star_messages,
  reply_to_message,
  forward_messages,
  delete_messages,
  get_pinned_messages,
  get_starred_messages,
  store_media,
  insert_message_status,
  update_message_status,
  batch_insert_message_status,
  batch_update_message_status
};
