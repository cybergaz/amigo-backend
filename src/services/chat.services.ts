import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
  message_model,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import { 
  ChatRoleType, 
} from "@/types/chat.types";
import { create_dm_key, create_unique_id } from "@/utils/general.utils";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

const create_chat = async (sender_id: number, receiver_id: number) => {
  try {
    const dm_key = create_dm_key(sender_id, receiver_id)

    const existingChat = await db
      .select({ conversation_id: conversation_model.id })
      .from(conversation_model)
      .where(
        and(
          eq(conversation_model.type, "dm"),
          eq(conversation_model.dm_key, dm_key)
        )
      );

    // const existingChat = await db
    //   .select({ conversation_id: conversation_member_model.conversation_id })
    //   .from(conversation_member_model)
    //   .leftJoin(
    //     conversation_model,
    //     eq(conversation_member_model.conversation_id, conversation_model.id)
    //   )
    //   .where(
    //     and(
    //       eq(conversation_model.type, "dm"),
    //       inArray(conversation_member_model.user_id, [sender_id, receiver_id])
    //     )
    //   )
    //   .groupBy(conversation_member_model.conversation_id)
    //   .having(sql`count(distinct ${conversation_member_model.user_id}) = 2`);

    // console.log("existingChat ->", existingChat)

    if (existingChat.length > 0) {
      return {
        success: true,
        code: 200,
        data: { id: existingChat[0].conversation_id, existing: true },
      };
    }

    const [chat] = await db
      .insert(conversation_model)
      .values({
        id: create_unique_id(),
        creater_id: sender_id,
        type: "dm",
        dm_key: dm_key,
      })
      .returning();

    // Insert both members in conversation_member_model
    await db.insert(conversation_member_model).values([
      {
        conversation_id: chat.id,
        user_id: sender_id,
      },
      {
        conversation_id: chat.id,
        user_id: receiver_id,
      },
    ]);

    return {
      success: true,
      code: 200,
      message: "DM Chat created successfully",
      data: chat,
    };

  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : create_chat",
    };
  }
};

const get_chat_list = async (user_id: number) => {
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

        role: conversation_member_model.role,
        unreadCount: conversation_member_model.unread_count,
        joinedAt: conversation_member_model.joined_at,

        // from user_model
        userId: user_model.id,
        userName: user_model.name,
        lastSeen: user_model.last_seen,
        userProfilePic: user_model.profile_pic,
      })
      .from(conversation_member_model)
      .innerJoin(
        conversation_model,
        eq(conversation_model.id, conversation_member_model.conversation_id)
      )
      .innerJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(
        and(
          inArray(conversation_model.id, conversationIds),
          ne(user_model.id, user_id)
        )
      )
      .orderBy(desc(conversation_model.last_message_at));

    if (chats.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No chats found",
      };
    }

    return {
      success: true,
      code: 200,
      data: chats,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : get_chat_list",
    };
  }
};

const create_group = async (
  creater_id: number,
  title: string,
  member_ids?: number[]
) => {
  try {
    const [chat] = await db
      .insert(conversation_model)
      .values({
        id: create_unique_id(),
        creater_id,
        type: "group",
        title,
      })
      .returning();

    // Ensure creator is always in the group
    const uniqueMemberIds = Array.from(new Set([creater_id, ...member_ids || []]));

    await db.insert(conversation_member_model).values(
      uniqueMemberIds.map((uid) => ({
        conversation_id: chat.id,
        user_id: uid,
        role: (uid === creater_id ? "admin" : "member") as ChatRoleType, // creator is admin
      }))
    );

    return {
      success: true,
      code: 200,
      message: "Group created successfully",
      data: chat,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : create_group",
    };
  }
};


const add_new_member = async (
  conversation_id: number,
  user_id: number,
  role: ChatRoleType = "member"
) => {
  try {
    const [member] = await db
      .insert(conversation_member_model)
      .values({
        conversation_id,
        user_id,
        role,
      })
      .onConflictDoNothing({ target: [conversation_member_model.conversation_id, conversation_member_model.user_id] })
      .returning();

    if (!member) {
      return {
        success: true,
        code: 200,
        message: "Member already exists in the conversation",
        data: { conversation_id, user_id, existing: true },
      };
    }

    return {
      success: true,
      code: 200,
      message: "Member added successfully",
      data: member
    };

  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : add_new_member",
    };
  }
};

const remove_member = async (
  conversation_id: number,
  user_id: number
) => {
  try {
    const result = await db
      .delete(conversation_member_model)
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
        )
      )
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Member not found in the conversation",
        data: { conversation_id, user_id, removed: false },
      };
    }

    return {
      success: true,
      code: 200,
      message: "Member removed successfully",
      data: result[0]
    };

  } catch (error) {
    console.error("remove member error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : remove_member",
    };
  }
};

const update_group_title = async (
  conversation_id: number,
  title: string
) => {
  try {
    const [chat] = await db
      .update(conversation_model)
      .set({ title })
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (!chat) {
      return {
        success: false,
        code: 404,
        message: "Group not found",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Group title updated successfully",
      data: chat,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : update_group_title",
    };
  }
}

const delete_conversation = async (conversation_id: number) => {
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
      message: "Conversation deleted successfully",
      data: conversation
    };

  } catch (error) {
    console.error("delete conversation error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : delete_conversation",
    };
  }
};

const get_conversation_history = async (
  conversation_id: number,
  user_id: number,
  page: number = 1,
  limit: number = 20
) => {
  try {
    // First, verify user is a member of this conversation
    const membership = await db
      .select({ id: conversation_member_model.id })
      .from(conversation_member_model)
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
        )
      );

    if (membership.length === 0) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

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
        edited_at: message_model.edited_at,
        created_at: message_model.created_at,
        deleted: message_model.deleted,

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
          eq(message_model.conversation_id, conversation_id),
          eq(message_model.deleted, false)
        )
      )
      .orderBy(desc(message_model.created_at))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination info
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_model)
      .where(
        and(
          eq(message_model.conversation_id, conversation_id),
          eq(message_model.deleted, false)
        )
      );

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
    console.error("get_conversation_history error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_history",
    };
  }
};

export { create_chat, get_chat_list, create_group, add_new_member, remove_member, update_group_title, delete_conversation, get_conversation_history };
