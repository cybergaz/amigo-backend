import { redis } from "@/config/redis";
import { broadcast_to_all } from "./socket.handlers";
import { socket_connections } from "./connections";
import { AuthError } from "@/constants/auth-codes";
import type { WSMessage } from "@/types/socket.types";
import { bus } from "@/cluster/bus";
import { legacy } from "@/cluster/keys";
import { release_soon } from "@/cluster/presence";

// ────────────────────────────────────────────────────────────────────────────
// Cross-instance global WS broadcast.
//
// Every worker holds only its own sockets, so a "send to everyone" can't just
// iterate the local map — it must fan out to every worker. Any worker
// PUBLISHES a serialized WSMessage on the broadcast channel, and every worker
// (including the publisher) receives it on the shared bus subscriber
// (cluster/bus.ts, SYNC_V2 §13.3) and delivers to its local sockets via
// broadcast_to_all(). Publishing-only on the hot path keeps it a single code
// path. Channel names are the pre-RC-2 ones, unchanged (keys.ts `legacy`).
// ────────────────────────────────────────────────────────────────────────────

const WS_BROADCAST_CHANNEL = legacy.ws_broadcast_channel;
// Single-device force-logout. Published by auth.service.force_logout_other_devices
// on a new login; every worker receives it and whichever holds the victim's socket
// nudges it to log out and closes it (4003). Cluster-safe replacement for the old
// per-worker socket_connections.get() kick that could never reach another worker.
const WS_FORCE_LOGOUT_CHANNEL = legacy.ws_force_logout_channel;

bus.on(WS_BROADCAST_CHANNEL, (raw) => {
  const message = JSON.parse(raw) as WSMessage;
  broadcast_to_all(message);
});

bus.on(WS_FORCE_LOGOUT_CHANNEL, (raw) => {
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
        // Compare-and-delete (SYNC_V2 R0): the new device's socket can
        // register inside this 100ms window — never evict it.
        if (socket_connections.get(user_id)?.ws.raw === conn.ws.raw) {
          socket_connections.delete(user_id);
        }
        // A8 (RC-2): and its presence key — compare-delete by this socket's
        // cid, so the new device's key (any worker) survives.
        release_soon(user_id, conn.cid);
      }
    }, 100);
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
