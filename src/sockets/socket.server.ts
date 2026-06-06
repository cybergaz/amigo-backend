import { authenticate_jwt } from "@/middleware";
import { WSMessageSchema } from "@/types/socket.elysia-schema";
import Elysia, { t } from "elysia";
import { broadcast_message, get_ws_data, set_ws_data, socket_message_handler } from "./socket.handlers";
import { ConnectionStatusPayload, PollingConnection, UserConnection, WSMessage } from "@/types/socket.types";
import { update_user_details } from "@/services/user.services";
// import { sync_missed_messages } from "@/services/chat.services";
import { start_cleanup_cron, stop_cleanup_cron } from "@/cache-management/polling.cache";
import { get_user_peers } from "@/cache-management/user-peer.cache";

// Connection maps for different transport types
const socket_connections = new Map<string, UserConnection>(); // user_id -> UserConnection (WebSocket)
const polling_connections = new Map<string, PollingConnection>(); // user_id -> PollingConnection

// configuration
// Heartbeat: client pings every 12s, server checks every 15s, 2 missed = ~24-27s detection
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_MISSED_PINGS = 2;
const STATS_LOGGING_INTERVAL_MS = 60000;
const OFFLINE_STATUS_BROADCAST_DELAY_MS = 8000;

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;

// WebSocket server
const web_socket_server = new Elysia({
  websocket: {
    idleTimeout: 60, // x seconds of inactivity before closing the connection
    sendPings: true,
    perMessageDeflate: true, // RFC 7692 compression — reduces mobile fragmentation risk
  }
})
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
    // schema validations
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
          // console.log("[SOCKET] Received connectivity check ping, responded with health check message");
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

        // update the online status of user in the DB
        const user_res = await update_user_details(
          user_id,
          { last_seen: new Date() }
        );

        // insert user_name into WebSocket data using type-safe helper
        set_ws_data(ws, { user_name: user_res.data?.name });

        // Extract client IP for logging/diagnostics
        const request = ws.data.request;
        const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || request.headers.get('x-real-ip')
          || 'unknown';

        // Add to active socket connections with new tracking fields.
        // A fresh connection always starts foreground (is_background:false); a
        // reconnect therefore clears any prior background flag automatically.
        socket_connections.set(user_id, {
          ws,
          missed_pings: 0,
          is_background: false,
          // connection_status: "online",
          // transport_type: "ws",
          // connected_at: new Date(),
          // client_ip
        });

        // removing from polling connections if exists (in case user switched transport without closing previous connection properly)
        if (polling_connections.has(user_id)) {
          polling_connections.delete(user_id);
          console.log(`[WS] User ${user_id} switched from polling to WebSocket, removed from polling connections`);
        }

        // notify all connected users about this user being online
        const connected_users = await get_user_peers(user_id);

        const message_payload: ConnectionStatusPayload = {
          sender_id: user_id,
          status: 'online',
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

        // Presence snapshot: send current online status of B's peers back to B
        // so B's UI reflects who's already online. Without this, B only ever
        // learns about peers when they toggle state (connect/disconnect) —
        // peers already online before B connected would appear offline forever.
        const snapshot_at = new Date();
        for (const peer_id of connected_users) {
          const peer_conn = socket_connections.get(peer_id);
          if (peer_conn && peer_conn.ws.readyState === 1) {
            try {
              ws.send({
                type: "connection:status",
                payload: { sender_id: peer_id, status: "online" } as ConnectionStatusPayload,
                ws_timestamp: snapshot_at,
              }, true);
            } catch (err) {
              console.error(`[WS] presence snapshot send failed for peer ${peer_id}:`, err);
            }
          }
        }

        // logConnectionSuccess('ws', user_id, client_ip, { user_name: user_res.data?.name });

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
        user_id: get_ws_data(ws, "user_id") as string,
        user_name: get_ws_data(ws, "user_name") as string,
        // user_pfp: get_ws_data(ws, "user_pfp") as string,
      }, message as WSMessage);
    },
    // idleTimeout: 60, // x seconds of inactivity before closing the connection
    // sendPings: true,
    // ping(message) {
    //   console.log('[WS] Received ping');
    //
    // },
    // pong(message) {
    //   console.log('[WS] Received pong');
    // },

    close: async (ws) => {
      const user_id = get_ws_data(ws, "user_id") as string;
      if (user_id) {
        socket_connections.delete(user_id);

        // Delay offline broadcast by x to handle brief reconnects (e.g. WS restart)
        // Only mark offline if the user hasn't reconnected in that window
        setTimeout(async () => {
          // If user has reconnected, a new entry will be in socket_connections
          if (socket_connections.has(user_id)) {
            console.log(`[CONNECTION-DISCONNECT] User ${user_id} reconnected within ${OFFLINE_STATUS_BROADCAST_DELAY_MS}, skipping offline broadcast`);
            return;
          }

          // Notify all connected users about this user being offline
          const connected_users = await get_user_peers(user_id);
          const message_payload: ConnectionStatusPayload = {
            sender_id: user_id,
            status: 'offline',
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
          await update_user_details(user_id, { last_seen: new Date() });

          // const stats = getConnectionStats();
          // console.log(`[CONNECTION-DISCONNECT] ${JSON.stringify({
          //   timestamp: new Date().toISOString(),
          //   ...stats,
          // })}`);
        }, OFFLINE_STATUS_BROADCAST_DELAY_MS);
      }
    }
  })

  .listen(process.env.SOCKET_PORT || 5002);

