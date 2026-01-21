import db from "@/config/db";
import { authenticate_jwt } from "@/middleware";
import { user_model } from "@/models/user.model";
import { WSMessageSchema } from "@/types/socket.elysia-schema";
import { JoinLeavePayload, MiscPayload, ConnectionStatusPayload, UserConnection, ChatMessagePayload, TypingPayload, ChatMessageAckPayload, MessageForwardPayload, MessagePinPayload, CallPayload, SSEConnection, PollingConnection, PendingMessage, SyncMessagesPayload, SyncMessageItem, MessageDeliveredPayload } from "@/types/socket.types";
import { and, eq, sql, isNull, desc, inArray } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { broadcast_message, get_connected_users, get_ws_data, handle_join_conversation, set_ws_data } from "./socket.handlers";
import { update_user_connection_status, update_user_details } from "@/services/user.services";
import { pin_message, unpin_message, store_message, forward_messages, batch_insert_message_status, update_message_status } from "@/services/message.services";
import { update_conversation } from "@/services/chat.services";
import { ChatType } from "@/types/chat.types";
import { get_conversation_members } from "./socket.cache";
import { conversation_model, conversation_member_model, message_model, message_status_model } from "@/models/chat.model";
import FCMService from "@/services/fcm.service";
import { CallService } from "@/services/call.service";
import { CallInitPayload } from "@/types/call.types";

// Connection maps for different transport types
const socket_connections = new Map<number, UserConnection>(); // user_id -> UserConnection (WebSocket)
const sse_connections = new Map<number, SSEConnection>(); // user_id -> SSE connection
const polling_connections = new Map<number, PollingConnection>(); // user_id -> Polling connection

// Heartbeat configuration
const HEARTBEAT_INTERVAL_MS = 30000; // Send ping every 30 seconds
const MAX_MISSED_PINGS = 3; // Close connection after 3 missed pings
const PING_TIMEOUT_MS = 10000; // Wait 10 seconds for pong response

// Heartbeat interval for all WebSocket connections
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the heartbeat mechanism that sends periodic pings to all connected WebSocket clients.
 * This helps detect stale connections and keeps connections alive through NAT/firewalls.
 */
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(() => {
    const now = new Date();
    const staleConnections: number[] = [];

    socket_connections.forEach((connection, user_id) => {
      // Check if connection missed too many pings
      if (connection.missed_pings >= MAX_MISSED_PINGS) {
        console.log(`[WS-HEARTBEAT] User ${user_id} missed ${connection.missed_pings} pings, closing connection`);
        staleConnections.push(user_id);
        return;
      }

      // Check if WebSocket is still open
      if (connection.ws.readyState !== 1) { // 1 = OPEN
        console.log(`[WS-HEARTBEAT] User ${user_id} WebSocket not open (state: ${connection.ws.readyState}), removing`);
        staleConnections.push(user_id);
        return;
      }

      // Send ping to client
      try {
        connection.ws.send({
          type: 'ping',
          timestamp: now.toISOString()
        }, true);
        connection.last_ping_sent = now;
        connection.missed_pings++;
        // console.log(`[WS-HEARTBEAT] Sent ping to user ${user_id}, missed_pings: ${connection.missed_pings}`);
      } catch (error) {
        console.error(`[WS-HEARTBEAT] Error sending ping to user ${user_id}:`, error);
        staleConnections.push(user_id);
      }
    });

    // Clean up stale connections
    staleConnections.forEach(async (user_id) => {
      const connection = socket_connections.get(user_id);
      if (connection) {
        try {
          connection.ws.close(4000, "Connection timeout - no pong response");
        } catch (e) {
          // Ignore close errors
        }
        socket_connections.delete(user_id);

        // Update user status in DB
        await update_user_details(user_id, { online_status: false, last_seen: new Date() });

        // Notify connected users about this user being offline
        const connected_users = await get_connected_users(user_id);
        const message_payload: ConnectionStatusPayload = {
          sender_id: user_id,
          status: 'disconnected',
        };
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

        console.log(`[WS-HEARTBEAT] Cleaned up stale connection for user ${user_id}. Total connections: ${socket_connections.size}`);
      }
    });
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`[WS-HEARTBEAT] Started heartbeat interval (${HEARTBEAT_INTERVAL_MS}ms)`);
}

