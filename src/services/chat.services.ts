import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import { create_unique_id } from "@/utils/general.utils";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

export const create_chat = async (sender_id: number, receiver_id: number) => {
  try {
    const existingChat = await db
      .select({ conversation_id: conversation_model.id })
      .from(conversation_model)
      .where(
        and(
          or(
            eq(conversation_model.creater_id, sender_id),
            eq(conversation_model.creater_id, receiver_id)
          ),
          eq(conversation_model.type, "dm")
        )
      );

    if (existingChat.length > 0) {
      // Return existing chat
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
      })
      .returning();

    // Insert both members in a single call
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
      data: chat,
    };
  } catch (error) {
    console.error("create chat error", error);
    return {
      success: false,
      code: 500,
      message: "create chat error",
    };
  }
};

export const get_chat_list = async (user_id: number) => {
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
    console.error("get_chat_list error", error);
    return {
      success: false,
      code: 500,
      message: "get_chat_list error",
    };
  }
};
