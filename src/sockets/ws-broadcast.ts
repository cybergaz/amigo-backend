import { redis, get_new_redis_client } from "@/config/redis";
import { broadcast_to_all } from "./socket.handlers";
import { socket_connections } from "./socket.server";
import { AuthError } from "@/constants/auth-codes";
import type { WSMessage } from "@/types/socket.types";

// ────────────────────────────────────────────────────────────────────────────
// Cross-instance global WS broadcast.
//
// The server runs multiple PM2 instances, each holding its own socket_connections
// map. A "send to everyone" therefore can't just iterate the local map — it must
// fan out to every instance. We do that over Redis pub/sub: any instance PUBLISHES
// a serialized WSMessage on WS_BROADCAST_CHANNEL, and every instance (including the
// publisher) receives it on its subscriber and delivers to its local sockets via
// broadcast_to_all(). Publishing-only on the hot path keeps it a single code path.
// ────────────────────────────────────────────────────────────────────────────

const WS_BROADCAST_CHANNEL = "ws:broadcast";
// Single-device force-logout. Published by auth.service.force_logout_other_devices
// on a new login; every worker receives it and whichever holds the victim's socket
// nudges it to log out and closes it (4003). Cluster-safe replacement for the old
// per-worker socket_connections.get() kick that could never reach another worker.
const WS_FORCE_LOGOUT_CHANNEL = "ws:force_logout";

const sub = get_new_redis_client(process.env.REDIS_URL);
sub.subscribe(WS_BROADCAST_CHANNEL, WS_FORCE_LOGOUT_CHANNEL, (err, count) => {
  if (err) {
    console.error(`[WS-BROADCAST] Failed to subscribe:`, err);
  } else {
    console.log(
      `Subscribed successfully to WS channels. This client is currently subscribed to ${count} channels.`,
    );
  }
});

sub.on("message", (channel, raw) => {
  try {
    if (channel === WS_BROADCAST_CHANNEL) {
      const message = JSON.parse(raw) as WSMessage;
      broadcast_to_all(message);
    } else if (channel === WS_FORCE_LOGOUT_CHANNEL) {
      const { user_id } = JSON.parse(raw) as { user_id: string };
      const conn = socket_connections.get(user_id);
      if (conn && conn.ws.readyState === 1) {
        conn.ws.send({
          type: "auth:force_logout",
          auth_error: AuthError.SESSION_REVOKED,
          payload: {
            message: "You have been logged out because you logged in on another device",
            code: 499,
          },
          ws_timestamp: new Date(),
        }, true);
        // Brief delay so the frame flushes before the close.
        setTimeout(() => {
          if (conn.ws.readyState === 1) {
            conn.ws.close(4003, "Logged out due to new login on another device");
            socket_connections.delete(user_id);
          }
        }, 100);
      }
    }
  } catch (err) {
    console.error(`[WS-BROADCAST] Failed to handle message on ${channel}:`, err);
  }
});

/** Deliver a WSMessage to every connected client across all instances. */
export const publish_global_broadcast = async (
  message: WSMessage,
): Promise<void> => {
  try {
    await redis.publish(WS_BROADCAST_CHANNEL, JSON.stringify(message));
  } catch (err) {
    console.error(`[WS-BROADCAST] publish failed:`, err);
  }
};