console.log(`🔌 WebSocket server is running at port ${process.env.SOCKET_PORT || 5002}`);

// =============================================================================
// Heartbeat Mechanism for Connection Health Monitoring
// =============================================================================
// Start the heartbeat mechanism that sends periodic pings to all connected WebSocket clients.
// This helps detect stale connections and keeps connections alive through NAT/firewalls.
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(async () => {
    const now = new Date();

    socket_connections.forEach(async (connection, user_id) => {
      // Check if connection missed too many pings or Check if WebSocket is still open
      if (connection.missed_pings >= MAX_MISSED_PINGS || connection.ws.readyState !== 1) {
        console.log(`[WS-HEARTBEAT] User ${user_id} missed ${connection.missed_pings} pings, closing connection`);

        try {
          connection.ws.close(4000, "Connection timeout - no pong response");
        } catch (e) { }
        socket_connections.delete(user_id);

        try {
          const connected_users = await get_user_peers(user_id);
          const message_payload: ConnectionStatusPayload = {
            sender_id: user_id,
            status: 'offline',
          };
          await broadcast_message({
            to: "users",
            user_ids: Array.from(connected_users),
            message: {
              type: "connection:status",
              payload: message_payload,
              ws_timestamp: new Date()
            },
            // exclude_user_ids: [user_id]
          });
        } catch (e) {
          console.error(`[WS-HEARTBEAT] Error notifying about stale connection for user ${user_id}:`, e);
        }

        await update_user_details(user_id, { last_seen: new Date() });
        console.log(`[WS-HEARTBEAT] Cleaned up stale connection for user ${user_id}. Total connections: ${socket_connections.size}`);

        return;
      }

      // Send ping to client
      try {
        connection.ws.send({
          type: 'socket:ping',
          ws_timestamp: now.toISOString()
        }, true);
        // connection.last_ping_sent = now;
        connection.missed_pings++;
        // console.log(`[WS-HEARTBEAT] Sent ping to user ${user_id}, missed_pings: ${connection.missed_pings}`);
      } catch (error) {
        console.error(`[WS-HEARTBEAT] Error sending ping to user ${user_id}:`, error);
        // connection.connection_status = "stale";
      }
    });
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
function handlePongResponse(user_id: string) {
  const connection = socket_connections.get(user_id);
  if (connection) {
    connection.missed_pings = 0;
    // console.log(`[WS-HEARTBEAT] Received pong from user ${user_id}`);
  }
}

// =============================================================================
// Connection Statistics & Enhanced Logging
// =============================================================================

// Log detailed connection error with context
function logConnectionError(
  context: string,
  user_id: string | undefined,
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
    connection_stats: {
      total_ws_cnx: socket_connections.size,
      total_polling_cnx: polling_connections.size,
    },
    ...additional_info,
  };

  console.error(`[CONNECTION-ERROR] ${JSON.stringify(errorLog)}`);
}

function startStatsLogging() {
  if (statsInterval) {
    clearInterval(statsInterval);
  }

  statsInterval = setInterval(() => {
    console.log(`[CONNECTION-STATS] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      total_ws_cnx: socket_connections.size,
      total_polling_cnx: polling_connections.size,
    })}`);
  }, STATS_LOGGING_INTERVAL_MS);

  console.log('[CONNECTION-STATS] Started periodic stats logging');
}

function stopStatsLogging() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}


// =============================================================================
// Starting services and graceful shutdown
// =============================================================================
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
