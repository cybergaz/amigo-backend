import { WebSocketData, WSMessage, ConnectionStatusPayload, JoinLeavePayload, ChatMessagePayload, WSMessageEventsType, ChatMessageAckPayload, TypingPayload, MessagePinPayload, MessageForwardPayload, MessageDeliveredPayload, DeleteMessagePayload, MiscPayload, VitalWSMessage, VITAL_WS_EVENTS_CONST, VitalWSMessageEventsType, CallPayload, ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD, type AllowedWSEventsWithoutPayloadType } from "@/types/socket.types";
import { ElysiaWS } from "elysia/dist/ws";
import { get_conversation_members, get_user_conversations } from "@/services/cache-management/socket.cache";
import { socket_connections, handlePongResponse, polling_connections } from "./socket.server";
import { store_pending_message_for_users, is_allowed_event, store_pending_message } from "@/services/cache-management/polling.cache";
import db from "@/config/db";
import { conversation_member_model, message_model, message_status_model } from "@/models/chat.model";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { handle_call_accept, handle_call_init, handle_call_signaling, handle_call_termination, handle_connection_status, handle_conv_join_leave, handle_message_new } from "./socket.service";
import { pin_message, unpin_message, mark_message_delivered } from "@/services/message.services";
import { convertBigIntToString, convertStringToBigInt } from "@/utils/serialization.utils";

// Generate unique message ID for polling
let polling_message_counter = 0;
function generateMessageId(): string {
  polling_message_counter++;
  return `${Date.now()}-${polling_message_counter}`;
}

const set_ws_data = (ws: ElysiaWS, data: WebSocketData) => {
  Object.assign(ws.data, data);
};

const get_ws_data = (ws: ElysiaWS, key: keyof WebSocketData) => {
  return (ws.data as WebSocketData)[key];
};

const is_user_online = (user_id: number): boolean => {
  // Check WebSocket connections
  const ws_connection = socket_connections.get(user_id);
  if (ws_connection && ws_connection.ws.readyState === 1) {
    return true;
  }
  return false;
};

type BroadcastData = {
  to: "conversation" | "users",
  conv_id?: number,
  user_ids?: number[],
  message: WSMessage,
  exclude_user_ids?: number[];
};

const broadcast_message = async (data: BroadcastData) => {
  let members: number[] = [];
  if (data.to === "conversation" && data.conv_id) {
    // Get conversation members (LRU -> Redis -> DB)
    members = Array.from(await get_conversation_members(data.conv_id));
  }

  // sent to both specific users and conversation members (if both conv_id & user_ids are provided)
  let recipients_list = [...members];
  if (data.user_ids) {
    recipients_list = data.user_ids;
  }

  const active_in_conv: Set<number> = new Set<number>();
  const online_users_id: Set<number> = new Set<number>();
  const offline_users_id: Set<number> = new Set<number>();
  const polling_users_id: Set<number> = new Set<number>();

  // console.log("all ws connections:", socket_connections)

  // Separate online and offline users across all transport types
  recipients_list.forEach(async user_id => {
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
      if (data.conv_id && ws_connection.active_conv_id === data.conv_id) {
        // User is active in the conversation 
        active_in_conv.add(user_id);
      }

      // Send message immediately via WebSocket
      try {
        // Convert bigint IDs to strings before sending (JSON.stringify cannot serialize BigInt)
        const messageToSend = convertBigIntToString(data.message);

        ws_connection.ws.send(messageToSend, true);
      } catch (error) {
        console.error(`[WS] Error sending to user ${user_id}:`, error);
      }

      // store every message as missed_ws_message and remove upon recieving delivery reciept from client
      // return;
    }

    else if (poll_connection) {
      if (poll_connection.last_poll) {
        const timeSinceLastPoll = Date.now() - poll_connection.last_poll.getTime();
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
      await store_pending_message(
        user_id,
        data.message as VitalWSMessage,
      ).then(() => {
        // console.log("stored in missed_ws_message ", data.message.type);
      }).catch(err => {
        console.error("[BROADCAST] Error storing pending messages for offline users:", err);
      });
    }
  });

  return {
    online: Array.from(online_users_id),
    offline: Array.from(offline_users_id),
    polling: Array.from(polling_users_id),
    active_in_conv: Array.from(active_in_conv),
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

    // Capture unread messages BEFORE marking them read, so we can push real read receipts to senders
    const unread_messages = await db
      .select({ message_id: message_status_model.message_id, sender_id: message_model.sender_id })
      .from(message_status_model)
      .innerJoin(message_model, eq(message_status_model.message_id, message_model.id))
      .where(
        and(
          eq(message_status_model.conv_id, conv_id),
          eq(message_status_model.user_id, user_id),
          isNull(message_status_model.read_at),
          ne(message_model.sender_id, user_id),
        )
      );

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
      );

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

    // Push real read receipts to senders so they can correct optimistic pre-fills
    // Group messages by sender and push message:ack with read_by=[user_id] to each unique sender
    if (unread_messages.length > 0) {
      const now = new Date();
      // Group latest message ID per sender (client marks all earlier messages read on single ack)
      const latest_per_sender = new Map<number, bigint>();
      for (const row of unread_messages) {
        latest_per_sender.set(row.sender_id, row.message_id);
      }

      for (const [sender_id, message_id] of latest_per_sender) {
        const ack_payload: ChatMessageAckPayload = {
          id: message_id,
          conv_id,
          sender_id,
          delivered_at: now,
          read_by: [user_id],
          delivered_to: [],
          offline_users: [],
        };
        await broadcast_message({
          to: "users",
          user_ids: [sender_id],
          message: {
            type: "message:ack",
            payload: ack_payload,
            ws_timestamp: now,
          },
        });
      }
    }

  }
  catch (error) {
    console.error("[WS] Error in handle_join_conversation:", error);
  }
};

