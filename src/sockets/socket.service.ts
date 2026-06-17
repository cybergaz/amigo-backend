import { ResultType } from "@/types/core.types";
import { CallPayload, ChatMessagePayload, ConnectionStatusPayload, MessageForwardPayload, NewConversationPayload, WSMessageEventsType, WSMessage, ConvJoinPayload, MessageSentAckPayload, MessageStatusAckPayload, } from "@/types/socket.types";
import { broadcast_message, is_user_online, } from "./socket.handlers";
// import { update_user_connection_status } from "@/services/user.services";
import { socket_connections } from "./socket.server";
import { forward_messages, store_message_with_retry } from "@/services/message.services";
import { batch_insert_message_status, mark_read_upto } from "@/services/message-status.service";
import { add_members, get_conversation_members, is_member } from "@/cache-management/conv.cache";
import { update_chat_meta, batch_increment_unread, reset_unread } from "@/cache-management/chat-meta.cache";
import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { message_model } from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { update_conversation } from "@/services/chat.services";
import FCMService from "@/services/fcm.service";
import { queue_message_fcm } from "@/services/fcm-batch.service";
import { get_muted_user_ids } from "@/cache-management/chat-mute.cache";
import { ChatType } from "@/types/chat.types";
import type { CallEndReasonsType } from "@/types/call.types";
import { CALL_TIMEOUT_MS, CallService, active_calls, register_missed_call_notifier } from "@/services/call.service";
import StreamCallService from "@/services/stream-call.service";
import { call_model } from "@/models/call.model";
import { get_user_peers } from "@/cache-management/user-peer.cache";
import { set_last_read, get_receipt } from "@/cache-management/chat-member.cache";
import { batch_mark_status } from "@/cache-management/message.cache";

const handle_connection_status = async (payload: ConnectionStatusPayload): Promise<ResultType> => {
  try {
    // Record the reported foreground/background state on the live connection so
    // broadcast_message can route a backgrounded-but-WS-connected user to BOTH
    // the WS frame and FCM. The flag only matters while a WS exists; if the
    // socket has already gone there is nothing to flag (the user is offline and
    // already FCM-eligible). 'offline'/'online' both clear the flag — an
    // explicit offline means "stop pushing to a live socket", and a truly gone
    // socket is handled by the close/heartbeat path, not this handler.
    const connection = socket_connections.get(payload.sender_id);
    if (connection) {
      connection.is_background = payload.status === "background";
    }

    const connected_users = await get_user_peers(payload.sender_id);
    const message_payload: ConnectionStatusPayload = {
      sender_id: payload.sender_id,
      status: payload.status,
    };
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: Array.from(connected_users),
      message: {
        type: "connection:status",
        payload: message_payload,
        ws_timestamp: new Date()
      },
      exclude_user_ids: [payload.sender_id]
    });

    // update user status in DB
    // await update_user_connection_status(payload.sender_id, payload.status);

    return {
      success: true,
      code: 200,
      message: "Connection status updated and broadcasted successfully"
    };
  }
  catch (error) {
    console.error('[WS] Error handling connection status change:', error);

    return {
      success: false,
      code: 500,
      message: "Connection status updated and broadcasted successfully",
      error: error as any
    };
  }
};

const handle_conv_join = async (payload: ConvJoinPayload, timestamp?: Date | string): Promise<ResultType> => {
  try {
    if (!payload.last_read_msg_id) {
      return { success: true, code: 200, message: "No messages to mark as read" };
    }
    const now = new Date();
    // WS ws_timestamp arrives as a string over the wire; normalize to Date once.
    const effective_ts: Date =
      timestamp instanceof Date
        ? timestamp
        : typeof timestamp === "string"
          ? new Date(timestamp)
          : now;

    // grab the previous cursor BEFORE overwriting it
    const prev_receipt = await get_receipt(payload.user_id, payload.conv_id);
    const prev_read_msg_id = prev_receipt.last_read_msg_id;

    // update last_read in the chat member cache
    set_last_read(
      payload.user_id,
      payload.conv_id,
      payload.last_read_msg_id,
      effective_ts,
    );

    // reset the unread count for this user - conversation
    reset_unread(payload.user_id, payload.conv_id);

    // Pin the user's currently-active conversation on their socket connection so
    // handle_message_new can skip incrementing unread for them while they're here.
    // Polling-only clients have no socket_connections entry and fall through;
    // their reset comes from the read-status ack path in handle_message_status_ack.
    const ws_conn = socket_connections.get(payload.user_id);
    if (ws_conn) ws_conn.active_conv_id = payload.conv_id;

    // mark messages as read upto last_read_msg_id in message_info table — only the unread window
    mark_read_upto(payload.user_id, payload.conv_id, payload.last_read_msg_id, effective_ts, prev_read_msg_id);

    // find distinct senders only in the unread window (prev_cursor, new_cursor]
    const lower_bound = prev_read_msg_id
      ? sql`${message_model.sent_at} > (SELECT ${message_model.sent_at} FROM ${message_model} WHERE ${message_model.id} = ${prev_read_msg_id} LIMIT 1)`
      : sql`TRUE`;

    const unread_senders = await db
      .selectDistinct({ sender_id: message_model.sender_id })
      .from(message_model)
      .where(
        and(
          eq(message_model.chat_id, payload.conv_id),
          sql`${message_model.sent_at} <= (SELECT ${message_model.sent_at} FROM ${message_model} WHERE ${message_model.id} = ${payload.last_read_msg_id} LIMIT 1)`,
          lower_bound,
          sql`${message_model.sender_id} IS NOT NULL AND ${message_model.sender_id} <> ${payload.user_id}::uuid`,
          isNull(message_model.deleted_at),
        )
      );

    const sender_ids = unread_senders
      .map(r => r.sender_id)
      .filter((id): id is string => id !== null);

    if (sender_ids.length > 0) {
      const conversation_join_payload: ConvJoinPayload = {
        user_id: payload.user_id,
        conv_id: payload.conv_id,
        last_read_msg_id: payload.last_read_msg_id,
      };

      await broadcast_message({
        to: "users",
        user_ids: sender_ids,
        message: {
          type: "conversation:join",
          payload: conversation_join_payload,
          ws_timestamp: now,
        },
      });
    }

    return {
      success: true,
      code: 200,
      message: "Conversation join/leave status updated and broadcasted successfully"
    };
  }

  catch (error) {
    console.error('[WS] Error handling connection status change:', error);

    return {
      success: false,
      code: 500,
      message: "Error handling conversation join/leave",
      error: error as any
    };
  }
};


