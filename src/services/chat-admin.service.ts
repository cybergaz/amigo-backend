import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
  message_model,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  ChatRoleType,
  ChatType,
} from "@/types/chat.types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { redis } from "@/config/redis";
import { add_new_member, promote_to_admin } from "./chat-group.service";


const get_all_conversations_admin = async (type?: string) => {
  try {
    let whereCondition

    if (type && type !== "all") {
      whereCondition = and(
        // eq(conversation_model.deleted, false),
        eq(conversation_model.type, type as ChatType)
      )!;
    }

    const conversations = await db
      .select({
        conversationId: conversation_model.id,
        type: conversation_model.type,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        lastMessageAt: conversation_model.last_message_at,
        created_at: conversation_model.created_at,
        createrId: conversation_model.creater_id,
        deleted: conversation_model.deleted,

        // Creator info
        createrName: user_model.name,
        createrProfilePic: user_model.profile_pic,
      })
      .from(conversation_model)
      .leftJoin(
        user_model,
        eq(user_model.id, conversation_model.creater_id)
      )
      .where(whereCondition)
      .orderBy(desc(conversation_model.last_message_at));

    // Get member counts and participant details for each conversation
    const conversationsWithMembers = await Promise.all(
      conversations.map(async (conv) => {
        const memberCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(conversation_member_model)
          .where(
            and(
              eq(conversation_member_model.conversation_id, conv.conversationId),
              eq(conversation_member_model.deleted, false)
            )
          );

        // For DM conversations, get both participants
        if (conv.type === "dm") {
          const participants = await db
            .select({
              userId: user_model.id,
              userName: user_model.name,
              userProfilePic: user_model.profile_pic,
              userEmail: user_model.email,
            })
            .from(conversation_member_model)
            .innerJoin(
              user_model,
              eq(user_model.id, conversation_member_model.user_id)
            )
            .where(
              and(
                eq(conversation_member_model.conversation_id, conv.conversationId),
                eq(conversation_member_model.deleted, false)
              )
            )
            .limit(2);

          // Determine participant1 (creator) and participant2 (other user)
          const participant1 = participants.find(p => p.userId === conv.createrId) || participants[0];
          const participant2 = participants.find(p => p.userId !== conv.createrId) || participants[1];

          return {
            ...conv,
            memberCount: memberCount[0]?.count || 0,
            participant1: participant1 ? {
              userId: participant1.userId,
              userName: participant1.userName,
              userProfilePic: participant1.userProfilePic,
              userEmail: participant1.userEmail,
            } : null,
            participant2: participant2 ? {
              userId: participant2.userId,
              userName: participant2.userName,
              userProfilePic: participant2.userProfilePic,
              userEmail: participant2.userEmail,
            } : null,
          };
        }

        return {
          ...conv,
          memberCount: memberCount[0]?.count || 0
        };
      })
    );

    return {
      success: true,
      code: 200,
      data: conversationsWithMembers,
    };
  } catch (error) {
    console.error("get_all_conversations_admin error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_all_conversations_admin",
    };
  }
};

const get_conversation_members_admin = async (conversation_id: number) => {
  try {
    const members = await db
      .select({
        userId: user_model.id,
        userName: user_model.name,
        userProfilePic: user_model.profile_pic,
        userEmail: user_model.email,
        role: conversation_member_model.role,
        joinedAt: conversation_member_model.joined_at,
        unreadCount: conversation_member_model.unread_count,
        user_role: user_model.role
      })
      .from(conversation_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.deleted, false)
        )
      )
      .orderBy(asc(conversation_member_model.joined_at));

    // fetch the creater of the conversation and append createrName and createrId in the returned data
    const [conversation] = await db
      .select({
        createrId: conversation_model.creater_id,
        createdAt: conversation_model.created_at,
        lastActivityAt: conversation_model.last_message_at,
      })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .limit(1);

    if (!conversation || !conversation.createrId) {
      return {
        success: false,
        code: 404,
        message: "can't fetch creater info for the conversation id: " + conversation_id,
      };
    }

    const [creater] = await db
      .select({
        createrName: user_model.name,
        createrProfilePic: user_model.profile_pic,
      })
      .from(user_model)
      .where(eq(user_model.id, conversation.createrId))
      .limit(1);

    return {
      success: true,
      code: 200,
      data: {
        members: members,
        createrId: conversation.createrId,
        createrName: creater.createrName,
        createrProfilePic: creater.createrProfilePic,
        createdAt: conversation.createdAt,
        lastMessageAt: conversation.lastActivityAt,
      },
    };
  } catch (error) {
    console.error("get_conversation_members_admin error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_members_admin",
    };
  }
};

