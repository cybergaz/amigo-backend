import { redis, get_new_redis_client } from "@/config/redis";
import { broadcast_to_all } from "./socket.handlers";
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

const sub = get_new_redis_client(process.env.REDIS_URL);
sub.subscribe(WS_BROADCAST_CHANNEL, (err, count) => {
  if (err) {
    console.error(`[WS-BROADCAST] Failed to subscribe:`, err);
  } else {
    console.log(
      `Subscribed successfully to "${WS_BROADCAST_CHANNEL}", This client is currently subscribed to ${count} channels.`,
    );
  }
});

sub.on("message", (channel, raw) => {
  if (channel !== WS_BROADCAST_CHANNEL) return;
  try {
    const message = JSON.parse(raw) as WSMessage;
    broadcast_to_all(message);
  } catch (err) {
    console.error(`[WS-BROADCAST] Failed to handle message:`, err);
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