// User explicitly tapped "Mark as read" on a chat list row. Same DB effect
// as handle_conv_join (mark every message <= last_read_msg_id as read for
// this user + broadcast updated read receipts to the original senders), but
// we deliberately skip the `active_conv_id` pin on the socket connection —
// the user isn't entering the conversation, only flushing its unread state.
const handle_conv_mark_read = async (payload: ConvJoinPayload, timestamp?: Date | string): Promise<ResultType> => {
  try {
    if (!payload.last_read_msg_id) {
      return { success: true, code: 200, message: "No messages to mark as read" };
    }
    const now = new Date();
    const effective_ts: Date =
      timestamp instanceof Date
        ? timestamp
        : typeof timestamp === "string"
          ? new Date(timestamp)
          : now;

    // Snapshot previous cursor BEFORE overwriting so we only broadcast to
    // senders within the newly-acked window.
    const prev_receipt = await get_receipt(payload.user_id, payload.conv_id);
    const prev_read_msg_id = prev_receipt.last_read_msg_id;

    set_last_read(
      payload.user_id,
      payload.conv_id,
      payload.last_read_msg_id,
      effective_ts,
    );

    reset_unread(payload.user_id, payload.conv_id);

    mark_read_upto(payload.user_id, payload.conv_id, payload.last_read_msg_id, effective_ts, prev_read_msg_id);

    // Find distinct senders in the unread window (prev_cursor, new_cursor].
    const lower_bound = prev_read_msg_id
      ? sql`${message_model.sent_at} > (SELECT ${message_model.sent_at} FROM ${message_model} WHERE ${message_model.id} = ${prev_read_msg_id} LIMIT 1)`
      : sql`TRUE`;

    const unread_senders = await db
      .selectDistinct({ sender_id: message_model.sender_id })
      .from(message_model)
      .where(
        and(
          eq(message_model.chat_id, payload.conv_id),
          sql`${message_model.sent_at} <= (SELECT ${message_model.sent_at} FROM ${message_model} WHERE ${message_model.id} = ${payload.last_read_msg_id} LIMIT 1)`,
          lower_bound,
          sql`${message_model.sender_id} IS NOT NULL AND ${message_model.sender_id} <> ${payload.user_id}::uuid`,
          isNull(message_model.deleted_at),
        )
      );

    const sender_ids = unread_senders
      .map(r => r.sender_id)
      .filter((id): id is string => id !== null);

    if (sender_ids.length > 0) {
      // Reuse the existing `conversation:join` broadcast contract so each
      // sender's app updates tick marks via its existing handler — no new
      // client-side handler needed.
      const conversation_join_payload: ConvJoinPayload = {
        user_id: payload.user_id,
        conv_id: payload.conv_id,
        last_read_msg_id: payload.last_read_msg_id,
      };

      await broadcast_message({
        to: "users",
        user_ids: sender_ids,
        message: {
          type: "conversation:join",
          payload: conversation_join_payload,
          ws_timestamp: now,
        },
      });
    }

    return {
      success: true,
      code: 200,
      message: "Conversation marked as read successfully"
    };
  }
  catch (error) {
    console.error('[WS] Error handling conversation:mark_read:', error);
    return {
      success: false,
      code: 500,
      message: "Error handling conversation:mark_read",
      error: error as any
    };
  }
};


// When a DM message arrives, the recipient may have previously "deleted for
// me" the chat — chat_members.removed_at is set, the conv member cache no
// longer includes them, and their local DB has no chat row at all. The
// inbound message is the trigger to revive: clear removed_at, re-hydrate
// the cache, and emit conversation:new to the affected user so their
// client inserts the chat + chat_member + peer-user rows into local SQLite
// before the message:new lands. WS messages on a single connection are
// FIFO-ordered, and missed_ws_messages preserves order on offline replay,
// so the chat row will exist by the time the message:new is processed.
//
// Group chats don't have a per-user hide concept — they're either deleted
// for everyone (chat_delete) or you're an active member. This whole path
// is a no-op for non-DM messages.
const revive_hidden_dm_members = async (conv_id: string, sender_id: string): Promise<void> => {
  try {
    // Look up chat type + sender info in parallel — both are needed only
    // when revival is required, but the type check is cheap and short-circuits.
    const [chat_row] = await db
      .select({ id: chat_model.id, type: chat_model.type })
      .from(chat_model)
      .where(eq(chat_model.id, conv_id))
      .limit(1);
    if (!chat_row || chat_row.type !== "dm") return;

    // Find members with removed_at set. For DMs this is at most one row
    // (only the receiver could have hidden the chat — the sender obviously
    // hasn't, since they're sending into it). Index: chat_members has a
    // unique index on (chat_id, user_id) WHERE removed_at IS NULL; this
    // query is by chat_id which is selective enough on its own.
    const hidden = await db
      .select({
        user_id: chat_member_model.user_id,
      })
      .from(chat_member_model)
      .where(
        and(
          eq(chat_member_model.chat_id, conv_id),
          isNotNull(chat_member_model.removed_at),
        )
      );

    const hidden_user_ids = hidden
      .map(h => h.user_id)
      .filter((id): id is string => id !== null);
    if (hidden_user_ids.length === 0) return;

    // Clear removed_at for all hidden members in one statement.
    await db
      .update(chat_member_model)
      .set({ removed_at: null })
      .where(
        and(
          eq(chat_member_model.chat_id, conv_id),
          inArray(chat_member_model.user_id, hidden_user_ids),
        )
      );

    // Sender info drives the conversation:new payload (peer view from the
    // revived user's POV).
    const [sender] = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        profile_pic: user_model.profile_pic,
      })
      .from(user_model)
      .where(eq(user_model.id, sender_id))
      .limit(1);
    if (!sender) return;

    // Re-hydrate the conversation member cache so the message:new broadcast
    // that follows fans out to the revived user(s). add_members is idempotent.
    await add_members([sender_id, ...hidden_user_ids], conv_id);

    const now = new Date();
    for (const revived_user_id of hidden_user_ids) {
      const payload: NewConversationPayload = {
        conv_id,
        conv_type: "dm",
        creater_id: sender.id,
        creater_name: sender.name,
        creater_phone: sender.phone || "",
        creater_pfp: sender.profile_pic || undefined,
        joined_at: now,
      };
      // Direct-to-user so the revived recipient gets it even though their
      // cache entry was just (re-)added. broadcast_message also persists
      // into missed_ws_messages for offline users, preserving ordering
      // with the message:new event that follows.
      await broadcast_message({
        to: "users",
        user_ids: [revived_user_id],
        message: {
          type: "conversation:new",
          payload,
          ws_timestamp: now,
        },
      });
    }
  } catch (err) {
    console.error("[message:new] revive_hidden_dm_members failed:", err);
  }
};

