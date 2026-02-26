import db from "@/config/db";
import { authenticate_jwt } from "@/middleware";
import { user_model } from "@/models/user.model";
import { WSMessageSchema } from "@/types/socket.elysia-schema";
import { eq, } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { broadcast_message, get_connected_users, get_ws_data, set_ws_data, socket_message_handler } from "./socket.handlers";
import { ConnectionStatusPayload, PollingConnection, UserConnection, WSMessage } from "@/types/socket.types";
import { batch_update_users_details, update_user_details } from "@/services/user.services";
// import { sync_missed_messages } from "@/services/chat.services";
import { start_cleanup_cron, stop_cleanup_cron } from "@/services/cache-management/polling.cache";

// Connection maps for different transport types
const socket_connections = new Map<number, UserConnection>(); // user_id -> UserConnection (WebSocket)
const polling_connections = new Map<number, PollingConnection>(); // user_id -> Polling connection

// Heartbeat configuration
const HEARTBEAT_INTERVAL_MS = 10000; // Send ping every 30 seconds
const MAX_MISSED_PINGS = 5; // Close connection after 3 missed pings

// Heartbeat interval for all WebSocket connections
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Start the heartbeat mechanism that sends periodic pings to all connected WebSocket clients.
// This helps detect stale connections and keeps connections alive through NAT/firewalls.
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(async () => {
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
          type: 'socket:ping',
          ws_timestamp: now.toISOString()
        }, true);
        connection.last_ping_sent = now;
        connection.missed_pings++;
        // console.log(`[WS-HEARTBEAT] Sent ping to user ${user_id}, missed_pings: ${connection.missed_pings}`);
      } catch (error) {
        console.error(`[WS-HEARTBEAT] Error sending ping to user ${user_id}:`, error);
        staleConnections.push(user_id);
      }
    });

    for (const user_id of staleConnections) {
      const connection = socket_connections.get(user_id);
      if (connection) {
        try {
          connection.ws.close(4000, "Connection timeout - no pong response");
        } catch (e) {
          // Ignore close errors
        }
        socket_connections.delete(user_id);

        // Notify connected users about this user being offline
        try {
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
        } catch (e) {
          console.error(`[WS-HEARTBEAT] Error notifying about stale connection for user ${user_id}:`, e);
        }

        console.log(`[WS-HEARTBEAT] Cleaned up stale connection for user ${user_id}. Total connections: ${socket_connections.size}`);
      }
    }

    // Update user status in DB for stale connections
    if (staleConnections.length > 0) {
      await batch_update_users_details(staleConnections, { online_status: false, last_seen: new Date() });
    }

  }, HEARTBEAT_INTERVAL_MS);

  console.log(`[WS-HEARTBEAT] Started heartbeat interval (${HEARTBEAT_INTERVAL_MS}ms)`);
}

// Stop the heartbeat mechanism
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[WS-HEARTBEAT] Stopped heartbeat interval');
  }
}

// Handle pong response from client - reset missed ping counter
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
  // total_sse_connections: number;
  total_polling_connections: number;
  connections_by_transport: Record<string, number>;
  oldest_connection_age_seconds: number;
  average_missed_pings: number;
}

// Get current connection statistics for monitoring
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
    // total_sse_connections: sse_connections.size,
    total_polling_connections: polling_connections.size,
    connections_by_transport: {
      websocket: socket_connections.size,
      // sse: sse_connections.size,
      polling: polling_connections.size,
    },
    oldest_connection_age_seconds: Math.round(oldestConnectionAge),
    average_missed_pings: socket_connections.size > 0
      ? totalMissedPings / socket_connections.size
      : 0,
  };
}

// Log detailed connection error with context
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

// Log successful connection with diagnostics
function logConnectionSuccess(
  transport: 'ws' | 'polling',
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

// WebSocket server
const web_socket_server = new Elysia()
  .onError(({ error, path }) => {
    const err = error as any;
    switch (err.code) {
      case "NOT_FOUND":
        console.error("[SOCKET] WebSocket server endpoint not found");
        return { type: "socket:error", message: "WebSocket endpoint not found" };

      case "VALIDATION":
        console.error("[SOCKET] WebSocket server validation error at", path);
        // console.error(err);
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
      const err = error as any;
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
          // console.log(err);
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

        if (token == "websocket-connectivity-check") {
          ws.close(4200, "Connectivity check - no authentication needed");
          console.log("[SOCKET] Received connectivity check ping, responded with health check message");
          return;
        }

        if (!token) {
          ws.send({
            type: 'socket:error',
            error_code: 'AUTH_REQUIRED',
            message: 'Authentication token is required',
            timestamp: new Date().toISOString()
          }, true);
          ws.close(4001, "Missing authentication token");
          return;
        }

        // Verify JWT token
        const auth_result = authenticate_jwt(token);
        if (!auth_result.success || !auth_result.data) {
          // Send error message before closing so client can detect auth failure
          ws.send({
            type: 'socket:error',
            error_code: 'AUTH_INVALID',
            message: 'Invalid or expired authentication token',
            timestamp: new Date().toISOString()
          }, true);
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
        });

        logConnectionSuccess('ws', user_id, client_ip, { user_name });

        // update the online status of user in the DB
        await update_user_details(user_id, { online_status: true, connection_status: "foreground", last_seen: new Date() });

        // =============================================================================
        // Message Sync on Reconnection
        // =============================================================================
        // Sync missed messages to the user (this also marks them as delivered)
        // This is critical for users who temporarily lost connection
        // await sync_missed_messages(user_id);

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

      // heavy lifting is done in the handler
      await socket_message_handler({
        user_id: Number(get_ws_data(ws, "user_id")),
        user_name: String(get_ws_data(ws, "user_name")),
        user_pfp: String(get_ws_data(ws, "user_pfp"))
      }, message as WSMessage);
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

console.log(`🔌 WebSocket server is running at port ${process.env.SOCKET_PORT || 5002}`);

// Start the heartbeat mechanism
startHeartbeat();

// Start periodic connection stats logging
startStatsLogging();

// Start daily cleanup of expired missed messages (>30 days old)
start_cleanup_cron();

// Graceful shutdown
process.on('SIGTERM', () => {
  stopHeartbeat();
  stopStatsLogging();
  stop_cleanup_cron();
});
process.on('SIGINT', () => {
  stopHeartbeat();
  stopStatsLogging();
  stop_cleanup_cron();
});

export default web_socket_server;
export {
  socket_connections,
  polling_connections,
  startHeartbeat,
  stopHeartbeat,
  handlePongResponse
};