const get_conversation_history_admin = async (
  conversation_id: number,
  page: number = 1,
  limit: number = 20
) => {
  try {
    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Get messages with sender information
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
        deleted: message_model.deleted,
        forwarded_from: message_model.forwarded_from,
        forwarded_count: message_model.forwarded_to,

        // Sender information
        senderName: user_model.name,
        senderProfilePic: user_model.profile_pic,
      })
      .from(message_model)
      .leftJoin(
        user_model,
        eq(user_model.id, message_model.sender_id)
      )
      .where(eq(message_model.conversation_id, conversation_id))
      .orderBy(desc(message_model.created_at))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination info
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_model)
      .where(eq(message_model.conversation_id, conversation_id));

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      success: true,
      code: 200,
      data: {
        messages: messages.reverse(), // Reverse to show oldest first
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
    console.error("get_conversation_history_admin error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_history_admin",
    };
  }
};

const force_declare_group_creater = async (conversation_id: number, member_id: number) => {
  try {
    // Check if conversation exists
    const [conversation] = await db
      .select({
        id: conversation_model.id,
        creater_id: conversation_model.creater_id,
        type: conversation_model.type,
      })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .limit(1);

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: null,
      };
    }

    // Only allow for groups and community groups
    if (conversation.type !== "group" && conversation.type !== "community_group") {
      return {
        success: false,
        code: 400,
        message: "Can only declare creator for groups or community groups",
        data: null,
      };
    }

    // Check if member is already the creator
    if (conversation.creater_id === member_id) {
      return {
        success: true,
        code: 200,
        message: "Member is already the creator",
        data: {
          conversation_id,
          creater_id: member_id,
          previous_creater_id: conversation.creater_id,
        },
      };
    }

    // Verify that the member is part of the conversation
    const [member] = await db
      .select({
        user_id: conversation_member_model.user_id,
      })
      .from(conversation_member_model)
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, member_id),
          eq(conversation_member_model.deleted, false)
        )
      )
      .limit(1);

    // Track if member was just added
    let memberWasJustAdded = false;

    // If the member is not part of the conversation, add them
    if (!member) {
      const addResult = await add_new_member(
        conversation_id,
        [member_id],
        "admin" as ChatRoleType
      );

      if (!addResult.success) {
        return {
          success: false,
          code: addResult.code || 500,
          message: `Failed to add member to conversation: ${addResult.message}`,
          data: null,
        };
      }

      memberWasJustAdded = true;
    }

    // Update the creator (replace if exists, or just set if not)
    const [updated_conversation] = await db
      .update(conversation_model)
      .set({ creater_id: member_id })
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (!updated_conversation) {
      return {
        success: false,
        code: 500,
        message: "Failed to update creator",
        data: null,
      };
    }

    // Call promote_to_admin to make sure the new creator is admin
    const promoteResult = await promote_to_admin(conversation_id, member_id);
    if (!promoteResult.success) {
      // Log the error but don't fail the entire operation
      console.error("Failed to promote creator to admin:", promoteResult.message);
    }

    // Update redis entries if the provided member was not present in the conversation and just got added now
    if (memberWasJustAdded) {
      const redis_key = `conv:${conversation_id}:members`;
      await redis.sadd(redis_key, member_id.toString());
    }

    // Invalidate conversation cache
    await redis.publish("conv:invalidate", conversation_id.toString());

    return {
      success: true,
      code: 200,
      message: "Group creator declared successfully",
      data: {
        conversation_id,
        creater_id: member_id,
        previous_creater_id: conversation.creater_id,
      },
    };
  } catch (error) {
    console.error("declare_group_creater error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : declare_group_creater",
      data: null,
    };
  }
}

const hard_delete_chat = async (conversation_id: number) => {
  try {
    const [conversation] = await db
      .delete(conversation_model)
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
      message: "Conversation deleted successfully",
      data: conversation
    };

  } catch (error) {
    console.error("delete conversation error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : hard_delete_conversation",
    };
  }
};

export {
  get_all_conversations_admin,
  get_conversation_members_admin,
  get_conversation_history_admin,
  force_declare_group_creater,
  hard_delete_chat
}