const handle_message_new = async (payload: ChatMessagePayload, user_name: string): Promise<ResultType> => {
  try {
    // Send guard: only active members may post (so a left/kicked user can't keep
    // sending into a group they no longer belong to). Active members ARE the
    // conversation member set, which broadcast_message loads anyway — so the
    // is_member fast-path reuses that load and adds NO DB round-trip on the hot
    // path (an active member sending). A user is evicted from the set the instant
    // they leave / are kicked (cache_remove_member), so is_member==true ⟹ active.
    //
    // Only a cache MISS pays for one indexed status lookup, covering the rare
    // cases: a genuinely-removed member trying to post, OR a user re-sending into
    // a DM they "deleted-for-me" (removed_at set but status still 'active') — the
    // latter must be allowed so revive_hidden_dm_members below re-adds them, which
    // is why we gate on status='active' here, not removed_at.
    let sender_active = await is_member(payload.sender_id, payload.conv_id);
    if (!sender_active) {
      const [m] = await db
        .select({ status: chat_member_model.status })
        .from(chat_member_model)
        .where(
          and(
            eq(chat_member_model.chat_id, payload.conv_id),
            eq(chat_member_model.user_id, payload.sender_id),
            eq(chat_member_model.status, "active"),
          ),
        )
        .limit(1);
      sender_active = !!m;
    }
    if (!sender_active) {
      const rejected_ack: MessageSentAckPayload = {
        msg_id: payload.id,
        conv_id: payload.conv_id,
        is_sent: false,
        error_code: 403,
      };
      await broadcast_message({
        to: "users",
        user_ids: [payload.sender_id],
        message: {
          type: "message:sent:ack",
          payload: rejected_ack,
          ws_timestamp: new Date(),
        },
      });
      return {
        success: false,
        code: 403,
        message: "Not an active member of this conversation",
      };
    }

    // store the new message in DB
    const store_msg_result = await store_message_with_retry(payload, 5);
    if (!store_msg_result.success) {
      // send message is failed ack to the sender
      const failed_to_send_ack: MessageSentAckPayload = {
        msg_id: payload.id,
        conv_id: payload.conv_id,
        is_sent: false,
        error_code: store_msg_result.code || 500,
      };

      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: [payload.sender_id],
        message: {
          type: "message:sent:ack",
          payload: failed_to_send_ack,
          ws_timestamp: new Date()
        },
      });

      // stop further processing for this message
      return {
        success: false,
        code: store_msg_result.code || 500,
        message: "Failed to store message after multiple attempts",
      };
    }

    // Pre-warm replied-to preview on the broadcast payload so recipients can
    // render the reply container on first paint without a local DB lookup.
    let replied_to_message: ChatMessagePayload["replied_to_message"] = null;
    if (payload.replied_to) {
      try {
        const [orig] = await db
          .select({
            id: message_model.id,
            sender_id: message_model.sender_id,
            type: message_model.type,
            body: message_model.body,
            attachments: message_model.attachments,
            sent_at: message_model.sent_at,
          })
          .from(message_model)
          .where(eq(message_model.id, payload.replied_to))
          .limit(1);
        if (orig) {
          // sender_name lookup is best-effort; the client falls back to
          // its UserInfoCache if null.
          let sender_name: string | null = null;
          if (orig.sender_id) {
            const [u] = await db
              .select({ name: user_model.name })
              .from(user_model)
              .where(eq(user_model.id, orig.sender_id))
              .limit(1);
            sender_name = u?.name ?? null;
          }
          replied_to_message = {
            id: orig.id,
            sender_id: orig.sender_id,
            sender_name,
            type: orig.type,
            body: orig.body,
            attachments: orig.attachments,
            sent_at: orig.sent_at,
          };
        }
      } catch (err) {
        console.error("[message:new] replied_to enrichment failed:", err);
      }
    }

    const updated_message_payload: ChatMessagePayload = {
      ...payload,
      id: store_msg_result.new_id ?? payload.id, // update message ID if it was changed during retry
      replied_to_message,
      // Broadcast the stored sent_at, not the client claim — store_message
      // clamps skewed client clocks to server time, and recipients must see
      // the same value the DB holds.
      sent_at: store_msg_result.data?.sent_at ?? payload.sent_at,
      // Surface the server-stamped expires_at (null when chat has disappearing
      // off) so recipients can filter expired-but-not-yet-deleted messages in
      // the view layer. Server sweeper remains the authoritative deleter.
      expires_at: store_msg_result.data?.expires_at ?? null,
    };

    // Before fanning out the message: if the recipient previously hid this DM
    // (chat_members.removed_at), revive their membership and emit a
    // conversation:new event so their client recreates the local chat row
    // before message:new is processed. Awaited so the conversation:new
    // arrives on the WS wire ahead of message:new — order matters on the
    // recipient side. Group chats short-circuit inside the helper.
    await revive_hidden_dm_members(payload.conv_id, payload.sender_id);

    // broadcast to the chat recipients about the new message
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    const sent_result = await broadcast_message({
      to: "conversation",
      conv_id: payload.conv_id,
      message: {
        type: "message:new",
        payload: updated_message_payload,
        ws_timestamp: new Date()
      },
      exclude_user_ids: [payload.sender_id]
    });

    // const is_sender_online = socket_connections.has(payload.sender_id);
    // const is_sender_in_conv = socket_connections.get(payload.sender_id)?.active_conv_id === payload.conv_id;
    const sent_ack: MessageSentAckPayload = {
      msg_id: payload.id,
      conv_id: payload.conv_id,
      is_sent: true,
      new_id: store_msg_result.new_id,
      // Canonical stored sent_at — lets a sender with a skewed clock correct
      // its local copy to what the server persisted and recipients received.
      sent_at: store_msg_result.data?.sent_at ?? undefined,
      // delivered_to: sent_result.online,
      // read_by: sent_result.active_in_conv,
    };

    // send ack to sender along with message delivery status
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: [payload.sender_id],
      message: {
        type: "message:sent:ack",
        payload: sent_ack,
        ws_timestamp: new Date()
      },
    });

    // ── Fire-and-forget: Redis caches, DB status inserts, FCM ───────────
    // These run after the sender ACK is sent — latency-insensitive work.
    if (store_msg_result.data) {
      // const conv_members = await get_conversation_members(payload.conv_id);
      const now = new Date();

      // 1. Update Redis chat_meta (last message display data)
      update_chat_meta(payload.conv_id, {
        id: store_msg_result.new_id ?? store_msg_result.data.id,
        body: payload.body ?? "",
        type: payload.msg_type,
        sender_id: payload.sender_id,
        // Prefer the stored (clock-clamped) sent_at over the raw client claim.
        sent_at: (() => {
          const stored = store_msg_result.data?.sent_at;
          if (stored instanceof Date) return stored.toISOString();
          // WS wire sends sent_at as an ISO string, but the type claims Date.
          // Handle both safely without relying on TS's narrowing.
          const raw = payload.sent_at as unknown;
          if (raw instanceof Date) return raw.toISOString();
          if (typeof raw === "string" && raw.length > 0) return raw;
          return now.toISOString();
        })(),
        attachments: payload.attachments ?? null,
        // sender_name: payload.sender_name ?? "",
      });

      // 2. Increment unread for all chat members except the sender, and except
      //    users currently active in this conversation (their UI is already
      //    showing the message; bumping their unread would inflate the badge
      //    until they re-join). active_conv_id is set in handle_conv_join.
      const unread_user_ids = [
        ...sent_result.offline,
        ...sent_result.online,
        ...sent_result.polling,
      ].filter(id => {
        if (id === payload.sender_id) return false;
        const conn = socket_connections.get(id);
        if (conn && conn.active_conv_id === payload.conv_id) return false;
        return true;
      });
      if (unread_user_ids.length > 0) {
        batch_increment_unread(unread_user_ids, payload.conv_id);
      }

      // 3. Batch insert message_status in the redis (redis first to wait for status updates)
      // const message_statuses: Array<{
      //   user_id: string;
      //   message_id: string;
      //   chat_id: string;
      //   delivered_at: Date | null;
      //   // read_at: Date | null;
      // }> = [];
      // for (const member_id of conv_members) {
      //   if (member_id !== payload.sender_id) {
      //     message_statuses.push({
      //       user_id: member_id,
      //       message_id: store_msg_result.data.id,
      //       chat_id: payload.conv_id,
      //       delivered_at: sent_result.online.includes(member_id) ? now : null,
      //       // read_at: sent_result.active_in_conv.includes(member_id) ? now : null,
      //     });
      //   }
      // }
      // if (message_statuses.length > 0) {
      //   batch_insert_message_status(message_statuses);
      // }

      // 4. Update chat_member delivery/read cursors
      // const offline_and_inactive_users = new Set([...sent_result.offline, ...sent_result.online]);
      // for (const user_id of offline_and_inactive_users) {
      //   db.update(chat_member_model)
      //     .set({
      //       last_delivered_msg_id: sent_result.online.includes(user_id) || sent_result.active_in_conv.includes(user_id)
      //         ? store_msg_result.data.id
      //         : sql`${chat_member_model.last_delivered_msg_id}`,
      //       last_read_msg_id: sent_result.active_in_conv.includes(user_id)
      //         ? store_msg_result.data.id
      //         : sql`${chat_member_model.last_read_msg_id}`,
      //     })
      //     .where(
      //       and(
      //         eq(chat_member_model.chat_id, payload.conv_id),
      //         eq(chat_member_model.user_id, user_id)
      //       )
      //     );
      // }
    }

    // 5. Update conversation's last_msg_id and last_msg_at in the DB (fire-and-forget)
    // update_conversation({
    //   id: payload.conv_id,
    //   last_msg_id: store_msg_result.data?.id,
    //   last_msg_at: new Date()
    // });

    // 6. Queue FCM for offline AND backgrounded users. Backgrounded users keep
    //    a live WS (so they also received the frame above), but the OS may have
    //    frozen the socket, so a push is the reliable delivery path — the client
    //    dedupes the WS/FCM overlap by message id. Muted recipients still get
    //    the FCM (their app needs the message to land in local DB) but with a
    //    silent flag so the app skips painting a local notification. offline and
    //    background are disjoint (background ⊂ online), so no double-queue.
    const fcm_ws_message: WSMessage = {
      type: "message:new",
      payload: updated_message_payload,
      ws_timestamp: new Date()
    };
    const muted = await get_muted_user_ids(payload.conv_id);
    for (const user_id of [...sent_result.offline, ...sent_result.background]) {
      queue_message_fcm(user_id, fcm_ws_message, { silent: muted.has(user_id) });
    }

    return {
      success: true,
      code: 200,
      message: "New Message is processed and broadcasted successfully"
    };
  }
  catch (error) {
    console.error('[WS] Error handling connection status change:', error);

    return {
      success: false,
      code: 500,
      message: "Failed to process new message",
      error: error as any
    };
  }
};

