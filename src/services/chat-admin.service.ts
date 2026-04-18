import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { message_model } from "@/models/message.model";
import { user_model } from "@/models/user.model";
import {
  ChatRoleType,
  ChatType,
} from "@/types/chat.types";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { add_new_member, promote_to_admin } from "./chat-group.service";
import { add_member, invalidate_conversation } from "@/cache-management/conv.cache";


const get_all_conversations_admin = async (type?: string) => {
  try {
    let whereCondition;

    if (type && type !== "all") {
      whereCondition = eq(chat_model.type, type as ChatType);
    }

    const conversations = await db
      .select({
        conversationId: chat_model.id,
        type: chat_model.type,
        title: chat_model.title,
        lastMessageAt: chat_model.last_msg_at,
        created_at: chat_model.created_at,
        createrId: chat_model.creater_id,
        deleted_at: chat_model.deleted_at,

        // Creator info
        createrName: user_model.name,
        createrProfilePic: user_model.profile_pic,
      })
      .from(chat_model)
      .leftJoin(
        user_model,
        eq(user_model.id, chat_model.creater_id)
      )
      .where(whereCondition)
      .orderBy(desc(chat_model.last_msg_at));

    // Get member counts and participant details for each conversation
    const conversationsWithMembers = await Promise.all(
      conversations.map(async (conv) => {
        const memberCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(chat_member_model)
          .where(
            and(
              eq(chat_member_model.chat_id, conv.conversationId),
              isNull(chat_member_model.removed_at)
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
            .from(chat_member_model)
            .innerJoin(
              user_model,
              eq(user_model.id, chat_member_model.user_id)
            )
            .where(
              and(
                eq(chat_member_model.chat_id, conv.conversationId),
                isNull(chat_member_model.removed_at)
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

const get_conversation_members_admin = async (conversation_id: string) => {
  try {
    const members = await db
      .select({
        userId: user_model.id,
        userName: user_model.name,
        userProfilePic: user_model.profile_pic,
        userEmail: user_model.email,
        role: chat_member_model.role,
        joinedAt: chat_member_model.joined_at,
        user_role: user_model.role
      })
      .from(chat_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, chat_member_model.user_id)
      )
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .orderBy(asc(chat_member_model.joined_at));

    // fetch the creater of the conversation
    const [conversation] = await db
      .select({
        createrId: chat_model.creater_id,
        createdAt: chat_model.created_at,
        lastActivityAt: chat_model.last_msg_at,
      })
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id))
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
  conversation_id: string,
  page: number = 1,
  limit: number = 20
) => {
  try {
    const offset = (page - 1) * limit;

    const messages = await db
      .select({
        id: message_model.id,
        chat_id: message_model.chat_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        deleted_at: message_model.deleted_at,
        replied_to: message_model.replied_to,

        // Sender information
        senderName: user_model.name,
        senderProfilePic: user_model.profile_pic,
      })
      .from(message_model)
      .leftJoin(
        user_model,
        eq(user_model.id, message_model.sender_id)
      )
      .where(eq(message_model.chat_id, conversation_id))
      .orderBy(desc(message_model.created_at))
      .limit(limit)
      .offset(offset);

    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_model)
      .where(eq(message_model.chat_id, conversation_id));

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      success: true,
      code: 200,
      data: {
        messages: messages.reverse(),
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

const force_declare_group_creater = async (conversation_id: string, member_id: string) => {
  try {
    const [conversation] = await db
      .select({
        id: chat_model.id,
        creater_id: chat_model.creater_id,
        type: chat_model.type,
      })
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id))
      .limit(1);

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: null,
      };
    }

    if (conversation.type !== "group" && conversation.type !== "community_group") {
      return {
        success: false,
        code: 400,
        message: "Can only declare creator for groups or community groups",
        data: null,
      };
    }

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
        user_id: chat_member_model.user_id,
      })
      .from(chat_member_model)
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, member_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .limit(1);

    let memberWasJustAdded = false;

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

    const [updated_conversation] = await db
      .update(chat_model)
      .set({ creater_id: member_id })
      .where(eq(chat_model.id, conversation_id))
      .returning();

    if (!updated_conversation) {
      return {
        success: false,
        code: 500,
        message: "Failed to update creator",
        data: null,
      };
    }

    const promoteResult = await promote_to_admin(conversation_id, member_id);
    if (!promoteResult.success) {
      console.error("Failed to promote creator to admin:", promoteResult.message);
    }

    if (memberWasJustAdded) {
      // hydrate member set + invalidate LRU across instances
      await add_member(member_id, conversation_id);
    } else {
      // membership unchanged but other conv state did — flush LRU only
      await invalidate_conversation(conversation_id);
    }

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
};

const hard_delete_chat = async (conversation_id: string) => {
  try {
    const [conversation] = await db
      .delete(chat_model)
      .where(eq(chat_model.id, conversation_id))
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
};
