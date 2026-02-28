import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
  message_model,
  message_status_model,
  DBUpdateConversationType,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  ChatType,
  ConversationMetadata,
} from "@/types/chat.types";
import { create_unique_id } from "@/utils/general.utils";
import { and, arrayContains, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, not, or, sql } from "drizzle-orm";
import { broadcast_message } from "@/sockets/socket.handlers";
import { ConversationActionPayload, DeleteMessagePayload, MembersType, SyncMessagesPayload } from "@/types/socket.types";
import { convertBigIntToString, convertStringToBigInt } from "@/utils/serialization.utils";
import FCMService from "./fcm.service";
import { get_conversation_members } from "./cache-management/socket.cache";

const build_conversation_action_message = (
  action: ConversationActionPayload["action"],
  members: MembersType[],
) => {
  const names = members.map((m) => m.user_name).filter(Boolean);
  const target = names.length ? names.join(", ") : "Member";

  switch (action) {
    case "member_added":
      return `${target} added`;
    case "member_removed":
      return `${target} removed`;
    case "member_promoted":
      return `${target} promoted to admin`;
    case "member_demoted":
      return `${target} demoted to member`;
    default:
      return target;
  }
};

const broadcast_conversation_action = async (data: {
  conv_id: number;
  conv_type: ChatType;
  action: ConversationActionPayload["action"];
  members: MembersType[];
  actor_id?: number;
  actor_name?: string;
  actor_pfp?: string;
}) => {
  if (!data.members.length) return;

  const action_at = new Date();
  const payload: ConversationActionPayload = {
    event_id: create_unique_id(),
    conv_id: data.conv_id,
    conv_type: data.conv_type,
    action: data.action,
    members: data.members,
    actor_id: data.actor_id,
    actor_name: data.actor_name,
    actor_pfp: data.actor_pfp,
    message: build_conversation_action_message(data.action, data.members),
    action_at,
  };

  await broadcast_message({
    to: "conversation",
    conv_id: data.conv_id,
    message: {
      type: "conversation:action",
      payload,
      ws_timestamp: action_at,
    },
  });
};