const handle_message_status_ack = async (payload: MessageStatusAckPayload, user_id: string, timestamp?: Date | string): Promise<ResultType> => {
  try {
    // const total_msgs = payload.acks?.reduce((s, g) => s + (g.msg_ids?.length ?? 0), 0) ?? 0;
    // console.log(`[STATUS-ACK] from=${user_id}, chats=${payload.acks?.length ?? 0}, msgs=${total_msgs}`);

    const recipient_id = user_id ?? payload.recipient_id;
    const ack_at = payload.at instanceof Date ? payload.at : (typeof payload.at === 'string' ? new Date(payload.at) : new Date());

    // store in redis cache (fire-and-forget, flushed to DB by worker)
    batch_mark_status(recipient_id, ack_at, payload.acks);

    // Read-status acks mean the user has caught up to the messages they're
    // acking — reset Redis unread for those chats. Polling-only clients
    // (which never set active_conv_id) rely on this path to keep their badge
    // counts honest. Newer messages arriving after the ack will re-bump for
    // recipients who aren't currently in the conv via handle_message_new.
    for (const g of payload.acks) {
      if (g.status.includes("read")) {
        reset_unread(recipient_id, g.chat_id);
      }
    }

    // collect all msg_ids, one PK lookup to get sender_id per message
    const all_msg_ids = payload.acks.flatMap(g => g.msg_ids);
    if (all_msg_ids.length > 0) {
      const rows = await db
        .select({ id: message_model.id, sender_id: message_model.sender_id })
        .from(message_model)
        .where(inArray(message_model.id, all_msg_ids));

      const sender_map = new Map<string, string>();
      for (const r of rows) {
        if (r.sender_id) sender_map.set(r.id, r.sender_id);
      }

      // group acks by sender so each sender gets only their messages
      const per_sender = new Map<string, MessageStatusAckPayload["acks"]>();
      for (const group of payload.acks) {
        for (const msg_id of group.msg_ids) {
          const sid = sender_map.get(msg_id);
          if (!sid || sid === recipient_id) continue;
          let entry = per_sender.get(sid);
          if (!entry) {
            entry = [];
            per_sender.set(sid, entry);
          }
          let chat_group = entry.find(e => e.chat_id === group.chat_id && e.status.join() === group.status.join());
          if (!chat_group) {
            chat_group = { chat_id: group.chat_id, msg_ids: [], status: group.status };
            entry.push(chat_group);
          }
          chat_group.msg_ids.push(msg_id);
        }
      }

      // broadcast to each sender with only their messages
      for (const [sender_id, acks] of per_sender) {
        await broadcast_message({
          to: "users",
          user_ids: [sender_id],
          message: {
            type: "message:status:ack",
            payload: { recipient_id, at: ack_at, acks },
            ws_timestamp: new Date(),
          },
        });
      }
    }

    return {
      success: true,
      code: 200,
      message: "Message status ack processed and broadcasted successfully"
    };
  }
  catch (error) {
    console.error('[WS] Error handling message status ack:', error);

    return {
      success: false,
      code: 500,
      message: "Failed to process message status ack",
      error: error as any
    };
  }
};

