import { WebSocketData, WSMessage, ConnectionStatusPayload, ChatMessagePayload, TypingPayload, MessagePinPayload, MessageForwardPayload, VitalWSMessage, CallPayload, ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD, type AllowedWSEventsWithoutPayloadType, ConvJoinPayload, MessageStatusAckPayload } from "@/types/socket.types";
import { ElysiaWS } from "elysia/dist/ws";
import { get_conversation_members, get_user_conversations } from "@/cache-management/conv.cache";
import { socket_connections, handlePongResponse, polling_connections } from "./socket.server";
import { is_allowed_event, store_pending_message } from "@/cache-management/polling.cache";
import { handle_call_accept, handle_call_init, handle_call_signaling, handle_call_termination, handle_call_hold, handle_call_rejoin_open, handle_call_rejoin_resolved, handle_connection_status, handle_message_forward, handle_message_new, handle_conv_join, handle_conv_mark_read, handle_message_status_ack, } from "./socket.service";
import { pin_message, unpin_message } from "@/services/message.services";
import { mark_message_delivered } from "@/services/message-status.service";
import { batch_mark_status } from "@/cache-management/message.cache";
import db from "@/config/db";
import { message_model } from "@/models/message.model";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const set_ws_data = (ws: ElysiaWS, data: WebSocketData) => {
  Object.assign(ws.data, data);
};

const get_ws_data = (ws: ElysiaWS, key: keyof WebSocketData) => {
  return (ws.data as WebSocketData)[key];
};

const is_user_online = (user_id: string): boolean => {
  // Check WebSocket connections
  const ws_connection = socket_connections.get(user_id);
  if (ws_connection && ws_connection.ws.readyState === 1) {
    return true;
  }
  return false;
};

type BroadcastData = {
  to: "conversation" | "users",
  conv_id?: string,
  user_ids?: string[],
  message: WSMessage,
  exclude_user_ids?: string[];
};

const broadcast_message = async (data: BroadcastData) => {
  let members: string[] = [];
  if (data.to === "conversation" && data.conv_id) {
    // Get conversation members (LRU -> Redis -> DB)
    members = Array.from(await get_conversation_members(data.conv_id));
  }

  // sent to both specific users and conversation members (if both conv_id & user_ids are provided)
  // Filter out falsy ids defensively — callers sometimes coerce a nullable
  // sender_id to "" before passing it in (system messages have sender_id=NULL),
  // and "" downstream lands in the uuid-typed missed_ws_messages.user_id and
  // crashes the worker.
  let recipients_list = Array.from(new Set([...members, ...(data.user_ids ? data.user_ids : [])])).filter(Boolean);
  // if (data.user_ids) {
  //   recipients_list = recipients_list.concat(data.user_ids);
  // }

  // const active_in_conv: Set<string> = new Set<string>();
  const online_users_id: Set<string> = new Set<string>();
  const offline_users_id: Set<string> = new Set<string>();
  const polling_users_id: Set<string> = new Set<string>();
  // Subset of online_users_id whose client has reported it is backgrounded.
  // These users still receive the live WS frame (they remain in online_users_id
  // so presence/unread behaviour is unchanged), but they are ALSO eligible for
  // an FCM push. Only handle_message_new consumes this set — every other caller
  // ignores it, so non-message events (typing, acks, ...) are never pushed.
  const background_users_id: Set<string> = new Set<string>();

  // console.log("all ws connections:", socket_connections)

  const serialized_payload = JSON.stringify(data.message);

  // Separate online and offline users across all transport types
  // console.log("recipients_list : ", recipients_list);
  // console.log("data : ", data);
  await Promise.all(recipients_list.map(async user_id => {
    if (data.exclude_user_ids && data.exclude_user_ids.includes(user_id)) {
      return; // Skip excluded users
    }

    // Check WebSocket connections
    const ws_connection = socket_connections.get(user_id);
    // check polling connections for users who are not connected via WebSocket
    const poll_connection = polling_connections.get(user_id);

    if (ws_connection && ws_connection.ws.readyState === 1) {
      // User is online via WebSocket
      online_users_id.add(user_id);
      // Backgrounded clients keep a live WS (so we still send the frame below),
      // but the OS may have frozen the socket, so they ALSO need a push. Flag
      // them so handle_message_new queues FCM in addition to the WS frame.
      if (ws_connection.is_background) {
        background_users_id.add(user_id);
      }
      // if (data.conv_id && ws_connection.active_conv_id === data.conv_id) {
      //   // User is active in the conversation
      //   active_in_conv.add(user_id);
      // }

      // Send message immediately via WebSocket
      try {
        ws_connection.ws.send(serialized_payload, true);
      } catch (error) {
        console.error(`[WS] Error sending to user ${user_id}:`, error);
      }

      // store every message as missed_ws_message and remove upon recieving delivery reciept from client
      // return;
    }

    else if (poll_connection) {
      if (poll_connection.last_poll_at) {
        const timeSinceLastPoll = Date.now() - poll_connection.last_poll_at.getTime();
        // Consider users with a poll in the last 10 seconds as online for polling transport
        if (timeSinceLastPoll < 10000) {
          polling_users_id.add(user_id);
        }
        // remove the stale polling connections
        polling_connections.delete(user_id);
      }

      // don't return as we yet to store message for polling users
      // return;
    } else {
      // User is offline
      offline_users_id.add(user_id);
    }

    // Store missed messages in three-tier polling cache for offline users
    // Only allowed event types are cached (message:new, conversation:new, etc.)
    if (is_allowed_event(data.message.type)) {
      try {
        await store_pending_message(user_id, data.message as VitalWSMessage);
      } catch (err) {
        console.error("[BROADCAST] Error storing pending messages for offline users:", err);
      }
    }
  }));

  return {
    online: Array.from(online_users_id),
    offline: Array.from(offline_users_id),
    polling: Array.from(polling_users_id),
    background: Array.from(background_users_id),
    // active_in_conv: Array.from(active_in_conv),
  };
};