const socket_message_handler = async (user_details: {
  user_id?: number,
  user_name?: string;
  user_pfp?: string;
}, message: WSMessage) => {
  const user_id = user_details.user_id || 0; // Default to 0 if user_id is missing, but ideally should not happen due to authentication middleware
  const user_name = user_details.user_name || "Unknown User";
  const user_pfp = user_details.user_pfp || "";

  if (!user_id) {
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: [Number(user_id)],
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

    // Convert string IDs to bigint after validation (before processing)
    if (message.payload) {
      message.payload = convertStringToBigInt(message.payload);
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
              user_ids: [Number(user_id)],
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
      case 'conversation:leave':
        // --------------------------------------------------
        {
          const result = await handle_conv_join_leave(message.payload as JoinLeavePayload, message.type);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [Number(user_id)],
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
      case 'message:new':
        // --------------------------------------------------
        {
          // console.log('recieved message new');
          // console.log(message.payload);
          // // ID is now bigint after conversion
          // console.log('message id type:', typeof (message.payload as any).id);
          // console.log('message id value:', (message.payload as any).id?.toString());

          const result = await handle_message_new(message.payload as ChatMessagePayload, user_name);
          // console.log("result -> ", result);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [Number(user_id)],
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


      // // ----------------------------------------------------
      // case 'message:forward':
      //   // --------------------------------------------------
      //   {
      //     const result = await handle_message_forward(message.payload as MessageForwardPayload, user_name)
      //     if (!result.success) {
      //       // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      //       await broadcast_message({
      //         to: "users",
      //         user_ids: [Number(user_id)],
      //         message: {
      //           type: "socket:error",
      //           payload: {
      //             code: result.code || 500,
      //             message: result.message || "Error handling new message",
      //             error: result.error
      //           },
      //           ws_timestamp: new Date()
      //         }
      //       })
      //     }
      //     break;
      //   }


      // ----------------------------------------------------
      case 'message:delivered':
        // --------------------------------------------------
        {
          // Real delivery receipt from recipient's device
          // This reconciles the optimistic pre-fill ACK with ground truth
          if (message.payload) {
            const payload = message.payload as MessageDeliveredPayload;
            await mark_message_delivered(
              payload.message_id,
              payload.conv_id,
              payload.recipient_id,
            );
          } else {
            console.error('[WS] message:delivered payload missing');
          }
          break;
        }


      // ----------------------------------------------------
      case 'call:init':
        // --------------------------------------------------
        {
          const result = await handle_call_init(message.payload as CallPayload, user_id, user_name, user_pfp);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [Number(user_id)],
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
              user_ids: [Number(user_id)],
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
              user_ids: [Number(user_id)],
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
      case 'call:terminate':
        // --------------------------------------------------
        {
          const result = await handle_call_termination(message.payload as CallPayload, message.type, user_id);
          if (!result.success) {
            // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
            await broadcast_message({
              to: "users",
              user_ids: [Number(user_id)],
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
      case 'socket:health_check':
        // --------------------------------------------------
        {
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: [Number(user_id)],
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
            user_ids: [Number(user_id)],
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
            user_ids: [Number(user_id)],
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
      user_ids: [Number(user_id)],
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
  get_connected_users,
  handle_join_conversation,
  socket_message_handler,
  // convertBigIntIdsToString,
  // convertStringIdsToBigInt,
  // convertStringIdsToBigIntForWSMessage
};