const handle_message_forward = async (payload: MessageForwardPayload, username: string): Promise<ResultType> => {
  try {

    const forward_res = await forward_messages({
      message_ids: payload.forwarded_message_ids,
      source_conversation_id: payload.source_conv_id,
      target_conversation_ids: payload.target_conv_ids,
    }, payload.forwarder_id);

    if (forward_res.success && forward_res.data) {
      // Collect all message status records for batch insert
      // const all_message_statuses: Array<{ user_id: string; message_id: string; chat_id: string; delivered_at: Date | null; read_at: Date | null; }> = [];

      // loop on all target conversations (use for...of to properly await)
      for (const [conv_id, all_msgs_for_conv] of forward_res.data.entries()) {

        // Get all members of this conversation for batch message status creation
        // const conv_members = await get_conversation_members(conv_id);

        // loop on all forward message in that target conversation
        for (const msg of all_msgs_for_conv) {
          const new_chat_msg_payload: ChatMessagePayload = {
            id: msg.id,
            sender_id: msg.sender_id ?? payload.forwarder_id,
            // sender_name: payload.forwarder_name || username ? String(username) : undefined,
            conv_id: conv_id,
            // conv_type: msg.conv_type as ChatType,
            msg_type: msg.type,
            body: msg.body || undefined,
            attachments: msg.attachments,
            sent_at: msg.sent_at ? msg.sent_at : new Date(),
          };

          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "conversation",
            conv_id: conv_id,
            message: {
              type: "message:new",
              payload: new_chat_msg_payload,
              ws_timestamp: new Date()
            },
            // exclude_user_ids: [payload.forwarder_id],
          });

          // Prepare message status records for all members except sender
          // for (const member_id of conv_members) {
          //   if (member_id !== payload.forwarder_id) {
          //
          //     const is_member_online = socket_connections.has(member_id);
          //     const is_member_in_conv = socket_connections.get(member_id)?.active_conv_id === conv_id;
          //
          //     all_message_statuses.push({
          //       user_id: member_id,
          //       message_id: msg.id,
          //       chat_id: conv_id,
          //       delivered_at: is_member_online ? new Date() : null,
          //       read_at: is_member_in_conv ? new Date() : null,
          //     });
          //   }
          // }
        }

        // sort message based on sent_at, and extract the most recent message if sent_at is not present then sort based on message_id
        all_msgs_for_conv.sort((a, b) => {
          const dateA = a.sent_at ? new Date(a.sent_at).getTime() : 0;
          const dateB = b.sent_at ? new Date(b.sent_at).getTime() : 0;

          if (dateA !== dateB) {
            return dateA - dateB;
          } else {
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          }
        });

        // update the conversation's last message
        const last_msg = all_msgs_for_conv[all_msgs_for_conv.length - 1];
        // await update_conversation({
        //   id: conv_id,
        //   last_msg_id: last_msg.id,
        //   last_msg_at: new Date()
        // });
        update_chat_meta(conv_id, {
          id: last_msg.id,
          body: last_msg.body ?? "",
          type: last_msg.type,
          sender_id: last_msg.sender_id ?? payload.forwarder_id,
          sent_at: last_msg.sent_at?.toISOString() ?? new Date().toISOString(),
          attachments: last_msg.attachments ?? null,
          // sender_name: payload.sender_name ?? "",
        });

      }

      // Batch insert all message statuses in ONE database call
      // This is MASSIVELY more efficient than individual inserts
      // if (all_message_statuses.length > 0) {
      //   await batch_insert_message_status(all_message_statuses);
      //   console.log(`[WS] Batch inserted ${all_message_statuses.length} message statuses for forwarded messages`);
      // }
    }

    return {
      success: true,
      code: 200,
      message: "Messages forwarded and broadcasted successfully"
    };
  }
  catch (error) {
    console.error('[WS] Error handling message forwarding:', error);

    return {
      success: false,
      code: 500,
      message: "Failed to forward messages",
      data: error as any
    };
  }
};

const handle_call_init = async (payload: CallPayload, user_id: string, user_name?: string, user_pfp?: string): Promise<ResultType> => {
  try {
    // For call initiation, we typically just need to validate the payload and then the offer/answer/ice messages will be forwarded as is

    const result = await CallService.initiate_call(
      payload.caller_id || user_id,
      payload.callee_id
    );

    // acknowledgment payload
    const call_init_payload: CallPayload = {
      call_id: result.data?.call_id,
      caller_id: payload.caller_id || user_id,
      caller_name: payload.caller_name || user_name,
      caller_pfp: payload.caller_pfp || undefined,
      callee_id: payload.callee_id,
      timestamp: new Date(),
    };

    if (result.success) {

      // // Get caller details for the payload
      // let callerName: string | undefined;
      // let callerPfp: string | undefined;
      // try {
      //   const caller = await db
      //     .select({ name: user_model.name, profile_pic: user_model.profile_pic })
      //     .from(user_model)
      //     .where(eq(user_model.id, payload.caller_id || Number(user_id)))
      //     .limit(1);
      //
      //   callerName = caller[0]?.name;
      //   callerPfp = caller[0]?.profile_pic || undefined;
      // } catch (error) {
      //   console.error(`[WS] Error fetching caller details:`, error);
      // }

      // send ack to caller
      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: [payload.caller_id || user_id],
        message: {
          type: "call:init:ack",
          payload: call_init_payload,
          ws_timestamp: new Date()
        },
      });

      // Send ringing to callee via WebSocket if online
      if (is_user_online(payload.callee_id)) {
        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [payload.callee_id],
          message: {
            type: "call:ringing",
            payload: call_init_payload,
            ws_timestamp: new Date()
          },
        });
      }

      // Always send FCM regardless of WS status - ensures delivery on lock screen,
      // background, and as a backup when WS drops momentarily
      await FCMService.send_notification({
        type: "call",
        fcm_mode: "data-only",
        user_ids: [payload.callee_id],
        ws_message: {
          type: "call:ringing",
          payload: call_init_payload,
          ws_timestamp: new Date()
        }
      });

    }
    else {
      // Send error to caller
      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: [payload.caller_id || user_id],
        message: {
          type: "call:error",
          payload: {
            ...call_init_payload,
            error: {
              code: result.code,
              message: result.message,
              error: result.error,
            },
          },
          ws_timestamp: new Date()
        },
      });
    }

    return {
      success: true,
      code: 200,
      message: "Call initiation processed successfully"
    };
  }
  catch (error) {
    console.error('[WS] Error handling call initiation:', error);

    return {
      success: false,
      code: 500,
      message: "Failed to initiate call",
      error: error as any
    };
  }
};

const handle_call_signaling = async (payload: CallPayload, event_type: WSMessageEventsType, user_id: string): Promise<ResultType> => {

  try {
    if (!payload.call_id && !payload.data) {
      console.error("call_id or payload.data missing in call:offer/answer/ice payload");
      return {
        success: false,
        code: 400,
        message: "call_id or payload.data missing in call signaling payload"
      };
    }

    const call_offer_payload: CallPayload = {
      call_id: payload.call_id,
      caller_id: payload.caller_id,
      callee_id: payload.callee_id,
      data: payload.data,
      timestamp: new Date(),
    };

    // Determine the recipient based on message type and sender
    let recipient_id: string;
    if (event_type === 'call:offer') {
      // Offer goes from caller to callee
      recipient_id = payload.callee_id;
    } else if (event_type === 'call:answer') {
      // Answer goes from callee to caller
      recipient_id = payload.caller_id;
    } else {
      // ICE candidates go to the other user (whoever didn't send it)
      // If current user is caller, send to callee; if callee, send to caller
      recipient_id = user_id === payload.caller_id ? payload.callee_id : payload.caller_id;
    }

    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: [recipient_id],
      message: {
        type: event_type,
        payload: call_offer_payload,
      },
    });

    // console.log(`[WS] Forwarded ${event_type} to user ${recipient_id}`);
    return {
      success: true,
      code: 200,
      message: `${event_type} forwarded successfully`
    };
  }
  catch (error) {
    console.error(`[WS] Error handling call signaling for event ${event_type}:`, error);
    return {
      success: false,
      code: 500,
      message: `Failed to handle call signaling for event ${event_type}`,
      error: error as any
    };
  }
};