/**
 * Stop the heartbeat mechanism
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[WS-HEARTBEAT] Stopped heartbeat interval');
  }
}

/**
 * Handle pong response from client - reset missed ping counter
 */
function handlePongResponse(user_id: number) {
  const connection = socket_connections.get(user_id);
  if (connection) {
    connection.last_pong_received = new Date();
    connection.missed_pings = 0;
    // console.log(`[WS-HEARTBEAT] Received pong from user ${user_id}`);
  }
}

// =============================================================================
// Connection Statistics & Enhanced Logging
// =============================================================================

interface ConnectionStats {
  total_ws_connections: number;
  total_sse_connections: number;
  total_polling_connections: number;
  connections_by_transport: Record<string, number>;
  oldest_connection_age_seconds: number;
  average_missed_pings: number;
}

/**
 * Get current connection statistics for monitoring
 */
function getConnectionStats(): ConnectionStats {
  const now = Date.now();
  let oldestConnectionAge = 0;
  let totalMissedPings = 0;

  socket_connections.forEach((conn) => {
    const age = (now - conn.connected_at.getTime()) / 1000;
    if (age > oldestConnectionAge) {
      oldestConnectionAge = age;
    }
    totalMissedPings += conn.missed_pings;
  });

  return {
    total_ws_connections: socket_connections.size,
    total_sse_connections: sse_connections.size,
    total_polling_connections: polling_connections.size,
    connections_by_transport: {
      websocket: socket_connections.size,
      sse: sse_connections.size,
      polling: polling_connections.size,
    },
    oldest_connection_age_seconds: Math.round(oldestConnectionAge),
    average_missed_pings: socket_connections.size > 0 
      ? totalMissedPings / socket_connections.size 
      : 0,
  };
}

/**
 * Log detailed connection error with context
 */
function logConnectionError(
  context: string,
  user_id: number | undefined,
  client_ip: string | undefined,
  error: any,
  additional_info?: Record<string, any>
) {
  const errorLog = {
    timestamp: new Date().toISOString(),
    context,
    user_id,
    client_ip,
    error: error?.message || String(error),
    error_stack: error?.stack,
    connection_stats: getConnectionStats(),
    ...additional_info,
  };
  
  console.error(`[CONNECTION-ERROR] ${JSON.stringify(errorLog)}`);
}

/**
 * Log successful connection with diagnostics
 */
function logConnectionSuccess(
  transport: 'ws' | 'sse' | 'polling',
  user_id: number,
  client_ip: string,
  additional_info?: Record<string, any>
) {
  const successLog = {
    timestamp: new Date().toISOString(),
    transport,
    user_id,
    client_ip,
    connection_stats: getConnectionStats(),
    ...additional_info,
  };
  
  console.log(`[CONNECTION-SUCCESS] ${JSON.stringify(successLog)}`);
}

// Periodic stats logging (every 5 minutes)
let statsInterval: ReturnType<typeof setInterval> | null = null;

function startStatsLogging() {
  if (statsInterval) {
    clearInterval(statsInterval);
  }

  statsInterval = setInterval(() => {
    const stats = getConnectionStats();
    console.log(`[CONNECTION-STATS] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...stats,
    })}`);
  }, 5 * 60 * 1000); // Every 5 minutes

  console.log('[CONNECTION-STATS] Started periodic stats logging');
}

function stopStatsLogging() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

// =============================================================================
// Message Sync on Reconnection
// =============================================================================

/**
 * Fetch and send all undelivered messages to a user on reconnection.
 * This ensures users don't miss messages during temporary disconnections.
 */
