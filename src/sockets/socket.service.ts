import { ResultType } from "@/types/core.types";
import { CallPayload, ChatMessageAckPayload, ChatMessagePayload, ConnectionStatusPayload, JoinLeavePayload, MessageForwardPayload, WSMessageEventsType, WSMessage } from "@/types/socket.types";
import { broadcast_message, get_connected_users, handle_join_conversation, is_user_online, } from "./socket.handlers";
import { update_user_connection_status } from "@/services/user.services";
import { socket_connections } from "./socket.server";
import { batch_insert_message_status, forward_messages, store_message_with_retry } from "@/services/message.services";
import { get_conversation_members } from "@/services/cache-management/socket.cache";
import db from "@/config/db";
import { conversation_member_model, message_model } from "@/models/chat.model";
import { and, eq, sql } from "drizzle-orm";
import { update_conversation } from "@/services/chat.services";
import FCMService from "@/services/fcm.service";
import { queue_message_fcm } from "@/services/fcm-batch.service";
import { ChatType } from "@/types/chat.types";
import { CALL_TIMEOUT_MS, CallService } from "@/services/call.service";
import { convertBigIntToString } from "@/utils/serialization.utils";

const handle_connection_status = async (payload: ConnectionStatusPayload): Promise<ResultType> => {
  try {
    const connected_users = await get_connected_users(payload.sender_id);
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
    await update_user_connection_status(payload.sender_id, payload.status);

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

const handle_conv_join_leave = async (payload: JoinLeavePayload, ws_msg_type: WSMessageEventsType): Promise<ResultType> => {
  try {
    // update active_conv_id in socket_connections map
    const sock_conn = socket_connections.get(payload.user_id);
    if (sock_conn) {
      ws_msg_type === 'conversation:join'
        ? sock_conn.active_conv_id = payload.conv_id
        : sock_conn.active_conv_id = undefined;
    }

    if (ws_msg_type === 'conversation:join') {
      await handle_join_conversation({
        conv_id: payload.conv_id,
        user_id: payload.user_id,

        // is_active_in_conv: socket_connections.get(payload.user_id)?.active_conv_id === payload.conv_id
      });
    }

    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "conversation",
      conv_id: payload.conv_id,
      message: {
        type: ws_msg_type,
        payload: payload,
        ws_timestamp: new Date()
      },
      exclude_user_ids: [payload.user_id]
    });

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

    const ack_message_payload: ChatMessageAckPayload = {
      id: payload.id,
      conv_id: payload.conv_id,
      sender_id: payload.sender_id,
      delivered_at: new Date(),
    };

    // store the new message in DB
    const store_msg_result = await store_message_with_retry(payload, 5);
    if (!store_msg_result.success) {
      // send message is failed ack to the sender
      const failed_ack: ChatMessageAckPayload = {
        ...ack_message_payload,
        is_failed: true,
        error_code: store_msg_result.code || 500,
      };
      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: [payload.sender_id],
        message: {
          type: "message:ack",
          payload: failed_ack,
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

    const updated_message_payload: ChatMessagePayload = {
      ...payload,
      sender_name: payload.sender_name || String(user_name) || undefined,
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
    const sent_res_ack: ChatMessageAckPayload = {
      ...ack_message_payload,
      delivered_to: sent_result.online,
      read_by: sent_result.active_in_conv,
      offline_users: sent_result.offline,
    };

    // send ack to sender along with message delivery status
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: [payload.sender_id],
      message: {
        type: "message:ack",
        payload: sent_res_ack,
        ws_timestamp: new Date()
      },
    });

    // Create message statuses for all conversation members (except sender)
    if (store_msg_result.data) {
      const conv_members = await get_conversation_members(payload.conv_id);
      const message_statuses: Array<{ user_id: number; message_id: bigint; conv_id: number; delivered_at: Date | null; read_at: Date | null; }> = [];

      for (const member_id of conv_members) {
        if (member_id !== payload.sender_id) {

          // const is_member_online = socket_connections.has(member_id);
          // const is_member_in_conv = socket_connections.get(member_id)?.active_conv_id === member_id;

          message_statuses.push({
            user_id: member_id,
            message_id: store_msg_result.data.id,
            conv_id: payload.conv_id,
            delivered_at: sent_result.online.includes(member_id) ? new Date() : null,
            read_at: sent_result.active_in_conv.includes(member_id) ? new Date() : null,
          });
        }
      }

      // Batch insert message statuses for all recipients
      if (message_statuses.length > 0) {
        await batch_insert_message_status(message_statuses);
      }

      // Special handling for DMs: update message status in messages table
      if (payload.conv_type === "dm") {
        const copy_conv_member = [...conv_members];

        const reciepient_id = Array.from(copy_conv_member)[0] == payload.sender_id
          ? Array.from(copy_conv_member)[1]   // for DMs only
          : Array.from(copy_conv_member)[0];
        if (reciepient_id) {
          // update message status in messages table (for DMs)
          await db.update(message_model).set({
            status: sent_result.active_in_conv.includes(reciepient_id)
              ? "read"
              : sent_result.online.includes(reciepient_id)
                ? "delivered"
                : "sent"
          }).where(
            and(
              eq(message_model.id, store_msg_result.data.id),
              eq(message_model.conversation_id, payload.conv_id)
            )
          );
        }
      }

      const offline_and_inactive_users = new Set([...sent_result.offline, ...sent_result.online]);
      for (const user_id of offline_and_inactive_users) {
        // update conversation member model
        await db.update(conversation_member_model)
          .set({
            unread_count: sql`${conversation_member_model.unread_count} + 1`,
            last_delivered_message_id: sent_result.online.includes(user_id) || sent_result.active_in_conv.includes(user_id)
              ? store_msg_result.data.id
              : sql`${conversation_member_model.last_delivered_message_id}`,
            last_read_message_id: sent_result.active_in_conv.includes(user_id)
              ? store_msg_result.data.id
              : sql`${conversation_member_model.last_read_message_id}`,
          })
          .where(
            and(
              eq(conversation_member_model.conversation_id, payload.conv_id),
              eq(conversation_member_model.user_id, user_id)
            )
          );
      }
    }

    // update conversaion's last_message metadata and last_updated_at
    const res = await update_conversation({
      id: payload.conv_id,
      metadata: { last_message: store_msg_result?.data },
      last_message_at: new Date()
    });

    // send fcm notification to offline users
    // Convert bigint IDs to strings before sending to FCM (JSON.stringify cannot serialize BigInt)
    const fcm_ws_message: WSMessage = {
      type: "message:new",
      payload: updated_message_payload,
      ws_timestamp: new Date()
    };
    const serialized_fcm_message = convertBigIntToString(fcm_ws_message);

    // Queue each offline user's message into the batch (5s window / 4 msgs / 4KB)
    for (const user_id of sent_result.offline) {
      await queue_message_fcm(user_id, serialized_fcm_message);
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

const handle_message_forward = async (payload: MessageForwardPayload, username: string): Promise<ResultType> => {
  try {

    const forward_res = await forward_messages({
      message_ids: payload.forwarded_message_ids,
      source_conversation_id: payload.source_conv_id,
      target_conversation_ids: payload.target_conv_ids,
    }, payload.forwarder_id);

    if (forward_res.success && forward_res.data) {
      // Collect all message status records for batch insert
      const all_message_statuses: Array<{ user_id: number; message_id: bigint; conv_id: number; delivered_at: Date | null; read_at: Date | null; }> = [];

      // loop on all target conversations (use for...of to properly await)
      for (const [conv_id, all_msgs_for_conv] of forward_res.data.entries()) {

        // Get all members of this conversation for batch message status creation
        const conv_members = await get_conversation_members(conv_id);

        // loop on all forward message in that target conversation
        for (const msg of all_msgs_for_conv) {
          const new_chat_msg_payload: ChatMessagePayload = {
            id: msg.id,
            sender_id: msg.sender_id,
            sender_name: payload.forwarder_name || username ? String(username) : undefined,
            conv_id: conv_id,
            conv_type: msg.conv_type as ChatType,
            msg_type: msg.type,
            body: msg.body || undefined,
            attachments: msg.attachments,
            metadata: msg.metadata,
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
            exclude_user_ids: [payload.forwarder_id],
          });

          // Prepare message status records for all members except sender
          for (const member_id of conv_members) {
            if (member_id !== payload.forwarder_id) {

              const is_member_online = socket_connections.has(member_id);
              const is_member_in_conv = socket_connections.get(member_id)?.active_conv_id === member_id;

              all_message_statuses.push({
                user_id: member_id,
                message_id: msg.id,
                conv_id: conv_id,
                delivered_at: is_member_online ? new Date() : null,
                read_at: is_member_in_conv ? new Date() : null,
              });
            }
          }
        }

        // sort message based on sent_at, and extract the most recent message if sent_at is not present then sort based on message_id
        all_msgs_for_conv.sort((a, b) => {
          const dateA = a.sent_at ? new Date(a.sent_at).getTime() : 0;
          const dateB = b.sent_at ? new Date(b.sent_at).getTime() : 0;

          if (dateA !== dateB) {
            return dateA - dateB;
          } else {
            return Number(a.id) - Number(b.id);
          }
        });

        // update the message of conversation
        await update_conversation({
          id: conv_id,
          metadata: {
            last_message: all_msgs_for_conv[all_msgs_for_conv.length - 1]
          },
          last_message_at: new Date()
        });

      }

      // Batch insert all message statuses in ONE database call
      // This is MASSIVELY more efficient than individual inserts
      if (all_message_statuses.length > 0) {
        await batch_insert_message_status(all_message_statuses);
        console.log(`[WS] Batch inserted ${all_message_statuses.length} message statuses for forwarded messages`);
      }
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

const handle_call_init = async (payload: CallPayload, user_id: number, user_name?: string, user_pfp?: string): Promise<ResultType> => {
  try {
    // For call initiation, we typically just need to validate the payload and then the offer/answer/ice messages will be forwarded as is

    const result = await CallService.initiate_call(
      payload.caller_id || Number(user_id),
      payload.callee_id
    );

    // acknowledgment payload
    const call_init_payload: CallPayload = {
      call_id: result.data?.call_id,
      caller_id: payload.caller_id || Number(user_id),
      caller_name: payload.caller_name || String(user_name),
      caller_pfp: payload.caller_pfp || user_pfp,
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
        user_ids: [payload.caller_id || Number(user_id)],
        message: {
          type: "call:init:ack",
          payload: call_init_payload,
          ws_timestamp: new Date()
        },
      });

      // Send ringing to user, via WebSocket if online, and push notification if offline
      if (is_user_online(payload.callee_id)) {
        // send ringing websocket message
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
      else {
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

    }
    else {
      // Send error to caller
      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: [payload.caller_id || Number(user_id)],
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

const handle_call_signaling = async (payload: CallPayload, event_type: WSMessageEventsType, user_id: number): Promise<ResultType> => {

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
    let recipient_id: number;
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

const handle_call_accept = async (payload: CallPayload, user_id: number): Promise<ResultType> => {
  try {
    if (!payload.call_id) {
      console.error("call_id missing in call:accept payload");
      return {
        success: false,
        code: 400,
        message: "call_id missing in call:accept payload"
      };
    }

    const result = await CallService.accept_call(payload.call_id, user_id);

    const call_accept_payload: CallPayload = {
      call_id: payload.call_id,
      caller_id: payload.caller_id,
      callee_id: payload.callee_id,
      timestamp: new Date(),
    };
    if (result.success) {
      // Notify both parties
      const active_call = CallService.get_user_active_call(user_id);
      if (active_call) {
        // Notify caller
        // Acknowledge to callee
        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [payload.caller_id, payload.callee_id],
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
        user_ids: [payload.caller_id, payload.callee_id],
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
  user_id: number,
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


export {
  handle_connection_status,
  handle_conv_join_leave,
  handle_message_new,
  handle_message_forward,
  handle_call_init,
  handle_call_signaling,
  handle_call_accept,
  handle_call_termination,
};