const get_chat_list = async (user_id: number, type: string) => {
  try {
    const conversationIdsRes = await db
      .select({ conversationId: conversation_member_model.conversation_id })
      .from(conversation_member_model)
      .where(eq(conversation_member_model.user_id, user_id));

    const conversationIds = conversationIdsRes.map((c) => c.conversationId);

    const chats = await db
      .select({
        conversationId: conversation_model.id,
        type: conversation_model.type,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        lastMessageAt: conversation_model.last_message_at,
        createrId: conversation_model.creater_id,

        role: conversation_member_model.role,
        unreadCount: conversation_member_model.unread_count,
        joinedAt: conversation_member_model.joined_at,

        // from user_model - for DMs, this will be the other user
        userId: user_model.id,
        userName: user_model.name,
        userPhone: user_model.phone,
        userProfilePic: user_model.profile_pic,
        onlineStatus: user_model.online_status,
        lastSeen: user_model.last_seen,
      })
      .from(conversation_member_model)
      .innerJoin(
        conversation_model,
        eq(conversation_model.id, conversation_member_model.conversation_id)
      )
      .leftJoin(
        user_model,
        and(
          eq(user_model.id, conversation_member_model.user_id),
          ne(user_model.id, user_id) // Only join with other users for DMs
        )
      )
      .where(
        and(
          inArray(conversation_model.id, conversationIds),
          eq(conversation_member_model.user_id, user_id), // Get user's own membership record
          type !== "all" ?
            type === "group"
              ? eq(conversation_model.type, "group")
              : type === "community_group"
                ? eq(conversation_model.type, "community_group")
                : type === "deleted_dm"
                  ? and(eq(conversation_model.type, "dm"), eq(conversation_member_model.deleted, true))
                  : and(eq(conversation_model.type, "dm"), eq(conversation_member_model.deleted, false))
            : eq(conversation_model.deleted, false),
          eq(conversation_model.deleted, false),
        )
      )
      .orderBy(
        desc(conversation_model.last_message_at),
        // desc(conversation_member_model.joined_at),
      );

    // For groups and community groups, we don't need the other user info
    // For DMs, we need to get the other user's info separately
    const processedChats = await Promise.all(
      chats.map(async (chat) => {
        let final_chat_item: any;
        if (chat.type === "dm" && !chat.userId) {
          // Get the other user for DM
          const [otherUser] = await db
            .select({
              userId: user_model.id,
              userName: user_model.name,
              userPhone: user_model.phone,
              userProfilePic: user_model.profile_pic,
              onlineStatus: user_model.online_status,
              lastSeen: user_model.last_seen,
            })
            .from(conversation_member_model)
            .innerJoin(user_model, eq(user_model.id, conversation_member_model.user_id))
            .where(
              and(
                eq(conversation_member_model.conversation_id, chat.conversationId),
                ne(conversation_member_model.user_id, user_id)
              )
            );

          final_chat_item = {
            ...chat,
            userId: otherUser?.userId || null,
            userName: otherUser?.userName || null,
            userPhone: otherUser?.userPhone || null,
            userProfilePic: otherUser?.userProfilePic || null,
            onlineStatus: otherUser?.onlineStatus || false,
            lastSeen: otherUser?.lastSeen || null,
          };
        }

        // For groups and community groups, clear user info since it's not relevant
        if (chat.type === "group" || chat.type === "community_group") {
          const userMemberInfo = (await db
            .select({
              role: conversation_member_model.role,
              joinedAt: conversation_member_model.joined_at,
              unreadCount: conversation_member_model.unread_count
            })
            .from(conversation_member_model)
            .where(and(
              eq(conversation_member_model.conversation_id, chat.conversationId),
              eq(conversation_member_model.user_id, user_id)
            )))[0];

          final_chat_item = {
            ...chat,
            userId: null,
            userName: null,
            userPhone: null,
            onlineStatus: false,
            lastSeen: null,
            userProfilePic: null,
            userRole: userMemberInfo?.role || null,
            userJoinedAt: userMemberInfo?.joinedAt || null,
            userUnreadCount: userMemberInfo?.unreadCount || 0,
          };
        }

        if (chat.metadata !== null) {
          const metadata = chat.metadata as any;

          // if last_message exists in metadata, extract it if pinned message available append it as well
          if (metadata.last_message != null) {
            final_chat_item = {
              ...final_chat_item,
              lastMessageId: metadata.last_message.id,
              lastMessageBody: metadata.last_message.body,
              lastMessageType: metadata.last_message.type,
            };
          }

          if (metadata.pinned_message != null) {
            final_chat_item = {
              ...final_chat_item,
              pinnedMessageId: metadata.pinned_message.message_id,
            };
          }
        }

        return final_chat_item;
      })
    );

    if (processedChats.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No chats found",
      };
    }

    return {
      success: true,
      code: 200,
      data: processedChats,
    };
  } catch (error) {
    console.error("get_chat_list error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_chat_list",
    };
  }
};


const update_conversation = async (conv_data: DBUpdateConversationType) => {
  try {
    if (!conv_data.id) {
      return {
        success: false,
        code: 400,
        message: "Conversation ID is required for update",
      };
    }

    if (conv_data.metadata) {
      // Update conversation's last_message_at and last_message in metadata
      const [conversation] = await db
        .select({ metadata: conversation_model.metadata })
        .from(conversation_model)
        .where(eq(conversation_model.id, conv_data.id))
        .limit(1);

      if (conversation) {
        // Deserialize existing metadata to merge with new metadata
        const deserializedMetadata = convertStringToBigInt(conversation.metadata);
        const currentMetadata = (deserializedMetadata as ConversationMetadata) || {};

        conv_data.metadata = {
          ...currentMetadata,
          ...conv_data.metadata
        } as ConversationMetadata;
        // Serialize metadata back to ensure BigInt values are converted to strings before saving
        const serializedMetadata = convertBigIntToString(conv_data.metadata);
        conv_data.metadata = serializedMetadata;
      }
    }

    const [updated_conversation] = await db
      .update(conversation_model)
      .set(conv_data)
      .where(eq(conversation_model.id, conv_data.id));

    return {
      success: true,
      code: 200,
      message: "Conversation updated successfully",
      data: updated_conversation,
    };


  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : update_conversation",
    };
  }
};

