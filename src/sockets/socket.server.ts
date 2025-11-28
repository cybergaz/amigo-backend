import db from "@/config/db";
import { authenticate_jwt } from "@/middleware";
import { user_model } from "@/models/user.model";
import { WSMessageSchema } from "@/types/socket.elysia-schema";
import { JoinLeavePayload, MiscPayload, ConnectionStatusPayload, UserConnection, ChatMessagePayload, TypingPayload, ChatMessageAckPayload, MessageForwardPayload, MessagePinPayload } from "@/types/socket.types";
import { and, eq, sql, isNull } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { broadcast_message, get_connected_users, get_ws_data, handle_join_conversation, set_ws_data } from "./socket.handlers";
import { update_user_connection_status, update_user_details } from "@/services/user.services";
import { pin_message, unpin_message, store_message, forward_messages, batch_insert_message_status } from "@/services/message.services";
import { update_conversation } from "@/services/chat.services";
import { ChatType } from "@/types/chat.types";
import { get_conversation_members } from "./socket.cache";
import { conversation_member_model, message_model, message_status_model } from "@/models/chat.model";
import FCMService from "@/services/fcm.service";
import { CallService } from "@/services/call.service";

const socket_connections = new Map<number, UserConnection>(); // user_id -> UserConnection

const send_to_user = async (user_id: number, message: any) => {
  const connection = socket_connections.get(user_id);
  if (connection && connection.ws.readyState === 1) {
    connection.ws.send(JSON.stringify(message));
    console.log(`[WS] Sent message to user ${user_id}:`, message);
    return true
  }
  return false
}

