import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { message_model, message_info_model } from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { and, eq, exists, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { broadcast_message } from "@/sockets/socket.handlers";
import { NewConversationPayload } from "@/types/socket.types";
import { add_members, remove_member } from "@/cache-management/conv.cache";

const create_dm = async (sender_id: string, receiver_id: string) => {
  try {
    // Find ANY existing DM between these two users — ignoring removed_at on
    // either side. The DM model in the new "delete-for-me" world is: if a
    // chat row exists with both parties as members (even if one party has
    // removed_at set), the chat continues to exist and the deleting party
    // is "revived" on next interaction. Creating a new chat_id every time
    // someone re-DMs a person they previously deleted would orphan the
    // shared message history.
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
              )
            )
          ),
          exists(
            db.select().from(chat_member_model).where(
              and(
                eq(chat_member_model.chat_id, chat_model.id),
                eq(chat_member_model.user_id, receiver_id),
              )
            )
          )
        )
      )
      .limit(1);

    if (existingChat.length > 0) {
      const conv_id = existingChat[0].id;
      // If either side had hidden the chat (removed_at set), revive their
      // membership so message:new broadcasts include them again. dm_delete_status
      // is the single-side revive; here we cover both for completeness.
      await db
        .update(chat_member_model)
        .set({ removed_at: null })
        .where(
          and(
            eq(chat_member_model.chat_id, conv_id),
            isNotNull(chat_member_model.removed_at),
          )
        );
      // Re-hydrate the conversation member cache to include both parties so
      // the very next message:new broadcast fans out to both. add_members
      // is idempotent and also invalidates the LRU + publishes pub/sub.
      await add_members([sender_id, receiver_id], conv_id);
      return {
        success: true,
        code: 200,
        data: {
          id: conv_id,
          existing: true
        },
      };
    }

    const [chat] = await db
      .insert(chat_model)
      .values({
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
        // hydrate member set + invalidate LRU across instances
        await add_members([receiver_id, sender_id], chat.id);

        // mark the creater as active in conversation in socket connection if online
        // const conn = socket_connections.get(sender_id);
        // if (conn && conn.ws.readyState === 1) {
        //   conn.active_conv_id = chat.id;
        // }

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

    if (status) {
      // Evict the deleted user from the conversation member cache so subsequent
      // message:new broadcasts on this DM don't fan out to them. Revival on the
      // next inbound message (see handle_message_new in socket.service) will
      // re-add them before the broadcast.
      await remove_member(user_id, conversation_id);

      // Tombstone every existing message in this chat as "deleted for me" for
      // this user. After revival (peer sends a new message), get_conversation_history
      // and get_messages_around already filter out rows with message_info.deleted_at
      // IS NOT NULL for the requester — so the user can never pull pre-deletion
      // history back from the server. Single INSERT...SELECT, fast even for
      // long-running DMs. ON CONFLICT handles rows that already have a
      // message_info entry (delivery receipts, prior reactions, etc.) by
      // stamping deleted_at on them. messages.deleted_at IS NULL guard keeps
      // us from re-resurrecting globally deleted messages into the tombstone
      // set — they're already invisible to everyone.
      await db.execute(sql`
        INSERT INTO ${message_info_model} (chat_id, message_id, user_id, deleted_at)
        SELECT ${message_model.chat_id}, ${message_model.id}, ${user_id}, NOW()
        FROM ${message_model}
        WHERE ${message_model.chat_id} = ${conversation_id}
          AND ${message_model.deleted_at} IS NULL
        ON CONFLICT (message_id, user_id)
        DO UPDATE SET deleted_at = NOW()
      `);
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