const soft_delete_chat = async (conversation_id: number, user_id: number) => {
  try {
    const [conversation] = await db
      .update(conversation_model)
      .set({ deleted: true })
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: { conversation_id, deleted: false },
      };
    }

    return {
      success: true,
      code: 200,
      message: "Conversation soft deleted successfully",
      data: conversation
    };

  } catch (error) {
    console.error("delete conversation error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : soft_delete_conversation",
    };
  }
};

const revive_chat = async (conversation_id: number) => {
  try {
    // Verify conversation exists
    const [conversation] = await db
      .select({
        id: conversation_model.id,
        deleted: conversation_model.deleted,
      })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id));

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: null,
      };
    }

    if (!conversation.deleted) {
      return {
        success: false,
        code: 400,
        message: "Conversation is not deleted",
        data: null,
      };
    }

    // Revive the conversation by setting deleted to false
    const result = await db
      .update(conversation_model)
      .set({ deleted: false })
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 500,
        message: "Failed to revive conversation",
        data: null,
      };
    }

    return {
      success: true,
      code: 200,
      message: "Conversation revived successfully",
      data: result[0],
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : revive_chat",
      data: null,
    };
  }
};

const soft_delete_message = async (message_ids: string[], user_id: number, is_admin_or_staff?: boolean) => {
  try {
    // console.log("soft_delete_message called with:", { message_ids, user_id, is_admin_or_staff });

    const message_id_bigint = message_ids.map(id => BigInt(id));

    // First, get the messages to retrieve conversation_id and check if they exist
    const messagesToDelete = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
      })
      .from(message_model)
      .where(and(
        inArray(message_model.id, message_id_bigint),
        eq(message_model.deleted, false),
        !is_admin_or_staff ? eq(message_model.sender_id, user_id) : undefined,
      ));

    if (messagesToDelete.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Either message not found or you do not own this message",
        data: { message_id: message_ids, deleted: false },
      };
    }

    // Get unique conversation IDs (filter out null values)
    const conversationIds = [...new Set(messagesToDelete.map(m => m.conversation_id).filter((id): id is number => id !== null))];

    // Delete the messages
    const deletedMessages = await db
      .update(message_model)
      .set({ deleted: true })
      .where(and(
        inArray(message_model.id, message_id_bigint),
        eq(message_model.deleted, false),
        !is_admin_or_staff ? eq(message_model.sender_id, user_id) : undefined,
      ))
      .returning();

    if (!deletedMessages || deletedMessages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Either message not found or you do not own this message",
        data: { message_id: message_ids, deleted: false },
      };
    }

    // Broadcast delete event to each conversation
    for (const conversationId of conversationIds) {
      const messagesInConversation = messagesToDelete.filter(m => m.conversation_id === conversationId);

      // Broadcast delete event
      const message_payload: DeleteMessagePayload = {
        sender_id: user_id,
        conv_id: conversationId,
        message_ids: messagesInConversation.map(m => m.id),
      };
      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "conversation",
        conv_id: conversationId,
        message: {
          type: "message:delete",
          payload: message_payload,
          ws_timestamp: new Date()
        },
        exclude_user_ids: [user_id]
      });

      const members = await get_conversation_members(conversationId);
      await FCMService.send_notification({
        type: "ws-message",
        fcm_mode: "data-only",
        user_ids: Array.from(members),
        ws_message: {
          type: "message:delete",
          payload: convertBigIntToString(message_payload),
          ws_timestamp: new Date()
        }
      });

      // Check if any deleted message was the last_message and update if needed
      const [conversation] = await db
        .select()
        .from(conversation_model)
        .where(eq(conversation_model.id, conversationId))
        .limit(1);

      if (conversation && conversation.metadata) {
        const metadata = conversation.metadata as any;
        const lastMessage = metadata.last_message;

        // Check if the deleted message was the last_message
        if (lastMessage && messagesInConversation.some(m => m.id === lastMessage.id)) {
          // Get the new last message (non-deleted)
          const [newLastMessage] = await db
            .select()
            .from(message_model)
            .where(
              and(
                eq(message_model.conversation_id, conversationId),
                eq(message_model.deleted, false)
              )
            )
            .orderBy(desc(message_model.created_at))
            .limit(1);

          // Update conversation metadata with new last_message or null if no messages left
          await db
            .update(conversation_model)
            .set({
              metadata: convertBigIntToString(newLastMessage ? {
                last_message: {
                  id: newLastMessage.id,
                  conversation_id: newLastMessage.conversation_id,
                  sender_id: newLastMessage.sender_id,
                  type: newLastMessage.type,
                  body: newLastMessage.body,
                  attachments: newLastMessage.attachments,
                  metadata: newLastMessage.metadata,
                  created_at: newLastMessage.created_at.toISOString(),
                }
              } : { last_message: null }),
              last_message_at: newLastMessage ? newLastMessage.created_at : conversation.last_message_at
            })
            .where(eq(conversation_model.id, conversationId));
        }
      }
    }

    return {
      success: true,
      code: 200,
      message: "Messages marked as deleted successfully",
      data: deletedMessages
    };

  } catch (error) {
    console.error("delete Message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : mark_as_delete_message",
    };
  }
};