const socket_message_handler = async (
  user_details: {
    user_id?: string,
    user_name?: string;
    // user_pfp?: string;
  },
  message: WSMessage
) => {
  const user_id = user_details.user_id || "";
  const user_name = user_details.user_name || "Unknown User";
  // const user_pfp = user_details.user_pfp || "";

  if (!user_id) {
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: [user_id],
      message: {
        type: "socket:error",
        payload: {
          message: "Unauthorized: User ID not found in connection",
          code: 4001,
        },
        ws_timestamp: new Date()
      },
    });
    return;
  }

  try {

    // Basic validation
    if (!message.payload && (!ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD.includes(message.type as AllowedWSEventsWithoutPayloadType))) {
      console.error(`[WS] Message payload missing for type ${message.type}`);
    }

    // Handle incoming messages
    switch (message.type) {

      // ----------------------------------------------------
      case 'connection:status':
        // --------------------------------------------------
        {
          const result = await handle_connection_status(message.payload as ConnectionStatusPayload);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error updating connection status",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }

      // ----------------------------------------------------
      case 'conversation:join':
        // case 'conversation:leave':
        // --------------------------------------------------
        {
          const result = await handle_conv_join(message.payload as ConvJoinPayload, message.ws_timestamp);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error handling conversation join/leave",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }


      // ----------------------------------------------------
      case 'conversation:mark_read':
        // --------------------------------------------------
        {
          const result = await handle_conv_mark_read(message.payload as ConvJoinPayload, message.ws_timestamp);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error handling conversation mark-read",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }


      // ----------------------------------------------------
      case 'conversation:typing':
        // --------------------------------------------------
        {
          const payload = message.payload as TypingPayload;

          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "conversation",
            conv_id: payload.conv_id,
            message: {
              type: "conversation:typing",
              payload: payload,
              ws_timestamp: new Date()
            },
            exclude_user_ids: [payload.sender_id],
          });

          break;
        }


      // ----------------------------------------------------
      case 'message:new':
        // --------------------------------------------------
        {
          const result = await handle_message_new(message.payload as ChatMessagePayload, user_name);
          // console.log("result -> ", result);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error handling new message",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }

      // ----------------------------------------------------
      case 'message:status:ack':
        // --------------------------------------------------
        {
          const result = await handle_message_status_ack(message.payload as MessageStatusAckPayload, user_id, message.ws_timestamp);
          // console.log("result -> ", result);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error handling message status ack",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }


      // ----------------------------------------------------
      case 'message:pin':
        // --------------------------------------------------
        {
          const payload = message.payload as MessagePinPayload;

          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "conversation",
            conv_id: payload.conv_id,
            message: {
              type: "message:pin",
              payload: payload,
              ws_timestamp: new Date()
            },
            exclude_user_ids: [payload.sender_id],
          });

          const pin_data = {
            conv_id: payload.conv_id,
            message_id: payload.message_id,
            user_id: payload.sender_id
          };
          // update in DB
          if (payload.pin) await pin_message(pin_data);
          else await unpin_message(pin_data);

          break;
        }


      // ----------------------------------------------------
      case 'message:forward':
        // --------------------------------------------------
        {
          const result = await handle_message_forward(message.payload as MessageForwardPayload, user_name);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error handling new message",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }


      // ----------------------------------------------------
      case 'call:init':
        // --------------------------------------------------
        {
          const result = await handle_call_init(
            message.payload as CallPayload,
            user_id,
            user_name,
            // user_pfp
          );
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error initiating call init",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }

      // Forward WebRTC signaling between caller and callee
      // ----------------------------------------------------
      case 'call:offer':
      case 'call:answer':
      case 'call:ice':
        // --------------------------------------------------
        {
          const result = await handle_call_signaling(message.payload as CallPayload, message.type, user_id);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error handling call signaling",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }

      // ----------------------------------------------------
      case 'call:accept':
        // --------------------------------------------------
        {
          const result = await handle_call_accept(message.payload as CallPayload, user_id);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error accepting call",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }

      // ----------------------------------------------------
      case 'call:hold':
        // --------------------------------------------------
        {
          const result = await handle_call_hold(message.payload as CallPayload, user_id);
          if (!result.success) {
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: { code: result.code || 500, message: result.message || "Error handling call:hold", error: result.error },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }

      // ----------------------------------------------------
      case 'call:terminate':
        // --------------------------------------------------
        {
          const result = await handle_call_termination(message.payload as CallPayload, message.type, user_id);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || "Error terminating call",
                  error: result.error
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }

      // ----------------------------------------------------
      case 'call:rejoin:open':
      case 'call:rejoin:resolved':
        // --------------------------------------------------
        {
          const result = message.type === 'call:rejoin:open'
            ? await handle_call_rejoin_open(message.payload as CallPayload, user_id)
            : await handle_call_rejoin_resolved(message.payload as CallPayload, user_id);
          if (!result.success) {
            await broadcast_message({
              to: "users",
              user_ids: [user_id],
              message: {
                type: "socket:error",
                payload: {
                  code: result.code || 500,
                  message: result.message || `Error handling ${message.type}`,
                  error: result.error,
                },
                ws_timestamp: new Date()
              }
            });
          }
          break;
        }


      // ----------------------------------------------------
      case 'socket:health_check':
        // --------------------------------------------------
        {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:health_check",
              payload: {
                message: "Connection is healthy",
                code: 1,
              },
              ws_timestamp: new Date()
            },
          });
          break;
        }

      // ----------------------------------------------------
      case 'socket:ping':
        // --------------------------------------------------
        {
          // Client sent ping, respond with pong
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:pong",
              ws_timestamp: new Date()
            },
          });

          break;
        }

      // ----------------------------------------------------
      case 'socket:pong':
        // --------------------------------------------------
        {
          // Client responded to our ping - reset missed ping counter
          handlePongResponse(user_id);
          break;
        }

      default:
        {
          console.warn(`[WS] Unhandled message type: ${message.type}`);
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [user_id],
            message: {
              type: "socket:error",
              payload: {
                message: `Unhandled message type: ${message.type}`,
                code: 1006,
              },
              ws_timestamp: new Date()
            },
          });
          break;
        }
    }

  } catch (error) {
    console.error('[WS] Error processing message:', error);
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: [user_id],
      message: {
        type: "socket:error",
        payload: {
          message: "Error processing your message",
          code: 1007,
          error: error as any
        },
        ws_timestamp: new Date()
      },
    });
  }
};

export {
  set_ws_data,
  get_ws_data,
  is_user_online,
  broadcast_message,
  // get_connected_users,
  // handle_join_conversation,
  socket_message_handler,
  // convertBigIntIdsToString,
  // convertStringIdsToBigInt,
  // convertStringIdsToBigIntForWSMessage
};
