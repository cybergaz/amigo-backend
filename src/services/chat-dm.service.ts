import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import { create_unique_id } from "@/utils/general.utils";
import { and, eq, exists, isNull } from "drizzle-orm";
import { redis } from "@/config/redis";
import { broadcast_message } from "@/sockets/socket.handlers";
import { NewConversationPayload } from "@/types/socket.types";
import { socket_connections } from "@/sockets/socket.server";

const create_dm = async (sender_id: string, receiver_id: string) => {
  try {
    // Find existing DM between these two users via EXISTS subqueries (dm_key column removed)
    const existingChat = await db
      .select({ id: chat_model.id })
      .from(chat_model)
      .where(
        and(
          eq(chat_model.type, "dm"),
          isNull(chat_model.deleted_at),
          exists(
            db.select().from(chat_member_model).where(
              and(
                eq(chat_member_model.chat_id, chat_model.id),
                eq(chat_member_model.user_id, sender_id),
                isNull(chat_member_model.removed_at)
              )
            )
          ),
          exists(
            db.select().from(chat_member_model).where(
              and(
                eq(chat_member_model.chat_id, chat_model.id),
                eq(chat_member_model.user_id, receiver_id),
                isNull(chat_member_model.removed_at)
              )
            )
          )
        )
      )
      .limit(1);

    if (existingChat.length > 0) {
      return {
        success: true,
        code: 200,
        data: {
          id: existingChat[0].id,
          existing: true
        },
      };
    }

    const [chat] = await db
      .insert(chat_model)
      .values({
        id: create_unique_id(),
        creater_id: sender_id,
        type: "dm",
      })
      .returning();

    // Insert both members
    await db.insert(chat_member_model).values([
      {
        chat_id: chat.id,
        user_id: sender_id,
      },
      {
        chat_id: chat.id,
        user_id: receiver_id,
      },
    ]);

    // Send notification to receiver about new DM
    try {
      const [sender] = await db
        .select({ name: user_model.name, phone: user_model.phone, profile_pic: user_model.profile_pic })
        .from(user_model)
        .where(eq(user_model.id, sender_id))
        .limit(1);

      if (sender) {
        // update redis entries
        const redis_key = `conv:${chat.id}:members`;
        await redis.sadd(redis_key, receiver_id, sender_id);

        // Invalidate conversation lru cache in other services
        await redis.publish("conv:invalidate", chat.id);

        // mark the creater as active in conversation in socket connection if online
        const conn = socket_connections.get(sender_id);
        if (conn && conn.ws.readyState === 1) {
          conn.active_conv_id = chat.id;
        }

        const new_conversation_payload: NewConversationPayload = {
          conv_id: chat.id,
          conv_type: "dm",
          creater_id: sender_id,
          creater_name: sender.name,
          creater_phone: sender.phone || "",
          creater_pfp: sender.profile_pic || undefined,
          joined_at: new Date(),
        };

        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [receiver_id],
          message: {
            type: "conversation:new",
            payload: new_conversation_payload,
            ws_timestamp: new Date()
          },
        });
      }
    } catch (error) {
      console.error('Error sending conversation_added notification for DM:', error);
    }

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

const dm_delete_status = async (conversation_id: string, user_id: string, status: boolean) => {
  try {
    const [conversation] = await db
      .update(chat_member_model)
      .set({ removed_at: status ? new Date() : null })
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id)
        )
      )
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
      message: `Conversation ${status ? "deleted" : "revived"} successfully`,
      data: conversation
    };

  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : dm_delete_status",
    };
  }
};

export {
  create_dm,
  dm_delete_status,
};