const delete_message_for_me = async (
  message_ids: bigint[],
  user_id: number,
  conversation_id: number
) => {
  try {
    // const message_ids_bigint = message_ids.map(id => BigInt(id));
    // Verify user is a member of the conversation
    const membership = await db
      .select()
      .from(conversation_member_model)
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id),
          eq(conversation_member_model.deleted, false)
        )
      )
      .limit(1);

    if (membership.length === 0) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Verify messages exist and belong to this conversation
    const messages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
      })
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, message_ids),
          eq(message_model.conversation_id, conversation_id)
        )
      );

    if (messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Messages not found",
      };
    }

    // Update or insert message_status with deleted_at timestamp
    // First, try to update existing records
    const updatedStatuses = await db
      .update(message_status_model)
      .set({
        deleted_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          inArray(message_status_model.message_id, message_ids),
          eq(message_status_model.user_id, user_id),
          eq(message_status_model.conv_id, conversation_id)
        )
      )
      .returning();

    // For messages without existing status records, insert new ones
    const existingMessageIds = updatedStatuses.map(s => s.message_id);
    const messagesToInsert = messages.filter(
      m => !existingMessageIds.includes(m.id)
    );

    if (messagesToInsert.length > 0) {
      await db
        .insert(message_status_model)
        .values(
          messagesToInsert.map(msg => ({
            message_id: msg.id,
            user_id: user_id,
            conv_id: conversation_id,
            deleted_at: new Date(),
          }))
        )
        .onConflictDoUpdate({
          target: [
            message_status_model.message_id,
            message_status_model.user_id
          ],
          set: {
            deleted_at: new Date(),
            updated_at: new Date(),
          }
        });
    }

    return {
      success: true,
      code: 200,
      message: "Messages deleted for you",
      data: { deleted_count: messages.length }
    };

  } catch (error) {
    console.error("delete_message_for_me error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: delete_message_for_me",
    };
  }
};

const hard_delete_message = async (message_id: bigint) => {
  try {
    // Check if user is super admin (this should be verified at route level)
    const result = await db
      .delete(message_model)
      .where(eq(message_model.id, BigInt(message_id)))
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message permanently deleted",
      data: result[0],
    };
  } catch (error) {
    console.error("permanently_delete_message_admin error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : permanently_delete_message_admin",
    };
  }
};