const handle_call_accept = async (payload: CallPayload, user_id: string): Promise<ResultType> => {
  try {
    if (!payload.call_id) {
      console.error("call_id missing in call:accept payload");
      return {
        success: false,
        code: 400,
        message: "call_id missing in call:accept payload"
      };
    }

    // Look up caller_id/callee_id from DB — client payload may have truncated IDs
    // (e.g. Kotlin optInt overflow for user IDs > 2^31)
    const call_info = await CallService.get_call_info(payload.call_id);
    if (!call_info) {
      console.error(`Call info not found for call_id ${payload.call_id}`);
      return {
        success: false,
        code: 404,
        message: `Call not found for call_id ${payload.call_id}`
      };
    }

    const caller_id = call_info?.data?.caller_id ?? payload.caller_id;
    const callee_id = call_info?.data?.callee_id ?? payload.callee_id;

    const result = await CallService.accept_call(payload.call_id, user_id);

    const call_accept_payload: CallPayload = {
      call_id: payload.call_id,
      caller_id: caller_id,
      callee_id: callee_id,
      timestamp: new Date(),
    };

    if (result.success) {
      // Notify both parties
      const active_call = CallService.get_user_active_call(user_id);

      if (active_call) {
        // Notify caller & Acknowledge to callee
        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [caller_id, callee_id],
          message: {
            type: "call:accept",
            payload: {
              ...call_accept_payload,
              data: { success: true }
            },
          },
        });
      }
    }
    else {
      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: [caller_id, callee_id],
        message: {
          type: "call:error",
          payload: {
            ...call_accept_payload,
            error: {
              code: result.code,
              message: result.message,
              error: result.error,
            },
          },
        },
      });
    }

    return {
      success: true,
      code: 200,
      message: "Call accept processed successfully"
    };
  }
  catch (error) {
    console.error(`[WS] Error handling call accept:`, error);
    return {
      success: false,
      code: 500,
      message: `Failed to handle call accept`,
      error: error as any
    };
  }
};

/**
 * Maps a client-supplied teardown reason string onto our internal
 * {@link CallEndReasonsType} enum.
 *
 * The Stream-backed client (`StreamCallService.endCall` / `declineCall`)
 * sends `caller_cancelled` / `user_declined` / `user_hangup`, none of
 * which are members of the enum. The in-house WebRTC client passes the
 * canonical names through unchanged.
 */
const map_call_terminate_reason = (
  supplied: string | undefined,
  is_caller_terminating: boolean,
): CallEndReasonsType => {
  switch (supplied) {
    case 'busy':
    case 'timeout':
    case 'declined':
    case 'abandoned':
    case 'caller_hungup':
    case 'callee_hungup':
    case 'network_error':
      return supplied;
    case 'caller_cancelled':
      return 'abandoned';
    case 'user_declined':
      return 'declined';
    case 'user_hangup':
      return is_caller_terminating ? 'caller_hungup' : 'callee_hungup';
    default:
      return is_caller_terminating ? 'caller_hungup' : 'callee_hungup';
  }
};

const handle_call_termination = async (
  payload: CallPayload,
  ws_event_type: WSMessageEventsType,
  user_id: string,
): Promise<ResultType> => {
  try {
    if (!payload.call_id) {
      return {
        success: false,
        code: 400,
        message: "call_id missing in call termination payload"
      };
    }

    const call_decline_payload: CallPayload = {
      call_id: payload.call_id,
      caller_id: payload.caller_id,
      callee_id: payload.callee_id,
      timestamp: new Date(),
    };

    // Branch on which backend tracks this call. The in-house WebRTC path
    // populates `active_calls` from `handle_call_init`; Stream-coordinated
    // calls bypass that entirely (Stream's coordinator owns the lifecycle).
    // Without this split, Stream `call:terminate` events 404 inside
    // `CallService.terminate_call` and the other party never gets the
    // relay broadcast — leaving the callee ringing.
    const is_legacy_call = active_calls.has(payload.call_id);

    let reason: CallEndReasonsType;
    let status: string | undefined;
    let terminate_error: { code?: number; message?: string; error?: any } | null = null;

    if (is_legacy_call) {
      // ── In-house WebRTC backend ─────────────────────────────────────────
      const active_call = CallService.get_user_active_call(user_id);
      reason =
        active_call
          ? active_call.answered_at
            ? active_call.caller_id === user_id
              ? "caller_hungup"
              : "callee_hungup"
            : (new Date().getTime() - active_call.started_at.getTime()) > CALL_TIMEOUT_MS
              ? "timeout"
              : active_call.caller_id === user_id
                ? "abandoned"
                : "declined"
          : "network_error";

      const result = await CallService.terminate_call(payload.call_id, user_id, reason);
      if (result.success) {
        status = result.data?.status;
      } else {
        terminate_error = {
          code: result.code,
          message: result.message,
          error: result.error,
        };
      }
    } else {
      // ── Stream-coordinated call ─────────────────────────────────────────
      // No DB row to update — `call_model` is only populated by the WebRTC
      // init path. We just need to gate on participation, then fan out
      // the relay so the other party's client can clear UI state and
      // (when offline) get an FCM nudge for the missed-call row.
      if (user_id !== payload.caller_id && user_id !== payload.callee_id) {
        terminate_error = {
          code: 401,
          message: "You are not a participant of this call",
        };
        reason = "network_error"; // unused — we fan out an error, not a terminate
      } else {
        const is_caller = user_id === payload.caller_id;
        reason = map_call_terminate_reason(
          payload.data?.reason as string | undefined,
          is_caller,
        );
        // Mirror `CallService.terminate_call`'s status derivation: caller
        // terminating an unanswered ring → ended (cancelled); callee → declined.
        status = is_caller ? "ended" : "declined";
        // Clean hangup → drop the in-call pairing so a subsequent socket close
        // (e.g. the hanger-upper then kills the app) does NOT spuriously open a
        // rejoin window. Webhook-independent (driven by this WS event), so it
        // works even where Stream webhooks can't reach this backend. Also close
        // any in-flight rejoin window for this call.
        StreamCallService.clearCall(payload.call_id, [payload.caller_id, payload.callee_id]);
        StreamCallService.resolveRejoinWindow(payload.call_id);
      }
    }

    if (!terminate_error) {
      const terminate_message_payload = {
        ...call_decline_payload,
        data: {
          success: true,
          terminated_by: user_id,
          status,
          reason,
        },
      };

      // Notify each party individually via WS (if online) or FCM (if offline)
      for (const id of [payload.caller_id, payload.callee_id]) {
        if (is_user_online(id)) {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [id],
            message: {
              type: ws_event_type,
              payload: terminate_message_payload,
            },
          });
        } else {
          await FCMService.send_notification({
            type: "call",
            fcm_mode: "data-only",
            user_ids: [id],
            ws_message: {
              type: ws_event_type,
              payload: terminate_message_payload,
            },
          });
        }
      }
    } else {
      // Send error back to the user
      await broadcast_message({
        to: "users",
        user_ids: [user_id],
        message: {
          type: "call:error",
          payload: {
            ...call_decline_payload,
            error: terminate_error,
          },
        },
      });
    }

    return {
      success: true,
      code: 200,
      message: "Call termination processed successfully"
    };
  }
  catch (error) {
    console.error(`[WS] Error handling call termination for event ${ws_event_type}:`, error);
    return {
      success: false,
      code: 500,
      message: `Failed to handle call termination for event ${ws_event_type}`,
      error: error as any
    };
  }
};


// Register missed-call notifier so call.service can send WS+FCM without circular imports
register_missed_call_notifier(async (callee_id, call_id, caller_id) => {
  const missed_payload: CallPayload = {
    call_id,
    caller_id,
    callee_id,
    timestamp: new Date(),
  };
  if (is_user_online(callee_id)) {
    await broadcast_message({
      to: "users",
      user_ids: [callee_id],
      message: { type: "call:missed", payload: missed_payload, ws_timestamp: new Date() },
    });
  }
  await FCMService.send_notification({
    type: "call",
    fcm_mode: "data-only",
    user_ids: [callee_id],
    ws_message: { type: "call:missed", payload: missed_payload, ws_timestamp: new Date() },
  });
});

