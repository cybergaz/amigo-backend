import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import { create_dm_key, create_unique_id } from "@/utils/general.utils";
import { and, eq, } from "drizzle-orm";
import { redis } from "@/config/redis";
import { broadcast_message } from "@/sockets/socket.handlers";
import { NewConversationPayload } from "@/types/socket.types";
import { socket_connections } from "@/sockets/socket.server";

const create_dm = async (sender_id: number, receiver_id: number) => {
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

    if (existingChat.length > 0) {
      return {
        success: true,
        code: 200,
        data: {
          id: existingChat[0].conversation_id,
          existing: true
        },
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

    // // -----------------------------------------------------------------------------------
    // // TEMPORARY HACK FOR THAT FIRST MESSAGE DISSAPPEAR ISSUE
    // // -----------------------------------------------------------------------------------
    // await db.insert(message_model).values({
    //   conversation_id: chat.id,
    //   sender_id: sender_id,
    //   type: "system",
    //   body: "chat initiated",
    // });
    // // await db.insert(message_model).values({
    // //   conversation_id: chat.id,
    // //   sender_id: sender_id,
    // //   type: "system",
    // //   body: "chat initiated 2",
    // // });
    // // -----------------------------------------------------------------------------------
    // // TEMPORARY HACK FOR THAT FIRST MESSAGE DISSAPPEAR ISSUE
    // // -----------------------------------------------------------------------------------

    // Send notification to receiver about new DM
    try {
      // Get sender info for notification
      const [sender] = await db
        .select({ name: user_model.name, phone: user_model.phone, profile_pic: user_model.profile_pic })
        .from(user_model)
        .where(eq(user_model.id, sender_id))
        .limit(1);

      if (sender) {
        // update redis entries
        const redis_key = `conv:${chat.id}:members`;
        const new_members_id = [receiver_id, sender_id].map(id => id.toString());
        await redis.sadd(redis_key, ...new_members_id);

        // Invalidate conversation lru cache in other services
        await redis.publish("conv:invalidate", chat.id.toString());

        // mark the creater as active in conversation in socket connection if online
        const conn = socket_connections.get(sender_id)
        if (conn && conn.ws.readyState === 1) {
          conn.active_conv_id = chat.id;
        }

        // Prepare payload and broadcast to online users about new conversation
        const new_conversation_payload: NewConversationPayload = {
          conv_id: chat.id,
          conv_type: "dm",
          creater_id: sender_id,
          creater_name: sender.name,
          creater_phone: sender.phone || "",
          creater_pfp: sender.profile_pic || undefined,
          joined_at: new Date(),
        }

        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [receiver_id],
          message: {
            type: "conversation:new",
            payload: new_conversation_payload,
            ws_timestamp: new Date()
          },
        })
      }
    } catch (error) {
      console.error('Error sending conversation_added notification for DM:', error);
      // Don't fail the request if notification fails
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

const dm_delete_status = async (conversation_id: number, user_id: number, status: boolean) => {
  try {
    const [conversation] = await db
      .update(conversation_member_model)
      .set({ deleted: status })
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
        )
      )
      .returning();

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: { conversation_id, deleted: false },
      }
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
}