const get_conversation_history = async (
  conversation_id: number,
  user_id: number,
  page: number = 1,
  limit: number = 100
) => {
  try {
    // First, verify user is a member of this conversation
    const members = await db
      .select({
        user_id: conversation_member_model.user_id,
        name: user_model.name,
        phone: user_model.phone,
        user_role: user_model.role,
        group_role: conversation_member_model.role,
        profile_pic: user_model.profile_pic,
        joining_date: conversation_member_model.joined_at,
        last_read_message_id: conversation_member_model.last_read_message_id,
        lasthistory_delivered_message_id: conversation_member_model.last_delivered_message_id,
        is_online: user_model.online_status,
        connection_status: user_model.connection_status,
      })
      .from(conversation_member_model)
      .leftJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.deleted, false)
        )
      );

    if (members.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    if (!members.find(m => m.user_id === user_id)) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    const user_details = members.find(m => m.user_id === user_id);
    if (!user_details) {
      return {
        success: false,
        code: 404,
        message: "User not found",
      };
    }
    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Get message IDs deleted by this user (delete for me)
    const userDeletedMessages = await db
      .select({ message_id: message_status_model.message_id })
      .from(message_status_model)
      .where(
        and(
          eq(message_status_model.user_id, user_id),
          eq(message_status_model.conv_id, conversation_id),
          isNotNull(message_status_model.deleted_at)
        )
      );

    const deletedMessageIds = userDeletedMessages.map(d => d.message_id);

    // Get messages with sender information, excluding messages deleted for this user
    const messages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        metadata: message_model.metadata,
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        status: message_model.status,
        deleted: message_model.deleted,
        forwarded_from: message_model.forwarded_from,
        forwarded_count: message_model.forwarded_to,

        // Sender information
        sender_name: user_model.name,
        sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(
        user_model,
        eq(user_model.id, message_model.sender_id)
      )
      .where(
        and(
          or(
            eq(message_model.conversation_id, conversation_id),
            arrayContains(message_model.forwarded_to, [conversation_id]),
          ),
          // Exclude messages deleted for everyone
          eq(message_model.deleted, false),
          // Exclude messages deleted for this specific user (delete for me)
          deletedMessageIds.length > 0
            ? not(inArray(message_model.id, deletedMessageIds))
            : undefined,
          user_details.joining_date ? gt(message_model.created_at, user_details.joining_date) : undefined
        )
      )
      .orderBy(desc(message_model.created_at))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination info (excluding messages deleted for this user)
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_model)
      .where(
        and(
          eq(message_model.conversation_id, conversation_id),
          eq(message_model.deleted, false),
          deletedMessageIds.length > 0
            ? not(inArray(message_model.id, deletedMessageIds))
            : undefined
        )
      );

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    // convert bigint to string for network transfer
    // messages.forEach((msg) => {
    //   msg.id = msg.id.toString();
    //   if (msg.forwarded_from) {
    //     msg.forwarded_from = msg.forwarded_from.map((id: bigint) => id.toString());
    //   }
    // }

    return {
      success: true,
      code: 200,
      data: {
        messages: messages.reverse(), // Reverse to show oldest first
        members,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          limit,
          hasNextPage,
          hasPreviousPage,
        },
      },
    };

  } catch (error) {
    console.error("get_conversation_history error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_history",
    };
  }
};

const get_message_statuses = async (
  conversation_id: number,
  user_id: number,
  page: number = 1,
  limit: number = 1000
) => {
  try {
    // First, verify user is a member of this conversation
    const [member] = await db
      .select({
        user_id: conversation_member_model.user_id,
      })
      .from(conversation_member_model)
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id),
          eq(conversation_member_model.deleted, false)
        )
      )
      .limit(1);

    if (!member) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Get all message statuses for this conversation
    // This includes statuses for all users in the conversation
    const statuses = await db
      .select()
      .from(message_status_model)
      .where(
        and(
          eq(message_status_model.conv_id, conversation_id)
        )
      )
      .orderBy(desc(message_status_model.updated_at))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination info
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_status_model)
      .where(eq(message_status_model.conv_id, conversation_id));

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      success: true,
      code: 200,
      data: {
        statuses,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          limit,
          hasNextPage,
          hasPreviousPage,
        },
      },
    };

  } catch (error) {
    console.error("get_message_statuses error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_message_statuses",
    };
  }
};