const handle_call_hold = async (payload: CallPayload, user_id: string): Promise<ResultType> => {
  try {
    if (!payload.call_id) {
      return { success: false, code: 400, message: "call_id missing in call:hold payload" };
    }
    const active_call = active_calls.get(payload.call_id);
    if (!active_call) {
      return { success: false, code: 404, message: "Active call not found for call:hold" };
    }
    const recipient_id = active_call.caller_id === user_id ? active_call.callee_id : active_call.caller_id;
    await broadcast_message({
      to: "users",
      user_ids: [recipient_id],
      message: { type: "call:hold", payload, ws_timestamp: new Date() },
    });
    return { success: true, code: 200, message: "call:hold forwarded" };
  } catch (error) {
    console.error("[WS] Error handling call:hold:", error);
    return { success: false, code: 500, message: "Failed to handle call:hold", error: error as any };
  }
};

/** Push a single WS message to one user — WS if online, else FCM data-only.
 * Mirrors the per-party fan-out loop in [handle_call_termination]. */
const fan_out_to_user = async (
  target_id: string,
  ws_event_type: WSMessageEventsType,
  payload: CallPayload,
): Promise<void> => {
  if (is_user_online(target_id)) {
    await broadcast_message({
      to: "users",
      user_ids: [target_id],
      message: { type: ws_event_type, payload, ws_timestamp: new Date() },
    });
  } else {
    await FCMService.send_notification({
      type: "call",
      fcm_mode: "data-only",
      user_ids: [target_id],
      ws_message: { type: ws_event_type, payload, ws_timestamp: new Date() },
    });
  }
};

/**
 * The app reports that a Stream call reached the CONNECTED state (first media
 * frame). We record the in-call pairing (both parties busy on the cid +
 * connected) so the socket-close handler can self-open a rejoin window on a
 * mid-call drop — WITHOUT depending on Stream webhooks (which can't reach a
 * private-IP backend). Both parties send this; it's idempotent.
 * `payload.data.peer_id` is the other participant.
 */
const handle_call_connected = async (payload: CallPayload, user_id: string): Promise<ResultType> => {
  try {
    const cid = payload.call_id;
    if (!cid) return { success: false, code: 400, message: "call_id missing in call:connected" };
    if (user_id !== payload.caller_id && user_id !== payload.callee_id) {
      return { success: false, code: 401, message: "Not a participant of this call" };
    }
    const peer = (payload.data?.peer_id as string | undefined)
      ?? (user_id === payload.caller_id ? payload.callee_id : payload.caller_id);
    StreamCallService.markCallConnected(user_id, peer, cid);
    // If THIS user was the dropped party of an open rejoin window, their fresh
    // `call:connected` means they came back (rejoined the call, or their WS
    // reconnected while still in it) → resolve the window so it does NOT expire
    // and terminate the (now healthy) call, and tell both sides "reconnected".
    const w = StreamCallService.resolveRejoinWindowIfDropped(cid, user_id);
    if (w) {
      console.log(`[WS] rejoin window RESOLVED by call:connected cid=${cid} dropped=${user_id}`);
      await notify_rejoin_ended(w, "ended", "rejoined");
    }
    return { success: true, code: 200, message: "call connected recorded" };
  } catch (error) {
    console.error("[WS] Error handling call:connected:", error);
    return { success: false, code: 500, message: "Failed to handle call:connected", error: error as any };
  }
};

/** Look up a user's display name + avatar for the rejoin payloads. */
const get_user_display = async (userId: string): Promise<{ name?: string; pfp?: string }> => {
  try {
    const [u] = await db
      .select({ name: user_model.name, profile_pic: user_model.profile_pic })
      .from(user_model)
      .where(eq(user_model.id, userId))
      .limit(1);
    return { name: u?.name ?? undefined, pfp: u?.profile_pic ?? undefined };
  } catch (e) {
    console.error("[WS] get_user_display failed:", e);
    return {};
  }
};

/**
 * Push the two rejoin notifications when a window OPENS. The WAITER (G) is
 * notified FIRST so its "Reconnecting…" banner appears promptly, then the
 * DROPPED party (L) is told it can rejoin. Each send is isolated in its own
 * catch so a slow/failed FCM to one party can never suppress the other (the
 * previous code awaited L's FCM before G's push, so a slow L-FCM dropped G's
 * banner). Both go through fan_out_to_user, which falls back to FCM if the
 * target's WS is momentarily down — so a brief WS reconnect on G no longer
 * silently swallows the banner.
 */
const notify_rejoin_open = async (args: {
  cid: string;
  caller_id: string;
  callee_id: string;
  waiter_id: string;
  dropped_id: string;
  peer_name?: string;
  peer_pfp?: string;
  expires_at: number;
}): Promise<void> => {
  const expiresIso = new Date(args.expires_at).toISOString();
  // WAITER (G) — show "Reconnecting…". peer_* in data describe the DROPPED party.
  await fan_out_to_user(args.waiter_id, "call:rejoin:peer_dropped", {
    call_id: args.cid,
    caller_id: args.caller_id,
    callee_id: args.callee_id,
    data: { peer_id: args.dropped_id, expires_at: expiresIso },
    timestamp: new Date(),
  }).catch((e) => console.error("[WS] rejoin peer_dropped fan-out failed:", e));
  // DROPPED party (L) — can rejoin. peer_* in data describe the WAITER.
  await fan_out_to_user(args.dropped_id, "call:rejoin:available", {
    call_id: args.cid,
    caller_id: args.caller_id,
    callee_id: args.callee_id,
    data: {
      peer_id: args.waiter_id,
      peer_name: args.peer_name,
      peer_pfp: args.peer_pfp,
      expires_at: expiresIso,
    },
    timestamp: new Date(),
  }).catch((e) => console.error("[WS] rejoin available fan-out failed:", e));
};

/**
 * Push the close notification when a window ENDS (expired or resolved). Tells
 * BOTH the dropped party (clear its rejoin dot) AND the waiter (clear its
 * "Reconnecting…" banner from a server signal, not only its local timer).
 */
const notify_rejoin_ended = async (
  w: { cid: string; dropped_id: string; waiter_id: string },
  reason: string,
  outcome?: string,
): Promise<void> => {
  const mk = (role: string) => ({
    call_id: w.cid,
    caller_id: w.dropped_id,
    callee_id: w.waiter_id,
    data: { reason, outcome, role },
    timestamp: new Date(),
  });
  await fan_out_to_user(w.dropped_id, "call:rejoin:expired", mk("dropped")).catch(() => {});
  await fan_out_to_user(w.waiter_id, "call:rejoin:expired", mk("waiter")).catch(() => {});
};

/**
 * The 30s window elapsed with no rejoin → the SERVER terminates the call for
 * BOTH parties. Sends `call:terminate` to each (the still-connected waiter G
 * tears down its call screen via `_handleAmigoTerminate`; the dropped party L
 * cleans up any stale state) and `call:rejoin:expired` (clears L's rejoin dot).
 * Webhook-independent — everyone is informed and cleanup runs for both, as the
 * single authoritative end-of-window action.
 */