async function syncMissedMessages(user_id: number, ws: any) {
  try {
    // Get all conversations the user is a member of
    const userConversations = await db
      .select({
        conv_id: conversation_member_model.conversation_id,
        conv_type: conversation_model.type,
      })
      .from(conversation_member_model)
      .innerJoin(
        conversation_model,
        eq(conversation_model.id, conversation_member_model.conversation_id)
      )
      .where(
        and(
          eq(conversation_member_model.user_id, user_id),
          eq(conversation_member_model.deleted, false)
        )
      );

    if (userConversations.length === 0) {
      console.log(`[SYNC] No conversations found for user ${user_id}`);
      return;
    }

    const conversationIds = userConversations.map(c => c.conv_id);
    const convTypeMap = new Map(userConversations.map(c => [c.conv_id, c.conv_type]));

    // Find all messages in user's conversations that haven't been delivered to this user
    // These are messages where message_status.delivered_at is NULL for this user
    const undeliveredStatuses = await db
      .select({
        message_id: message_status_model.message_id,
        conv_id: message_status_model.conv_id,
      })
      .from(message_status_model)
      .where(
        and(
          eq(message_status_model.user_id, user_id),
          inArray(message_status_model.conv_id, conversationIds),
          isNull(message_status_model.delivered_at)
        )
      )
      .limit(500); // Limit to prevent overwhelming the client

    if (undeliveredStatuses.length === 0) {
      console.log(`[SYNC] No missed messages for user ${user_id}`);
      return;
    }

    const messageIds = undeliveredStatuses.map(s => s.message_id);

    // Fetch the actual message data
    const missedMessages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        metadata: message_model.metadata,
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        sender_name: user_model.name,
        sender_pfp: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(user_model, eq(user_model.id, message_model.sender_id))
      .where(
        and(
          inArray(message_model.id, messageIds),
          eq(message_model.deleted, false)
        )
      )
      .orderBy(desc(message_model.sent_at));

    if (missedMessages.length === 0) {
      console.log(`[SYNC] No valid missed messages for user ${user_id}`);
      return;
    }

    // Transform to SyncMessageItem format
    const syncMessages: SyncMessageItem[] = missedMessages.map(msg => ({
      id: msg.id,
      conv_id: msg.conversation_id!,
      conv_type: (convTypeMap.get(msg.conversation_id!) || 'dm') as any,
      sender_id: msg.sender_id,
      sender_name: msg.sender_name || undefined,
      sender_pfp: msg.sender_pfp || undefined,
      msg_type: msg.type as any,
      body: msg.body || undefined,
      attachments: msg.attachments,
      metadata: msg.metadata,
      sent_at: msg.sent_at || new Date(),
      created_at: msg.created_at,
    }));

    // Send sync message to user
    const syncPayload: SyncMessagesPayload = {
      messages: syncMessages.reverse(), // Send oldest first
      sync_timestamp: new Date(),
      total_count: syncMessages.length,
    };

    ws.send({
      type: 'message:sync',
      payload: syncPayload,
      ws_timestamp: new Date(),
    }, true);

    // Mark these messages as delivered
    await db
      .update(message_status_model)
      .set({ delivered_at: new Date() })
      .where(
        and(
          eq(message_status_model.user_id, user_id),
          inArray(message_status_model.message_id, messageIds)
        )
      );

    console.log(`[SYNC] Synced ${syncMessages.length} missed messages to user ${user_id}`);

  } catch (error) {
    console.error(`[SYNC] Error syncing missed messages for user ${user_id}:`, error);
  }
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
    // body: t.Any(),
    body: WSMessageSchema,
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

        // Extract client IP for logging/diagnostics
        const request = ws.data.request;
        const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
          || request.headers.get('x-real-ip') 
          || 'unknown';

        // Add to active socket connections with new tracking fields
        socket_connections.set(user_id, {
          ws,
          connection_status: "foreground",
          transport_type: "ws",
          missed_pings: 0,
          connected_at: new Date(),
          client_ip
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

        logConnectionSuccess('ws', user_id, client_ip, { user_name });

        // update the online status of user in the DB
        await update_user_details(user_id, { online_status: true, connection_status: "foreground", last_seen: new Date() });

        // Sync missed messages to the user (this also marks them as delivered)
        // This is critical for users who temporarily lost connection
        await syncMissedMessages(user_id, ws);

      } catch (error) {
        const request = ws.data.request;
        const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
          || request.headers.get('x-real-ip') 
          || 'unknown';
        logConnectionError('ws_open', undefined, client_ip, error);
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

        // if (message.type.startsWith("call")) {
        //   console.log(message)
        // }

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

              // store the new message in DB
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

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'message:delivered':
            // Delivery receipt from recipient (typically from FCM message when app was killed)
            if (message.payload) {
              const payload = message.payload as MessageDeliveredPayload;
              
              console.log(`[WS] Received delivery receipt for message ${payload.message_id} from user ${payload.recipient_id}`);

              // Update message status in the database
              await update_message_status({
                message_id: payload.message_id,
                user_id: payload.recipient_id,
                delivered_at: new Date(payload.delivered_at),
              });

              // Update the message status in the messages table (for DMs)
              await db.update(message_model).set({
                status: "delivered"
              }).where(
                and(
                  eq(message_model.id, payload.message_id),
                  eq(message_model.conversation_id, payload.conv_id),
                  eq(message_model.status, "sent") // Only update if still "sent"
                )
              );

              // Broadcast acknowledgment to the original sender so they can update UI
              const ack_payload: ChatMessageAckPayload = {
                optimistic_id: 0, // Not needed for delivery receipts
                canonical_id: payload.message_id,
                conv_id: payload.conv_id,
                sender_id: payload.sender_id,
                delivered_at: new Date(payload.delivered_at),
                delivered_to: [payload.recipient_id],
                read_by: [],
                offline_users: [],
              };

              // Send ack to the original message sender
              await broadcast_message({
                to: "users",
                user_ids: [payload.sender_id],
                message: {
                  type: "message:ack",
                  payload: ack_payload,
                  ws_timestamp: new Date()
                },
              });

              console.log(`[WS] Delivery receipt processed: message ${payload.message_id} delivered to user ${payload.recipient_id}`);
            } else {
              console.error('[WS] message:delivered payload missing');
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
            // Client sent ping, respond with pong
            // console.log(`[WS] Received ping from user ${user_id}`);
            ws.send({
              type: 'pong',
              timestamp: new Date().toISOString()
            }, true);
            break;

          case 'pong':
            // Client responded to our ping - reset missed ping counter
            handlePongResponse(user_id);
            break;


          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          // Call signaling handlers
          case 'call:init':
            if (message.payload) {
              const payload = message.payload as CallPayload;

              const result = await CallService.initiate_call(
                payload.caller_id || Number(user_id),
                payload.callee_id
              )

              if (result.success) {
                const call_id = result.data?.callId;

                // Get caller details for the payload
                let callerName: string | undefined;
                let callerPfp: string | undefined;
                try {
                  const caller = await db
                    .select({ name: user_model.name, profile_pic: user_model.profile_pic })
                    .from(user_model)
                    .where(eq(user_model.id, payload.caller_id || Number(user_id)))
                    .limit(1);

                  callerName = caller[0]?.name;
                  callerPfp = caller[0]?.profile_pic || undefined;
                } catch (error) {
                  console.error(`[WS] Error fetching caller details:`, error);
                }

                // Send acknowledgment to caller
                const call_init_payload: CallPayload = {
                  call_id: result.data?.callId,
                  caller_id: payload.caller_id || Number(user_id),
                  callee_id: payload.callee_id,
                  timestamp: new Date(),
                }

                // Payload for callee with caller details
                const call_ringing_payload: CallPayload = {
                  call_id: result.data?.callId,
                  caller_id: payload.caller_id || Number(user_id),
                  caller_name: callerName || payload.caller_name,
                  caller_pfp: callerPfp || payload.caller_pfp,
                  callee_id: payload.callee_id,
                  timestamp: new Date(),
                }

                // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
                await broadcast_message({
                  to: "users",
                  user_ids: [payload.caller_id || Number(user_id)],
                  message: {
                    type: "call:init:ack",
                    payload: call_init_payload,
                    ws_timestamp: new Date()
                  },
                })
                // console.log(`[WS] Ack sent to caller ${user_id}: ${ackSent}`);

                // Send incoming call notification to callee
                // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
                const braodcast_result = await broadcast_message({
                  to: "users",
                  user_ids: [payload.callee_id],
                  message: {
                    type: "call:ringing",
                    payload: call_ringing_payload,
                    ws_timestamp: new Date()
                  },
                })

                // Send push notification if user is offline
                if (!braodcast_result.online.includes(payload.callee_id)) {
                  try {
                    await FCMService.sendCallNotification(payload.callee_id, {
                      callId: call_id!.toString(),
                      callerId: (payload.caller_id || Number(user_id)).toString(),
                      callerName: callerName || 'Unknown',
                      callerProfilePic: callerPfp,
                      callType: 'audio',
                    });

                  } catch (error) {
                    console.error(`[WS] Error sending call push notification:`, error);
                  }
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
                      ...payload,
                      error: {
                        code: result.code,
                        message: result.error,
                      },
                    },
                    ws_timestamp: new Date()
                  },
                })
              }
            } else {
              console.log(`[WS] Invalid call:init message - missing payload`);
            }
            break;

          case 'call:offer':
          case 'call:answer':
          case 'call:ice':
            if (message.payload) {
              const payload = message.payload as CallPayload;
              if (!payload.call_id && !payload.data) {
                console.error("call_id or payload.data missing in call:offer/answer/ice payload")
                return
              }
              // Forward WebRTC signaling between caller and callee
              // console.log('[WS] Received ', message)

              const call_offer_payload: CallPayload = {
                call_id: payload.call_id,
                caller_id: payload.caller_id,
                callee_id: payload.callee_id,
                data: payload.data,
                timestamp: new Date(),
              }

              // Determine the recipient based on message type and sender
              let recipient_id: number;
              if (message.type === 'call:offer') {
                // Offer goes from caller to callee
                recipient_id = payload.callee_id;
              } else if (message.type === 'call:answer') {
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
                  type: message.type,
                  payload: call_offer_payload,
                },
              })

              console.log(`[WS] Forwarded ${message.type} to user ${recipient_id}`);
            }
            else {
              console.error(`[WS] Invalid ${message.type} message - missing payload`);
            }
            break;

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'call:accept':
            if (message.payload) {
              const payload = message.payload as CallPayload;
              if (!payload.call_id) {
                console.error("call_id missing in call:accept payload")
                return
              }

              const result = await CallService.accept_call(payload.call_id, user_id);

              const call_accept_payload: CallPayload = {
                call_id: payload.call_id,
                caller_id: payload.caller_id,
                callee_id: payload.callee_id,
                timestamp: new Date(),
              }
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
                  })
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
                      },
                    },
                  },
                })
              }
            }
            break;

          // --------------------------------------------------------------------
          // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
          // --------------------------------------------------------------------

          case 'call:decline':
            if (message.payload) {
              const payload = message.payload as CallPayload;
              if (!payload.call_id) {
                console.error("call_id missing in call:decline payload")
                return
              }

              // Get active call BEFORE declining (it will be removed after)
              const active_call = CallService.get_user_active_call(user_id);
              const result = await CallService.decline_call(payload.call_id, user_id, payload.data?.reason);

              const call_decline_payload: CallPayload = {
                call_id: payload.call_id,
                caller_id: payload.caller_id,
                callee_id: payload.callee_id,
                timestamp: new Date(),
              }

              if (result.success) {
                // Determine caller and callee from active_call or payload
                const caller_id = active_call?.caller_id || payload.caller_id;
                const callee_id = active_call?.callee_id || payload.callee_id;
                const other_user = caller_id === user_id ? callee_id : caller_id;
                const is_caller_declining = user_id === caller_id;

                // Notify both parties about the decline/cancel
                // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
                await broadcast_message({
                  to: "users",
                  user_ids: [caller_id, callee_id],
                  message: {
                    type: "call:decline",
                    payload: {
                      ...call_decline_payload,
                      caller_id,
                      callee_id,
                      data: {
                        success: true,
                        reason: payload.data?.reason,
                        declined_by: user_id,
                        status: result.data?.status
                      },
                    },
                  },
                })

                // Send push notification to the other party
                // Get caller name for notification
                const [caller_user] = await db
                  .select({ name: user_model.name })
                  .from(user_model)
                  .where(eq(user_model.id, caller_id))
                  .limit(1);

                await FCMService.sendNotificationToUser(other_user, {
                  title: "Call Ended",
                  body: is_caller_declining ? `Caller cancelled the call` : `Call was declined`,
                  type: 'call_end',
                  data: {
                    callId: payload.call_id.toString(),
                    callerId: caller_id.toString(),
                    callerName: caller_user?.name || 'Unknown',
                  },
                })
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
                        code: 'DECLINE_FAILED',
                        message: result.error,
                      },
                    },
                  },
                })
              }
            }
            break;

          case 'call:end':
            if (message.payload) {
              const payload = message.payload as CallPayload;
              if (!payload.call_id) {
                console.error("call_id missing in call:accept payload")
                return
              }
              // Get active call first before ending it
              const active_call = CallService.get_user_active_call(user_id);

              const result = await CallService.end_call(payload.call_id, user_id, payload.data.reason);

              const call_end_payload: CallPayload = {
                call_id: payload.call_id,
                caller_id: payload.caller_id,
                callee_id: payload.callee_id,
                timestamp: new Date(),
              }

              if (result.success) {
                // Find the other party and notify them
                if (active_call) {
                  const other_user = active_call.caller_id === user_id ? active_call.callee_id : active_call.caller_id;

                  // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
                  await broadcast_message({
                    to: "users",
                    user_ids: [other_user],
                    message: {
                      type: "call:end",
                      payload: {
                        ...call_end_payload,
                        data: {
                          reason: payload.data?.reason,
                          duration: result.data?.duration_seconds
                        },
                      },
                    },
                  })

                  // Acknowledge to sender
                  await broadcast_message({
                    to: "users",
                    user_ids: [other_user],
                    message: {
                      type: "call:end",
                      payload: {
                        ...call_end_payload,
                        data: {
                          success: true,
                          duration: result.data?.duration_seconds
                        },
                      },
                    },
                  })

                  // Send FCM notification to the other party (important when app is terminated)
                  // Get caller name for notification
                  const [caller_user] = await db
                    .select({ name: user_model.name })
                    .from(user_model)
                    .where(eq(user_model.id, active_call.caller_id))
                    .limit(1);

                  await FCMService.sendNotificationToUser(other_user, {
                    title: "Call Ended",
                    body: `Call ended`,
                    type: 'call_end',
                    data: {
                      callId: payload.call_id.toString(),
                      callerId: active_call.caller_id.toString(),
                      callerName: caller_user?.name || 'Unknown',
                    },
                  })

                } else {
                  console.warn(`[WS] No active call found for user ${user_id} when ending call ${payload.call_id}`);
                }
              } else {
                console.error(`[WS] Failed to end call ${payload.call_id}: ${result.error}`);
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
  // ============================================================================
  // SSE (Server-Sent Events) Endpoint - Fallback transport for WebSocket
  // ============================================================================
  .get('/chat/sse', async ({ query, set, request }) => {
    const token = query.token;
    
    if (!token) {
      set.status = 401;
      return { error: 'Authentication token is required' };
    }

    // Verify JWT token
    const auth_result = authenticate_jwt(token);
    if (!auth_result.success || !auth_result.data) {
      set.status = 401;
      return { error: 'Invalid authentication token' };
    }

    const user_id = auth_result.data.id;
    const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
      || request.headers.get('x-real-ip') 
      || 'unknown';

    console.log(`[SSE] User ${user_id} connecting from ${client_ip}`);

    // Create SSE stream
    const stream = new ReadableStream({
      start: async (controller) => {
        // Store the SSE connection
        sse_connections.set(user_id, {
          controller,
          user_id,
          connected_at: new Date(),
          last_keepalive: new Date(),
          client_ip
        });

        // Send initial connection success event
        const connectEvent = `data: ${JSON.stringify({ type: 'connection:status', payload: { sender_id: user_id, status: 'foreground' }, ws_timestamp: new Date() })}\n\n`;
        controller.enqueue(new TextEncoder().encode(connectEvent));

        // Update user status in DB
        await update_user_details(user_id, { online_status: true, connection_status: "foreground", last_seen: new Date() });

        // Notify connected users about this user being online
        const connected_users = await get_connected_users(user_id);
        const message_payload: ConnectionStatusPayload = {
          sender_id: user_id,
          status: 'foreground',
        };
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

        logConnectionSuccess('sse', user_id, client_ip);

        // Set up keepalive interval
        const keepaliveInterval = setInterval(() => {
          try {
            const sse_conn = sse_connections.get(user_id);
            if (sse_conn) {
              controller.enqueue(new TextEncoder().encode(`: keepalive\n\n`));
              sse_conn.last_keepalive = new Date();
            }
          } catch (e) {
            // Controller is closed
            clearInterval(keepaliveInterval);
          }
        }, 30000);

        // Handle cleanup when stream is cancelled
        request.signal.addEventListener('abort', async () => {
          clearInterval(keepaliveInterval);
          sse_connections.delete(user_id);
          
          // Update user status in DB
          await update_user_details(user_id, { online_status: false, last_seen: new Date() });

          // Notify connected users about this user being offline
          const connected_users = await get_connected_users(user_id);
          await broadcast_message({
            to: "users",
            user_ids: Array.from(connected_users),
            message: {
              type: "connection:status",
              payload: { sender_id: user_id, status: 'disconnected' },
              ws_timestamp: new Date()
            },
            exclude_user_ids: [user_id]
          });

          console.log(`[SSE] User ${user_id} disconnected. Total SSE connections: ${sse_connections.size}`);
          controller.close();
        });
      }
    });

    set.headers['Content-Type'] = 'text/event-stream';
    set.headers['Cache-Control'] = 'no-cache';
    set.headers['Connection'] = 'keep-alive';
    set.headers['X-Accel-Buffering'] = 'no'; // Disable nginx buffering

    return stream;
  }, {
    query: t.Object({ token: t.String() })
  })
  // ============================================================================
  // HTTP Long Polling Endpoints - Fallback transport for WebSocket/SSE
  // ============================================================================
  // GET endpoint to poll for new messages
  .get('/chat/poll', async ({ query, set, request }) => {
    const token = query.token;
    const last_message_id = query.last_message_id;
    
    if (!token) {
      set.status = 401;
      return { error: 'Authentication token is required' };
    }

    // Verify JWT token
    const auth_result = authenticate_jwt(token);
    if (!auth_result.success || !auth_result.data) {
      set.status = 401;
      return { error: 'Invalid authentication token' };
    }

    const user_id = auth_result.data.id;
    const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
      || request.headers.get('x-real-ip') 
      || 'unknown';

    // Get or create polling connection
    let polling_conn = polling_connections.get(user_id);
    if (!polling_conn) {
      polling_conn = {
        user_id,
        pending_messages: [],
        connected_at: new Date(),
        client_ip
      };
      polling_connections.set(user_id, polling_conn);
      
      // Update user status in DB
      await update_user_details(user_id, { online_status: true, connection_status: "foreground", last_seen: new Date() });

      logConnectionSuccess('polling', user_id, client_ip);
    }

    polling_conn.last_poll = new Date();

    // Filter messages after last_message_id if provided
    let messages = polling_conn.pending_messages;
    if (last_message_id) {
      const idx = messages.findIndex(m => m.message_id === last_message_id);
      if (idx !== -1) {
        messages = messages.slice(idx + 1);
      }
    }

    // If there are pending messages, return them immediately
    if (messages.length > 0) {
      // Clear returned messages from queue
      polling_conn.pending_messages = polling_conn.pending_messages.filter(
        m => !messages.some(msg => msg.message_id === m.message_id)
      );
      polling_conn.last_message_id = messages[messages.length - 1].message_id;
      
      return {
        messages: messages.map(m => ({ ...m.message, message_id: m.message_id })),
        last_message_id: polling_conn.last_message_id
      };
    }

    // Long poll: wait up to 30 seconds for new messages
    const POLL_TIMEOUT_MS = 30000;
    const start_time = Date.now();
    const abort_controller = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener('abort', () => {
      abort_controller.abort();
    });

    // Wait for messages with timeout
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const polling = polling_connections.get(user_id);
        
        // Check if client disconnected
        if (abort_controller.signal.aborted) {
          clearInterval(checkInterval);
          resolve({ messages: [], last_message_id: polling?.last_message_id });
          return;
        }

        // Check for new messages
        if (polling && polling.pending_messages.length > 0) {
          clearInterval(checkInterval);
          const newMessages = [...polling.pending_messages];
          polling.pending_messages = [];
          polling.last_message_id = newMessages[newMessages.length - 1].message_id;
          
          resolve({
            messages: newMessages.map(m => ({ ...m.message, message_id: m.message_id })),
            last_message_id: polling.last_message_id
          });
          return;
        }

        // Check timeout
        if (Date.now() - start_time >= POLL_TIMEOUT_MS) {
          clearInterval(checkInterval);
          resolve({ messages: [], last_message_id: polling?.last_message_id });
          return;
        }
      }, 500); // Check every 500ms
    });
  }, {
    query: t.Object({ 
      token: t.String(),
      last_message_id: t.Optional(t.String())
    })
  })
  // POST endpoint to send messages via polling
  .post('/chat/poll', async ({ body, query, set, request }) => {
    const token = query.token;
    
    if (!token) {
      set.status = 401;
      return { error: 'Authentication token is required' };
    }

    // Verify JWT token
    const auth_result = authenticate_jwt(token);
    if (!auth_result.success || !auth_result.data) {
      set.status = 401;
      return { error: 'Invalid authentication token' };
    }

    const user_id = auth_result.data.id;

    // Get user details for message handling
    const user_name = (await db
      .select({ name: user_model.name })
      .from(user_model)
      .where(eq(user_model.id, user_id))
      .limit(1))[0]?.name;

    // Process the message similar to WebSocket message handling
    const message = body as any;
    
    // For now, support basic message types that don't require WebSocket-specific handling
    switch (message.type) {
      case 'ping':
        return { type: 'pong', timestamp: new Date().toISOString() };

      case 'message:new':
        if (message.payload) {
          const payload = message.payload as ChatMessagePayload;
          
          // Store the message in DB
          const stored_message = await store_message(payload);
          if (!stored_message?.success) {
            set.status = 500;
            return { error: 'Failed to store message' };
          }

          const new_message_payload: ChatMessagePayload = {
            ...payload,
            canonical_id: stored_message?.data?.id,
            sender_name: payload.sender_name || user_name || undefined,
          };

          // Broadcast to conversation members
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

          // Return acknowledgment
          return {
            type: "message:ack",
            payload: {
              optimistic_id: payload.optimistic_id,
              canonical_id: stored_message?.data?.id,
              conv_id: payload.conv_id,
              sender_id: payload.sender_id,
              delivered_at: new Date(),
              delivered_to: sent_result.online,
              offline_users: sent_result.offline,
            }
          };
        }
        break;

      case 'conversation:typing':
        if (message.payload) {
          const payload = message.payload as TypingPayload;
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
          return { success: true };
        }
        break;

      default:
        return { error: `Unsupported message type for polling: ${message.type}` };
    }

    return { success: true };
  }, {
    query: t.Object({ token: t.String() }),
    body: t.Any()
  })
  .listen(process.env.SOCKET_PORT || 5002);

console.log(`🔌 WebSocket server is running at port ${process.env.SOCKET_PORT || 5002}`);

// Start the heartbeat mechanism
startHeartbeat();

// Start periodic connection stats logging
startStatsLogging();

// Graceful shutdown
process.on('SIGTERM', () => {
  stopHeartbeat();
  stopStatsLogging();
});
process.on('SIGINT', () => {
  stopHeartbeat();
  stopStatsLogging();
});

export default web_socket_server;
export { socket_connections, sse_connections, polling_connections, startHeartbeat, stopHeartbeat };