// Helper function to get conversation details for a specific user
// Returns data in the same format as get_chat_list for consistency
const getConversationDetailsForUser = async (conversation_id: number, user_id: number) => {
  try {
    const [chat] = await db
      .select({
        conversationId: conversation_model.id,
        type: conversation_model.type,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        lastMessageAt: conversation_model.last_message_at,
        role: conversation_member_model.role,
        unreadCount: conversation_member_model.unread_count,
        joinedAt: conversation_member_model.joined_at,
        userId: user_model.id,
        userName: user_model.name,
        userPhone: user_model.phone,
        onlineStatus: user_model.online_status,
        lastSeen: user_model.last_seen,
        userProfilePic: user_model.profile_pic,
      })
      .from(conversation_member_model)
      .innerJoin(
        conversation_model,
        eq(conversation_model.id, conversation_member_model.conversation_id)
      )
      .leftJoin(
        user_model,
        and(
          eq(user_model.id, conversation_member_model.user_id),
          ne(user_model.id, user_id)
        )
      )
      .where(
        and(
          eq(conversation_model.id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
        )
      )
      .limit(1);

    if (!chat) return null;

    // For DMs, get the other user's info

    let final_chat_item: any;

    if (chat.type === "dm" && !chat.userId) {
      const [otherUser] = await db
        .select({
          userId: user_model.id,
          userName: user_model.name,
          userPhone: user_model.phone,
          onlineStatus: user_model.online_status,
          lastSeen: user_model.last_seen,
          userProfilePic: user_model.profile_pic,
        })
        .from(conversation_member_model)
        .innerJoin(user_model, eq(user_model.id, conversation_member_model.user_id))
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            ne(conversation_member_model.user_id, user_id)
          )
        )
        .limit(1);

      final_chat_item = {
        ...chat,
        userId: otherUser?.userId || null,
        userName: otherUser?.userName || null,
        userPhone: otherUser?.userPhone || null,
        onlineStatus: otherUser?.onlineStatus || "offline",
        lastSeen: otherUser?.lastSeen || null,
        userProfilePic: otherUser?.userProfilePic || null,
      };
    }

    // For groups, clear user info
    if (chat.type === "group" || chat.type === "community_group") {
      // Also get group members for groups
      const members = await db
        .select({
          userId: user_model.id,
          userName: user_model.name,
          userPhone: user_model.phone,
          userProfilePic: user_model.profile_pic,
          role: conversation_member_model.role,
          joinedAt: conversation_member_model.joined_at,
        })
        .from(conversation_member_model)
        .innerJoin(user_model, eq(user_model.id, conversation_member_model.user_id))
        .where(eq(conversation_member_model.conversation_id, conversation_id))
        .orderBy(asc(conversation_member_model.joined_at));

      final_chat_item = {
        ...chat,
        userId: null,
        userName: null,
        userPhone: null,
        onlineStatus: "offline",
        lastSeen: null,
        userProfilePic: null,
        members: members.map(m => ({
          userId: m.userId,
          name: m.userName,
          profilePic: m.userProfilePic,
          role: m.role,
          joinedAt: m.joinedAt,
        })),
      };
    }

    if (chat.metadata !== null) {
      const metadata = chat.metadata as any;

      // if last_message exists in metadata, extract it if pinned message available append it as well
      if (metadata.last_message != null) {
        final_chat_item = {
          ...final_chat_item,
          lastMessageId: metadata.last_message.id,
          lastMessageBody: metadata.last_message.body,
          lastMessageType: metadata.last_message.type,
        };
      }

      if (metadata.pinned_message != null) {
        final_chat_item = {
          ...final_chat_item,
          pinnedMessageId: metadata.pinned_message.message_id,
        };
      }
    }

    return final_chat_item;
  } catch (error) {
    console.error('Error getting conversation details:', error);
    return null;
  }
};