const terminate_rejoin_window = async (w: { cid: string; dropped_id: string; waiter_id: string }): Promise<void> => {
  StreamCallService.clearCall(w.cid, [w.dropped_id, w.waiter_id]);
  const terminate = (): CallPayload => ({
    call_id: w.cid,
    caller_id: w.dropped_id,
    callee_id: w.waiter_id,
    data: { success: true, terminated_by: "server", status: "ended", reason: "rejoin_timeout" },
    timestamp: new Date(),
  });
  await fan_out_to_user(w.waiter_id, "call:terminate", terminate()).catch(() => {});
  await fan_out_to_user(w.dropped_id, "call:terminate", terminate()).catch(() => {});
  // Also clear L's rejoin dot (in case L is sitting on the call-logs screen).
  await notify_rejoin_ended(w, "expired");
  console.log(`[WS] rejoin window TERMINATED (30s elapsed) cid=${w.cid} both=${w.dropped_id},${w.waiter_id}`);
};

/**
 * Server-authoritative mid-call drop recovery. Called from the WS close handler
 * when a user's socket goes away. If that user was in a CONNECTED call, the
 * backend ITSELF opens the rejoin window and notifies both parties — with NO
 * dependency on the dying client flushing a `call:rejoin:open` frame (which it
 * usually can't before the OS reaps the process). This is the primary, reliable
 * trigger; the client's leaver-open is now only a best-effort fast path.
 */
const handle_user_disconnected_midcall = async (user_id: string): Promise<void> => {
  try {
    const info = StreamCallService.getConnectedCallPeer(user_id);
    if (!info) return; // idle or still-ringing → not a recoverable mid-call drop
    const { cid, peerId } = info;
    // A client may already have opened the window for this exact drop — don't
    // double-open / double-fan.
    if (StreamCallService.hasRejoinWindow(cid, user_id)) {
      console.log(`[WS] midcall-drop: window already open cid=${cid} dropped=${user_id}`);
      return;
    }
    const waiter = await get_user_display(peerId); // peer_* describe the waiter (G)
    const window_ms = 30000;
    const expires_at = Date.now() + window_ms;
    StreamCallService.openRejoinWindow(
      { cid, waiter_id: peerId, dropped_id: user_id, peer_name: waiter.name, peer_pfp: waiter.pfp, expires_at },
      (expired) => void terminate_rejoin_window(expired),
    );
    console.log(`[WS] midcall-drop SELF-OPEN cid=${cid} dropped=${user_id} waiter=${peerId}`);
    await notify_rejoin_open({
      cid,
      caller_id: user_id,
      callee_id: peerId,
      waiter_id: peerId,
      dropped_id: user_id,
      peer_name: waiter.name,
      peer_pfp: waiter.pfp,
      expires_at,
    });
  } catch (error) {
    console.error("[WS] handle_user_disconnected_midcall error:", error);
  }
};

/**
 * Ghost-call recovery — open a short rejoin window so the DROPPED party can
 * rejoin a still-recoverable call, and tell them (via WS or FCM) it's
 * rejoinable until it expires. Two initiators:
 *   - 'waiter'  (default): the STILL-CONNECTED party (G) detected the peer (L)
 *      leave. data.peer_id = L (dropped). sender = G (waiter).
 *   - 'leaver': the LEAVING party (L) declares it's backgrounding but may
 *      return. sender = L (dropped); the waiter is the OTHER participant (G).
 *      This path is reliable even when the SFU participant-left event races L's
 *      process death.
 * `payload.data`: { initiated_by?, peer_id?, window_ms?, peer_name?, peer_pfp? }.
 * peer_name/peer_pfp always describe the WAITER (who the dropped party rejoins).
 */
const handle_call_rejoin_open = async (payload: CallPayload, user_id: string): Promise<ResultType> => {
  try {
    const cid = payload.call_id;
    if (!cid) {
      return { success: false, code: 400, message: "call_id missing in call:rejoin:open" };
    }
    if (user_id !== payload.caller_id && user_id !== payload.callee_id) {
      return { success: false, code: 401, message: "Not a participant of this call" };
    }
    const leaver = payload.data?.initiated_by === 'leaver';
    // Resolve the two roles for both initiators.
    const other_party = user_id === payload.caller_id ? payload.callee_id : payload.caller_id;
    const dropped_id = (leaver ? user_id : (payload.data?.peer_id as string | undefined)) as string | undefined;
    const waiter_id = leaver ? other_party : user_id;
    if (!dropped_id) {
      return { success: false, code: 400, message: "cannot resolve dropped user in call:rejoin:open" };
    }
    const window_ms = Number(payload.data?.window_ms) || 30000;
    const expires_at = Date.now() + window_ms;
    const peer_name = payload.data?.peer_name as string | undefined;
    const peer_pfp = payload.data?.peer_pfp as string | undefined;

    // A client-driven open for a drop the backend already self-opened (or the
    // other party already opened) is a duplicate — stand down rather than reset
    // expires_at and re-fan duplicate pushes.
    if (StreamCallService.hasRejoinWindow(cid, dropped_id)) {
      return { success: true, code: 200, message: "rejoin window already open" };
    }

    StreamCallService.openRejoinWindow(
      { cid, waiter_id, dropped_id, peer_name, peer_pfp, expires_at },
      (expired) => void terminate_rejoin_window(expired),
    );

    // Notify both parties (waiter first; each isolated; FCM fallback). See
    // notify_rejoin_open for why this replaced the await-L-FCM-then-WS-only-G.
    await notify_rejoin_open({
      cid,
      caller_id: payload.caller_id,
      callee_id: payload.callee_id,
      waiter_id,
      dropped_id,
      peer_name,
      peer_pfp,
      expires_at,
    });

    return { success: true, code: 200, message: "rejoin window opened" };
  } catch (error) {
    console.error("[WS] Error handling call:rejoin:open:", error);
    return { success: false, code: 500, message: "Failed to handle call:rejoin:open", error: error as any };
  }
};

/**
 * The waiter (G) reports the window is resolved — L rejoined, or G ended/timed
 * out. We close the window and (if it was still open) tell L to clear the dot.
 * `payload.data`: { outcome: 'rejoined' | 'ended' }.
 */
const handle_call_rejoin_resolved = async (payload: CallPayload, user_id: string): Promise<ResultType> => {
  try {
    const cid = payload.call_id;
    if (!cid) {
      return { success: false, code: 400, message: "call_id missing in call:rejoin:resolved" };
    }
    const w = StreamCallService.resolveRejoinWindow(cid);
    if (w) {
      // Notify BOTH: the dropped party clears its rejoin dot; the waiter clears
      // its "Reconnecting…" banner (e.g. if its local SFU return-detection
      // didn't fire). outcome distinguishes rejoined vs ended.
      await notify_rejoin_ended(w, "ended", payload.data?.outcome as string | undefined);
    }
    return { success: true, code: 200, message: "rejoin window resolved" };
  } catch (error) {
    console.error("[WS] Error handling call:rejoin:resolved:", error);
    return { success: false, code: 500, message: "Failed to handle call:rejoin:resolved", error: error as any };
  }
};

export {
  handle_connection_status,
  handle_conv_join,
  handle_conv_mark_read,
  handle_message_new,
  handle_message_status_ack,
  handle_message_forward,
  handle_call_init,
  handle_call_signaling,
  handle_call_accept,
  handle_call_termination,
  handle_call_hold,
  handle_call_connected,
  handle_call_rejoin_open,
  handle_call_rejoin_resolved,
  handle_user_disconnected_midcall,
};