// WebSocket server
const web_socket_server = new Elysia()
  .onError(({ error, path }) => {
    const err = error as any
    switch (err.code) {
      case "NOT_FOUND":
        console.error("[SOCKET] WebSocket server endpoint not found");
        return { type: "socket:error", message: "WebSocket endpoint not found" };

      case "VALIDATION":
        console.error("[SOCKET] WebSocket server validation error at", path);
        return {
          type: "socket:error",
          message: "WebSocket validation error",
          error: {
            expected: err.expected,
            received: err.value,
            valueError: {
              field: err.valueError?.path,
              message: err.valueError?.message,
            }
          },
        };

      case "INTERNAL_SERVER_ERROR":
        console.error("[SOCKET] WebSocket server internal server error");
        return { type: "socket:error", message: "WebSocket internal server error" };
    }
  })

  .ws('/chat', {
    // temporarily skipping schema validation
    // body: WSMessageSchema,
    body: t.Any(),
    query: t.Object({ token: t.String() }),

    error: ({ error }) => {
      const err = error as any
      switch (err.code) {
        case "VALIDATION":
          console.error("[SOCKET] Validation error:", {
            expected: err.expected,
            received: err.value,
            valueError: {
              field: err.valueError?.path,
              message: err.valueError?.message,
            }
          });
          return {
            type: "socket:error",
            message: "WebSocket validation error",
            error: {
              expected: err.expected,
              received: err.value,
              valueError: {
                field: err.valueError?.path,
                message: err.valueError?.message,
              }
            }
          };
      }
    },

    open: async (ws) => {
      try {
        // Extract and validate JWT token
        const url = new URL(ws.data.request.url);
        const token = url.searchParams.get('token');

        // console.log("request came for connection")
        // console.log("token -> ", token)

        if (!token) {
          ws.send({
            type: 'socket:error',
            message: 'Authentication token is required',
            timestamp: new Date().toISOString()
          }, true);
          ws.close(4001, "Missing authentication token");
          return;
        }

        // Verify JWT token
        const auth_result = authenticate_jwt(token);
        if (!auth_result.success || !auth_result.data) {
          ws.close(4001, "Invalid authentication token");
          return;
        }

        // Store user_id in WebSocket data using type-safe helper
        const user_id = auth_result.data.id;
        set_ws_data(ws, { user_id });

        const user_name = (await db
          .select({ name: user_model.name })
          .from(user_model)
          .where(eq(user_model.id, user_id))
          .limit(1))[0]?.name;

        // insert user_name into WebSocket data using type-safe helper
        set_ws_data(ws, { user_name });

        // Add to active socket connections
        socket_connections.set(user_id, {
          ws,
          connection_status: "foreground"
        });

        // notify all connected users about this user being online
        const connected_users = await get_connected_users(user_id);

        const message_payload: ConnectionStatusPayload = {
          sender_id: user_id,
          status: 'foreground',
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
          exclude_user_ids: [user_id]
        });

        console.log(`[WS] User ${user_id} connected. Total connections: ${socket_connections.size}`);

        // update the online status of user in the DB
        await update_user_details(user_id, { online_status: true, connection_status: "foreground", last_seen: new Date() });

        // mark as delivered all undelivered messages for this user
        await db
          .update(message_status_model)
          .set({ delivered_at: new Date() })
          .where(
            and(
              eq(message_status_model.user_id, user_id),
              isNull(message_status_model.delivered_at)
            )
          );

      } catch (error) {
        console.error('[WS] Error in establishing connection:', error);
        ws.close(4000, "Connection error");
      }

    },

    message: async (ws, message) => {
      const user_id = Number(get_ws_data(ws, "user_id"));
      const user_name = String(get_ws_data(ws, "user_name"));
      const user_pfp = String(get_ws_data(ws, "user_pfp"));

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
        })
        return
      }

      try {
        // Handle incoming messages 
        switch (message.type) {

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'connection:status':
            if (message.payload) {
              const payload = message.payload as ConnectionStatusPayload;

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
            }
            else {
              console.error('[WS] connection:status payload missing');
            }
            break;

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'conversation:join':
          case 'conversation:leave':
            if (message.payload) {
              const payload = message.payload as JoinLeavePayload;

              // update active_conv_id in socket_connections map
              const sock_conn = socket_connections.get(payload.user_id)
              if (sock_conn) {
                message.type === 'conversation:join'
                  ? sock_conn.active_conv_id = payload.conv_id
                  : sock_conn.active_conv_id = undefined
              }

              if (message.type === 'conversation:join') {
                await handle_join_conversation({
                  conv_id: payload.conv_id,
                  user_id: payload.user_id,

                  // is_active_in_conv: socket_connections.get(payload.user_id)?.active_conv_id === payload.conv_id
                })
              }

              // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
              await broadcast_message({
                to: "conversation",
                conv_id: payload.conv_id,
                message: {
                  type: message.type,
                  payload: payload,
                  ws_timestamp: new Date()
                },
                exclude_user_ids: [payload.user_id]
              });
            }
            else {
              console.error('[WS] conversation:join/leave payload missing');
            }
            break;

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'message:new':
            if (message.payload) {
              const payload = message.payload as ChatMessagePayload;

              const stored_message = await store_message(payload)
              if (!stored_message?.success) break;

              const new_message_payload: ChatMessagePayload = {
                ...payload,
                canonical_id: stored_message?.data?.id,
                sender_name: payload.sender_name || String(user_name) || undefined,
              }

              // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
              const sent_result = await broadcast_message({
                to: "conversation",
                conv_id: payload.conv_id,
                message: {
                  type: "message:new",
                  payload: new_message_payload,
                  ws_timestamp: new Date()
                },
                exclude_user_ids: [payload.sender_id]
              });

              // const gg = ws.send({
              //   type: "message:new",
              //   payload: new_message_payload,
              //   ws_timestamp: new Date()
              // });
              // console.log("gg -> ", gg)
              // console.log("sent_status -> ", sent_result)

              // const is_sender_online = socket_connections.has(payload.sender_id);
              // const is_sender_in_conv = socket_connections.get(payload.sender_id)?.active_conv_id === payload.conv_id;
              const ack_message_payload: ChatMessageAckPayload = {
                optimistic_id: payload.optimistic_id,
                canonical_id: stored_message?.data?.id!,
                conv_id: payload.conv_id,
                // msg_status: !is_sender_online ? "sent" : is_sender_in_conv ? "read" : "delivered",
                sender_id: payload.sender_id,
                delivered_at: new Date(),
                delivered_to: sent_result.online,
                read_by: sent_result.active_in_conv,
                offline_users: sent_result.offline,
              }
              // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
              await broadcast_message({
                to: "users",
                user_ids: [payload.sender_id],
                message: {
                  type: "message:ack",
                  payload: ack_message_payload,
                  ws_timestamp: new Date()
                },
              });

              // Create message statuses for all conversation members (except sender)
              if (stored_message.data) {
                const conv_members = await get_conversation_members(payload.conv_id);
                const message_statuses: Array<{ user_id: number; message_id: number; conv_id: number; delivered_at: Date | null; read_at: Date | null }> = [];

                for (const member_id of conv_members) {
                  if (member_id !== payload.sender_id) {

                    // const is_member_online = socket_connections.has(member_id);
                    // const is_member_in_conv = socket_connections.get(member_id)?.active_conv_id === member_id;

                    message_statuses.push({
                      user_id: member_id,
                      message_id: stored_message.data.id,
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
                if (conv_members.size === 2) {
                  const copy_conv_member = [...conv_members];

                  const reciepient_id = Array.from(copy_conv_member)[0] == payload.sender_id
                    ? Array.from(copy_conv_member)[1]   // for DMs only
                    : Array.from(copy_conv_member)[0]
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
                        eq(message_model.id, stored_message.data.id),
                        eq(message_model.conversation_id, payload.conv_id)
                      )
                    )
                  }
                }

                const offline_and_inactive_users = new Set([...sent_result.offline, ...sent_result.online]);
                for (const user_id of offline_and_inactive_users) {
                  // insert into missed_messages table
                  await db.update(conversation_member_model)
                    .set({
                      unread_count: sql`${conversation_member_model.unread_count} + 1`,
                      last_delivered_message_id: sent_result.online.includes(user_id) || sent_result.active_in_conv.includes(user_id)
                        ? stored_message.data.id
                        : sql`${conversation_member_model.last_delivered_message_id}`,
                      last_read_message_id: sent_result.active_in_conv.includes(user_id)
                        ? stored_message.data.id
                        : sql`${conversation_member_model.last_read_message_id}`,
                    })
                    .where(
                      and(
                        eq(conversation_member_model.conversation_id, payload.conv_id),
                        eq(conversation_member_model.user_id, user_id)
                      )
                    )
                }
              }

              // update conversaion's last_message metadata and last_updated_at
              await update_conversation({
                id: payload.conv_id,
                metadata: { last_message: stored_message?.data },
                last_message_at: new Date()
              })

              // send fcm notification to offline users
              await FCMService.sendBulkMessageNotifications(
                sent_result.offline,
                new_message_payload
              );
            }
            else {
              console.error('[WS] message:new payload missing');
            }
            break;

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'conversation:typing':
            // ----------------------------------------------------------------------------
            if (message.payload) {
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
              })
            } else {
              console.error('[WS] conversation:typing payload missing');
            }
            break;

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'message:pin':
            if (message.payload) {
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
              })

              // update in DB
              if (payload.pin) {
                await pin_message({
                  conv_id: payload.conv_id,
                  message_id: payload.message_id,
                  user_id: payload.sender_id
                });
              } else {
                await unpin_message({
                  conv_id: payload.conv_id,
                  message_id: payload.message_id,
                  user_id: payload.sender_id
                });
              }
            } else {
              console.error('[WS] conversation:typing payload missing');
            }
            break;

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'message:forward':
            if (message.payload) {
              const payload = message.payload as MessageForwardPayload;

              const forward_res = await forward_messages({
                message_ids: payload.forwarded_message_ids,
                source_conversation_id: payload.source_conv_id,
                target_conversation_ids: payload.target_conv_ids,
              }, payload.forwarder_id)



              if (forward_res.success && forward_res.data) {

                // Collect all message status records for batch insert
                const all_message_statuses: Array<{ user_id: number; message_id: number; conv_id: number; delivered_at: Date | null; read_at: Date | null }> = [];

                // loop on all target conversations (use for...of to properly await)
                for (const [conv_id, all_msgs_for_conv] of forward_res.data.entries()) {

                  // Get all members of this conversation for batch message status creation
                  const conv_members = await get_conversation_members(conv_id);

                  // loop on all forward message in that target conversation
                  for (const msg of all_msgs_for_conv) {

                    const new_chat_msg_payload: ChatMessagePayload = {
                      optimistic_id: 0,
                      canonical_id: msg.id,
                      sender_id: msg.sender_id,
                      sender_name: payload.forwarder_name || user_name ? String(user_name) : undefined,
                      conv_id: conv_id,
                      conv_type: msg.conv_type as ChatType,
                      msg_type: msg.type,
                      body: msg.body || undefined,
                      attachments: msg.attachments,
                      metadata: msg.metadata,
                      sent_at: msg.sent_at ? msg.sent_at : new Date(),
                    }

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
                    })

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
                      return (a.id || 0) - (b.id || 0);
                    }
                  });

                  // update the message of conversation
                  await update_conversation({
                    id: conv_id,
                    metadata: {
                      last_message: all_msgs_for_conv[all_msgs_for_conv.length - 1]
                    },
                    last_message_at: new Date()
                  })

                }

                // Batch insert all message statuses in ONE database call
                // This is MASSIVELY more efficient than individual inserts
                if (all_message_statuses.length > 0) {
                  await batch_insert_message_status(all_message_statuses);
                  console.log(`[WS] Batch inserted ${all_message_statuses.length} message statuses for forwarded messages`);
                }
              }

            } else {
              console.error('[WS] conversation:typing payload missing');
            }
            break;


          case 'socket:health_check':
            if (message.payload) {
              const payload = message.payload as MiscPayload;
              console.log("payload -> ", payload)

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
              })
            }
            break;

          case 'ping':
            console.log(`[WS] Received ping from user ${user_id}`);
            // Respond with pong
            ws.send({
              type: 'pong',
              timestamp: new Date().toISOString()
            }, true);
            break;


          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // TEMPORARY CALL IMPLEMENTATION
          // --------------------------------------------------------------------

          // Call signaling handlers
          case 'call:init':
            if (message.to && message.payload) {
              // console.log(`[WS] Processing call:init from ${user_id} to ${message.to}`);
              // console.log(`[WS] Current connections: ${Array.from(connections.keys())}`);
              // console.log(`[WS] Target user ${message.to} connected: ${connections.has(message.to)}`);

              const result = await CallService.initiate_call(Number(user_id), message.to, message.payload);

              if (result.success) {
                const callId = result.data?.callId;
                // console.log(`[WS] Call initiation successful, callId: ${callId}`);

                // Send acknowledgment to caller
                const ackSent = await send_to_user(user_id, {
                  type: 'call:init',
                  callId,
                  from: user_id,
                  to: message.to,
                  data: { success: true, callId },
                  timestamp: new Date().toISOString()
                });
                // console.log(`[WS] Ack sent to caller ${user_id}: ${ackSent}`);

                // Send incoming call notification to callee
                const ringSent = await send_to_user(message.to, {
                  type: 'call:ringing',
                  callId,
                  from: user_id,
                  to: message.to,
                  payload: message.payload,
                  timestamp: new Date().toISOString()
                });

                // Send push notification if user is offline
                if (!ringSent) {
                  try {
                    // Get caller details for notification
                    const caller = await db
                      .select({ name: user_model.name, profile_pic: user_model.profile_pic })
                      .from(user_model)
                      .where(eq(user_model.id, user_id))
                      .limit(1);

                    const callerName = caller[0]?.name || 'Unknown';
                    const callerProfilePic = caller[0]?.profile_pic!;

                    await FCMService.sendCallNotification(message.to, {
                      callId: callId!.toString(),
                      callerId: user_id.toString(),
                      callerName,
                      callerProfilePic,
                      callType: message.payload?.callType || 'audio',
                    });
                  } catch (error) {
                    console.error(`[WS] Error sending call push notification:`, error);
                  }
                }
                // console.log(`[WS] Ring sent to callee ${message.to}: ${ringSent}`);
                //
                // console.log(`[WS] Call init complete: ${callId} from ${user_id} to ${message.to}`);
              } else {
                // console.log(`[WS] Call initiation failed: ${result.error} (${result.code})`);
                // Send error to caller
                await send_to_user(user_id, {
                  type: 'error',
                  data: { message: result.error, code: result.code },
                  timestamp: new Date().toISOString()
                });
              }
            } else {
              console.log(`[WS] Invalid call:init message - missing to or payload`);
            }
            break;

          case 'call:offer':
          case 'call:answer':
          case 'call:ice':
            // Forward WebRTC signaling between caller and callee
            console.log(`[WS] Received ${message.type} from ${user_id} to ${message.to} for call ${message.callId}`);
            if (message.callId && message.to && message.payload) {
              await send_to_user(message.to, {
                type: message.type,
                callId: message.callId,
                from: user_id,
                to: message.to,
                payload: message.payload,
                timestamp: new Date().toISOString()
              });

              // console.log(`[WS] Forwarded ${message.type} for call ${message.callId}`);
            }
            break;

          case 'call:accept':
            if (message.callId) {
              const result = await CallService.accept_call(message.callId, user_id);


              if (result.success) {
                console.log("call accepted success", message)
                // Notify both parties
                const active_call = CallService.get_user_active_call(user_id);
                if (active_call) {
                  // Notify caller
                  await send_to_user(active_call.caller_id, {
                    type: 'call:accept',
                    callId: message.callId,
                    from: user_id,
                    to: active_call.caller_id,
                    timestamp: new Date().toISOString()
                  });

                  // Acknowledge to callee
                  await send_to_user(user_id, {
                    type: 'call:accept',
                    callId: message.callId,
                    from: user_id,
                    to: active_call.caller_id,
                    data: { success: true },
                    timestamp: new Date().toISOString()
                  });
                }
              } else {
                await send_to_user(user_id, {
                  type: 'error',
                  data: { message: result.error },
                  timestamp: new Date().toISOString()
                });
              }
            }
            break;

          case 'call:decline':
            if (message.callId) {
              const active_call = CallService.get_user_active_call(user_id);
              const result = await CallService.decline_call(message.callId, user_id, message.payload?.reason);

              if (result.success) {
                if (active_call) {
                  // Notify caller
                  const other_user = active_call.caller_id === user_id ? active_call.callee_id : active_call.caller_id;
                  await send_to_user(active_call.caller_id, {
                    type: 'call:decline',
                    callId: message.callId,
                    from: user_id,
                    to: other_user,
                    payload: message.payload,
                    timestamp: new Date().toISOString()
                  });
                  await send_to_user(user_id, {
                    type: 'call:decline',
                    callId: message.callId,
                    data: { success: true, reason: message.payload?.reason },
                    timestamp: new Date().toISOString()
                  });

                  await FCMService.sendNotificationToUser(other_user, {
                    title: "Call Ended",
                    body: `User declined your call`,
                    type: 'call_end',
                  })
                }
              }
            }
            break;

          case 'call:end':
            if (message.callId) {
              // Get active call first before ending it
              const active_call = CallService.get_user_active_call(user_id);

              const result = await CallService.end_call(message.callId, user_id, message.payload?.reason);

              if (result.success) {
                // Find the other party and notify them
                if (active_call) {
                  const other_user = active_call.caller_id === user_id ? active_call.callee_id : active_call.caller_id;

                  // console.log(`[WS] Call ended: ${message.callId}, notifying user ${other_user}`);

                  await send_to_user(other_user, {
                    type: 'call:end',
                    callId: message.callId,
                    from: user_id,
                    to: other_user,
                    payload: {
                      reason: message.payload?.reason,
                      duration: result.data?.duration_seconds
                    },
                    timestamp: new Date().toISOString()
                  });

                  // Acknowledge to sender
                  await send_to_user(user_id, {
                    type: 'call:end',
                    callId: message.callId,
                    data: { success: true, duration: result.data?.duration_seconds },
                    timestamp: new Date().toISOString()
                  });
                } else {
                  console.warn(`[WS] No active call found for user ${user_id} when ending call ${message.callId}`);
                }
              } else {
                console.error(`[WS] Failed to end call ${message.callId}: ${result.error}`);
              }
            }
            break;



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
        })
      }
    },

    close: async (ws) => {
      const user_id = Number(get_ws_data(ws, "user_id"));
      if (user_id) {
        socket_connections.delete(user_id);

        // Notify all connected users about this user being offline
        const connected_users = await get_connected_users(user_id);
        const message_payload: ConnectionStatusPayload = {
          sender_id: user_id,
          status: 'disconnected',
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
          exclude_user_ids: [user_id]
        });

        // update the online status of user in the DB
        await update_user_details(user_id, { online_status: false, last_seen: new Date() });

        console.log(`[WS] User ${user_id} disconnected. Total connections: ${socket_connections.size}`);
      }
    }
  })
  .listen(process.env.SOCKET_PORT || 5002);

console.log(`🔌 New WebSocket is running at port ${process.env.SOCKET_PORT || 5002}`);

// const health_check_payload: MiscPayload = {
//   message: "Connection established successfully",
//   code: 1
// };
// // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// await broadcast_message({
//   to: "users",
//   user_ids: [user_id],
//   message: {
//     type: "socket:health_check",
//     payload: health_check_payload,
//     ws_timestamp: new Date()
//   },
// });

export default web_socket_server;
export { socket_connections };