// Fetch and send all undelivered messages to a user on reconnection.
// async function sync_missed_messages(user_id: number) {
//   try {
//     // Get all conversations the user is a member of
//     const userConversations = await db
//       .select({
//         conv_id: conversation_member_model.conversation_id,
//         conv_type: conversation_model.type,
//       })
//       .from(conversation_member_model)
//       .innerJoin(
//         conversation_model,
//         eq(conversation_model.id, conversation_member_model.conversation_id)
//       )
//       .where(
//         and(
//           eq(conversation_member_model.user_id, user_id),
//           eq(conversation_member_model.deleted, false)
//         )
//       );
//
//     if (userConversations.length === 0) {
//       console.log(`[SYNC] No conversations found for user ${user_id}`);
//       return {
//         success: true,
//         code: 200,
//         message: "No conversations found, no messages to sync",
//         data: null,
//       }
//     }
//
//     const conversationIds = userConversations.map(c => c.conv_id);
//     const convTypeMap = new Map(userConversations.map(c => [c.conv_id, c.conv_type]));
//
//     // Find all messages in user's conversations that haven't been delivered to this user
//     // These are messages where message_status.delivered_at is NULL for this user
//     const undeliveredStatuses = await db
//       .select({
//         message_id: message_status_model.message_id,
//         conv_id: message_status_model.conv_id,
//       })
//       .from(message_status_model)
//       .where(
//         and(
//           eq(message_status_model.user_id, user_id),
//           inArray(message_status_model.conv_id, conversationIds),
//           isNull(message_status_model.delivered_at)
//         )
//       )
//       .limit(500); // Limit to prevent overwhelming the client
//
//     console.log("undeliveredStatuses -> ", undeliveredStatuses)
//     if (undeliveredStatuses.length === 0) {
//       console.log(`[SYNC] No missed messages for user ${user_id}`);
//       return {
//         success: true,
//         code: 200,
//         message: "No missed messages to sync",
//         data: null,
//       }
//     }
//
//     const messageIds = undeliveredStatuses.map(s => s.message_id);
//
//     // Fetch the actual message data
//     const missedMessages = await db
//       .select({
//         id: message_model.id,
//         conversation_id: message_model.conversation_id,
//         sender_id: message_model.sender_id,
//         type: message_model.type,
//         body: message_model.body,
//         attachments: message_model.attachments,
//         metadata: message_model.metadata,
//         sent_at: message_model.sent_at,
//         created_at: message_model.created_at,
//         status: message_model.status,
//         deleted: message_model.deleted,
//         forwarded_from: message_model.forwarded_from,
//         forwarded_count: message_model.forwarded_to,
//
//         // Sender information
//         sender_name: user_model.name,
//         sender_pfp: user_model.profile_pic,
//       })
//       .from(message_model)
//       .innerJoin(user_model, eq(user_model.id, message_model.sender_id))
//       .where(
//         and(
//           inArray(message_model.id, messageIds),
//           eq(message_model.deleted, false)
//         )
//       )
//       .orderBy(desc(message_model.sent_at));
//
//     if (missedMessages.length === 0) {
//       console.log(`[SYNC] No valid missed messages for user ${user_id}`);
//       return {
//         success: true,
//         code: 200,
//         message: "No valid missed messages to sync",
//         data: null,
//       }
//     }
//
//     // Transform to SyncMessageItem format
//     const syncMessages: ChatMessagePayload[] = missedMessages.map(msg => ({
//       id: msg.id,
//       sender_id: msg.sender_id,
//       sender_name: msg.sender_name || undefined,
//       conv_id: msg.conversation_id!,
//       conv_type: (convTypeMap.get(msg.conversation_id!) || 'dm') as any,
//       msg_type: msg.type as any,
//       body: msg.body || undefined,
//       attachments: msg.attachments,
//       metadata: msg.metadata,
//       sender_pfp: msg.sender_pfp || undefined,
//       sent_at: msg.sent_at || new Date(),
//       created_at: msg.created_at,
//     }));
//
//     // Send sync message to user
//     const syncPayload: SyncMessagesPayload = {
//       messages: syncMessages.reverse(), // Send oldest first
//       sync_timestamp: new Date(),
//       total_count: syncMessages.length,
//     };
//
//     // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
//     const sent_status = await broadcast_message({
//       to: "users",
//       user_ids: [user_id],
//       message: {
//         type: 'message:sync',
//         payload: syncPayload,
//         ws_timestamp: new Date(),
//       },
//     });
//
//     console.log("broadcast_message status-> ", sent_status)
//     // Mark these messages as delivered
//     await db
//       .update(message_status_model)
//       .set({ delivered_at: new Date() })
//       .where(
//         and(
//           eq(message_status_model.user_id, user_id),
//           inArray(message_status_model.message_id, messageIds)
//         )
//       );
//
//     console.log(`[SYNC] Synced ${syncMessages.length} missed messages to user ${user_id}`);
//     return {
//       success: true,
//       code: 200,
//       message: `Synced ${syncMessages.length} missed messages`,
//       data: syncMessages.reverse(), // Send oldest first
//     }
//
//   } catch (error) {
//     console.error(`[SYNC] Error syncing missed messages for user ${user_id}:`, error);
//     return {
//       success: false,
//       code: 500,
//       message: "ERROR: sync_missed_messages",
//     };
//   }
// }

export {
  get_chat_list,
  update_conversation,
  soft_delete_chat,
  revive_chat,
  soft_delete_message,
  delete_message_for_me,
  hard_delete_message,
  get_conversation_history,
  get_message_statuses,
  getConversationDetailsForUser,
  broadcast_conversation_action,
  // sync_missed_messages
};
