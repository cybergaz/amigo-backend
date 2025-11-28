import { WebSocketData, WSMessage } from "@/types/socket.types";
import { ElysiaWS } from "elysia/dist/ws";
import { get_conversation_members, get_user_conversations } from "./socket.cache";
import { socket_connections } from "./socket.server";
import db from "@/config/db";
import { conversation_member_model, message_model, message_status_model } from "@/models/chat.model";
import { and, desc, eq, isNull, ne, or } from "drizzle-orm";

const set_ws_data = (ws: ElysiaWS, data: WebSocketData) => {
  Object.assign(ws.data, data)
}

const get_ws_data = (ws: ElysiaWS, key: keyof WebSocketData) => {
  return (ws.data as WebSocketData)[key];
};

type BroadcastData = {
  to: "conversation" | "users",
  conv_id?: number,
  user_ids?: number[],
  message: WSMessage,
  exclude_user_ids?: number[]
}

const broadcast_message = async (data: BroadcastData) => {

  let members: number[] = [];
  if (data.to === "conversation" && data.conv_id) {
    // Get conversation members (LRU -> Redis -> DB)
    members = Array.from(await get_conversation_members(data.conv_id));
  }
  // if (!data.user_ids) data.user_ids = Array.from(members);

  // sent to both specific users and conversation members (if both conv_id & user_ids are provided)
  let recipients_list = [...members];
  if (data.user_ids) {
    recipients_list = data.user_ids;
  }

  const active_in_conv: number[] = [];
  const online_users_id: number[] = [];
  const offline_users_id: number[] = [];

  // Separate online and offline users
  recipients_list.forEach(user_id => {
    if (data.exclude_user_ids && data.exclude_user_ids.includes(user_id)) {
      return; // Skip excluded users
    }

    const connection = socket_connections.get(user_id);
    if (connection && connection.ws.readyState === 1) {
      // if (connection) {
      online_users_id.push(user_id);
    } else {
      offline_users_id.push(user_id);
    }
    if (connection && connection.active_conv_id === data.conv_id) {
      active_in_conv.push(user_id);
    }
  });

  // Send to online users
  // const messageStr = JSON.stringify(message);
  online_users_id.forEach(user_id => {
    const connection = socket_connections.get(user_id);
    if (connection) {
      try {
        // connection.ws.send(messageStr);
        connection.ws.send(data.message, true);
      } catch (error) {
        console.error(`[WS] Error sending to user ${user_id}:`, error);
        // socket_connections.delete(user_id);
      }
    }
  });

  return {
    online: online_users_id,
    offline: offline_users_id,
    active_in_conv: active_in_conv
  };
};

// Get all connected users (optimized with parallel fetching)
const get_connected_users = async (user_id: number): Promise<Set<number>> => {
  // Get user's conversations (cached)
  const conversations = await get_user_conversations(user_id);

  if (conversations.size === 0) {
    return new Set<number>();
  }

  // Fetch members from all conversations in parallel
  const memberPromises = Array.from(conversations).map(conv_id =>
    get_conversation_members(conv_id)
  );

  const all_members = await Promise.all(memberPromises);

  // Combine and deduplicate
  const connected_users = new Set<number>();
  all_members.forEach(members => {
    members.forEach(member_id => {
      if (member_id !== user_id) {
        connected_users.add(member_id);
      }
    });
  });

  return connected_users;
};

const handle_join_conversation = async ({
  conv_id,
  user_id,
  // is_active_in_conv
}: {
  conv_id: number,
  user_id: number,
  // is_active_in_conv: boolean
}) => {
  try {

    // Get the latest message in this conversation to update last_read_message_id
    const [latest_message] = await db
      .select({ id: message_model.id })
      .from(message_model)
      .where(
        and(
          eq(message_model.conversation_id, conv_id),
        )
      )
      .orderBy(desc(message_model.sent_at))
      .limit(1);

    if (latest_message) {
      // Only update last_read_message_id if user wasn't already active in this conversation
      // This prevents resetting read receipts when user comes back to the same conversation
      // if (!is_active_in_conv) {
      await db
        .update(conversation_member_model)
        .set({
          last_read_message_id: latest_message.id,
          // Clear unread count when user becomes active in conversation
          unread_count: 0
        })
        .where(
          and(
            eq(conversation_member_model.conversation_id, conv_id),
            eq(conversation_member_model.user_id, user_id)
          )
        );
      // }
    }

    // update message_status to set read_at for all messages in this conversation for this user
    await db
      .update(message_status_model)
      .set({ read_at: new Date() })
      .where(
        and(
          eq(message_status_model.conv_id, conv_id),
          eq(message_status_model.user_id, user_id),
          isNull(message_status_model.read_at),
        )
      )

    // special handling for DMs: updating message table for sent status 
    await db
      .update(message_model)
      .set({ status: "read" })
      .where(
        and(
          eq(message_model.conversation_id, conv_id),
          ne(message_model.sender_id, user_id),
          ne(message_model.status, "read"),
        )
      );

  }
  catch (error) {
    console.error("[WS] Error in handle_join_conversation:", error);
  }

}

export {
  set_ws_data,
  get_ws_data,
  broadcast_message,
  get_connected_users,
  handle_join_conversation
};
