import type Redis from "ioredis";
import { get_new_redis_client, redis } from "@/config/redis";
import { count } from "@/utils/counters";
import { register_ready_check } from "./lifecycle";

// =============================================================================
// The worker's one pub/sub subscriber (SYNC_V2 §13.3 bus.ts)
// =============================================================================
// Before RC-2 every module that listened to a channel opened its own
// subscriber connection (conv.cache, user-peer.cache ×2, fcm-token.cache,
// ws-broadcast): 5–6 Redis connections per worker, each with its own
// reconnect behaviour and none with an error listener. Now there is one
// connection; modules register handlers by channel.
//
//   bus.on(channel, fn)     subscribe (first handler) + dispatch
//   bus.on_resync(fn)       run after the subscriber came back from a
//                           disconnect: messages published meanwhile were
//                           lost (pub/sub has no replay), so caches that
//                           rely on invalidations must drop what they hold
//                           (RC-3 wires the cache clears)
//   bus.publish(ch, msg)    best-effort publish on the main connection
//
// Channel names are passed in by the caller unchanged: the legacy channels
// keep their un-prefixed names (keys.ts `legacy`), new ones come from k().

type Handler = (message: string, channel: string) => void;
type ResyncHandler = () => void | Promise<void>;

const handlers = new Map<string, Set<Handler>>();
const resync_handlers = new Set<ResyncHandler>();

let sub: Redis | null = null;
let lost_connection = false;
let last_error_log_at = 0;

const run_resync = () => {
  count("CLUSTER", "bus_resyncs");
  console.warn(`[CLUSTER] bus subscriber reconnected; running ${resync_handlers.size} resync handler(s)`);
  for (const fn of resync_handlers) {
    try {
      Promise.resolve(fn()).catch((err) => console.error("[CLUSTER] bus resync handler failed:", err));
    } catch (err) {
      console.error("[CLUSTER] bus resync handler threw:", err);
    }
  }
};

const ensure_sub = (): Redis => {
  if (sub) return sub;
  // Default ioredis options on purpose: the subscriber must queue its
  // SUBSCRIBE commands while (re)connecting and re-subscribe by itself
  // (autoResubscribe), unlike rfast which must fail fast.
  const s = get_new_redis_client();
  sub = s;
  s.on("message", (channel: string, message: string) => {
    const set = handlers.get(channel);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(message, channel);
      } catch (err) {
        console.error(`[CLUSTER] bus handler failed on ${channel}:`, err);
      }
    }
  });
  s.on("close", () => {
    lost_connection = true;
  });
  s.on("ready", () => {
    if (!lost_connection) return;
    lost_connection = false;
    run_resync();
  });
  s.on("error", (err) => {
    const now = Date.now();
    if (now - last_error_log_at < 30_000) return;
    last_error_log_at = now;
    console.error(`[CLUSTER] bus subscriber error: ${err?.message ?? err}`);
  });
  // readyz (§13.9.1 "bus subscriber ready"): without it force-logout, global
  // broadcasts, cache invalidations and the inbox never reach this worker.
  register_ready_check("bus", () => s.status === "ready");
  return s;
};

const on = (channel: string, fn: Handler): (() => void) => {
  const s = ensure_sub();
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    s.subscribe(channel).catch((err) =>
      console.error(`[CLUSTER] bus subscribe ${channel} failed:`, err),
    );
  }
  set.add(fn);
  return () => {
    const current = handlers.get(channel);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) {
      handlers.delete(channel);
      s.unsubscribe(channel).catch(() => { });
    }
  };
};

const on_resync = (fn: ResyncHandler): (() => void) => {
  resync_handlers.add(fn);
  return () => {
    resync_handlers.delete(fn);
  };
};

const publish = async (channel: string, message: string): Promise<number> => {
  try {
    return await redis.publish(channel, message);
  } catch (err) {
    console.error(`[CLUSTER] bus publish ${channel} failed:`, err);
    return 0;
  }
};

// Drain: close the subscriber last-but-one (before the main pools).
const quit = async (): Promise<void> => {
  if (!sub) return;
  try {
    await sub.quit();
  } catch {
    sub.disconnect();
  }
};

const subscribed_channels = (): string[] => Array.from(handlers.keys());

const bus = { on, on_resync, publish, quit, subscribed_channels };

export { bus };
export type { Handler as BusHandler };
