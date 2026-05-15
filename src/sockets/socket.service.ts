import { ResultType } from "@/types/core.types";
import { CallPayload, ChatMessagePayload, ConnectionStatusPayload, MessageForwardPayload, WSMessageEventsType, WSMessage, ConvJoinPayload, MessageSentAckPayload, MessageStatusAckPayload, } from "@/types/socket.types";
import { broadcast_message, is_user_online, } from "./socket.handlers";
// import { update_user_connection_status } from "@/services/user.services";
import { socket_connections } from "./socket.server";
import { forward_messages, store_message_with_retry } from "@/services/message.services";
import { batch_insert_message_status, mark_read_upto } from "@/services/message-status.service";
import { get_conversation_members } from "@/cache-management/conv.cache";
import { update_chat_meta, batch_increment_unread, reset_unread } from "@/cache-management/chat-meta.cache";
import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { message_model } from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { update_conversation } from "@/services/chat.services";
import FCMService from "@/services/fcm.service";
import { queue_message_fcm } from "@/services/fcm-batch.service";
import { ChatType } from "@/types/chat.types";
import { CALL_TIMEOUT_MS, CallService, active_calls, register_missed_call_notifier } from "@/services/call.service";
import { call_model } from "@/models/call.model";
import { get_user_peers } from "@/cache-management/user-peer.cache";
import { set_last_read, get_receipt } from "@/cache-management/chat-member.cache";
import { batch_mark_status } from "@/cache-management/message.cache";

const handle_connection_status = async (payload: ConnectionStatusPayload): Promise<ResultType> => {
  try {
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


const handle_message_new = async (payload: ChatMessagePayload, user_name: string): Promise<ResultType> => {
  try {
    //
    // const ack_message_payload: ChatMessageAckPayload = {
    //   id: payload.id,
    //   conv_id: payload.conv_id,
    //   sender_id: payload.sender_id,
    //   delivered_at: new Date(),
    // };

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
    };

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
        sent_at: (() => {
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

    // 6. Queue FCM for offline users
    const fcm_ws_message: WSMessage = {
      type: "message:new",
      payload: updated_message_payload,
      ws_timestamp: new Date()
    };
    for (const user_id of sent_result.offline) {
      queue_message_fcm(user_id, fcm_ws_message);
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
    const total_msgs = payload.acks?.reduce((s, g) => s + (g.msg_ids?.length ?? 0), 0) ?? 0;
    console.log(`[STATUS-ACK] from=${user_id}, chats=${payload.acks?.length ?? 0}, msgs=${total_msgs}`);

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

const handle_call_termination = async (
  payload: CallPayload,
  ws_event_type: WSMessageEventsType,
  user_id: string,
  // reason: CallEndReasonsType
): Promise<ResultType> => {
  try {
    if (!payload.call_id) {
      // console.error("call_id missing in call:decline payload")
      return {
        success: false,
        code: 400,
        message: "call_id missing in call termination payload"
      };
    }

    // Get active call BEFORE declining (it will be removed after)
    const active_call = CallService.get_user_active_call(user_id);
    const reason =
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

    const call_decline_payload: CallPayload = {
      call_id: payload.call_id,
      caller_id: payload.caller_id,
      callee_id: payload.callee_id,
      timestamp: new Date(),
    };

    if (result.success) {
      // Determine caller and callee from active_call or payload
      // const caller_id = active_call?.caller_id || payload.caller_id;
      // const callee_id = active_call?.callee_id || payload.callee_id;
      // const other_user = caller_id === user_id ? callee_id : caller_id;
      // const is_caller_declining = user_id === caller_id;

      // Build the termination payload once
      const terminate_message_payload = {
        ...call_decline_payload,
        data: {
          success: true,
          terminated_by: user_id,
          status: result.data?.status,
          reason: reason,
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
        }
        else {
          await FCMService.send_notification({
            type: "call",
            fcm_mode: "data-only",
            user_ids: [id],
            ws_message: {
              type: ws_event_type,
              payload: terminate_message_payload,
            }
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
            error: {
              code: result.code,
              message: result.message,
              error: result.error
            },
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

export {
  handle_connection_status,
  handle_conv_join,
  handle_message_new,
  handle_message_status_ack,
  handle_message_forward,
  handle_call_init,
  handle_call_signaling,
  handle_call_accept,
  handle_call_termination,
  handle_call_hold,
};
