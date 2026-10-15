// =============================================================================
// Network beacon intake + flusher (SYNC_V2 §14.14); rules: net-beacon-core.ts
// =============================================================================
// POST /api/net/beacon (routes/net.routes.ts) → accept_beacon:
//   - only while net_beacon_active (app_settings.sync_v2_net_telemetry on AND
//     the 20261023 marker): otherwise the route answers 404, like an old
//     backend, and nothing is written;
//   - SET net:beacon:rl:{uid} NX EX 60 — over the limit → 204, dropped;
//   - RPUSH onto the DB-scoped queue, LTRIM to BEACON_QUEUE_MAX (the Redis is
//     noeviction: a stalled flusher must not grow it without bound).
// Flusher (every 30 s, every worker; one runs at a time under the job lock):
//   LRANGE 0..499 → one INSERT → LTRIM past them, repeated while full.
//   At-least-once between INSERT and LTRIM; a beacon trimmed by the cap while
//   a batch is in flight can be lost — telemetry, not state.
// Retention: a daily job deletes rows older than 14 days (D-N6) in batches.
// =============================================================================
import { pg_client } from "@/config/db";
import { sync_v2_flags } from "@/services/app-settings.service";
import { k } from "@/cluster/keys";
import { deadline, rfast } from "@/cluster/redis-fast";
import { run_daily, run_pg_singleton_sql } from "@/cluster/jobs";
import { is_draining, track } from "@/cluster/lifecycle";
import { count } from "@/utils/counters";
import { net_beacon_active } from "./sync/flags-core";
import {
  decode_queued,
  delete_old_beacons_sql,
  encode_queued,
  insert_beacons_sql,
  net_health_sql,
  type QueuedBeacon,
} from "./net-beacon-core";

const RATE_LIMIT_S = 60;
const BEACON_QUEUE_MAX = 5_000;
const FLUSH_EVERY_MS = 30_000;
const FLUSH_BATCH = 500;
const FLUSH_MAX_BATCHES = 20;
const RETENTION_DAYS = 14;
const RETENTION_BATCH = 5_000;
const RETENTION_CHECK_MS = 10 * 60_000;
const REDIS_DEADLINE_MS = 1_000;

export type AcceptResult = "accepted" | "rate_limited" | "failed";

export const accept_beacon = async (
  user_id: string,
  b: { payload: Record<string, unknown>; app_ver: string; ip24: string | null },
): Promise<AcceptResult> => {
  try {
    const first = await deadline(
      rfast.set(k.beacon_rl(user_id), "1", "EX", RATE_LIMIT_S, "NX"),
      REDIS_DEADLINE_MS,
      "beacon rl",
    );
    if (first !== "OK") {
      count("NET", "beacon_rate_limited");
      return "rate_limited";
    }
    const item: QueuedBeacon = { u: user_id, t: Date.now(), ip: b.ip24, av: b.app_ver, p: b.payload };
    const res = await deadline(
      rfast.pipeline().rpush(k.beacons(), encode_queued(item)).ltrim(k.beacons(), -BEACON_QUEUE_MAX, -1).exec(),
      REDIS_DEADLINE_MS,
      "beacon push",
    );
    const err = res?.find(([e]) => e)?.[0];
    if (err) throw err;
    const len = Number(res?.[0]?.[1] ?? 0);
    if (len > BEACON_QUEUE_MAX) count("NET", "beacon_queue_trimmed", len - BEACON_QUEUE_MAX);
    count("NET", "beacon_accepted");
    return "accepted";
  } catch (err: any) {
    count("NET", "beacon_store_failed");
    console.error(`[NET] beacon store failed: ${err?.message ?? err}`);
    return "failed";
  }
};

// One batch under the job lock: read the head, insert, trim exactly what was
// read. Returns rows taken off the queue (0 = empty or another worker holds
// the lock).
const flush_batch = async (): Promise<number> => {
  const n = await run_pg_singleton_sql("net_beacons_flush", async (tx) => {
    const raw = await deadline(rfast.lrange(k.beacons(), 0, FLUSH_BATCH - 1), REDIS_DEADLINE_MS, "beacon lrange");
    if (raw.length === 0) return 0;
    const items: QueuedBeacon[] = [];
    for (const r of raw) {
      const b = decode_queued(r);
      if (b) items.push(b);
      else count("NET", "beacon_corrupt");
    }
    const written = await insert_beacons_sql(tx, items);
    count("NET", "beacons_flushed", written);
    await deadline(rfast.ltrim(k.beacons(), raw.length, -1), REDIS_DEADLINE_MS, "beacon ltrim");
    return raw.length;
  });
  return n ?? 0;
};

/** Drain the queue into PG now (≤ FLUSH_MAX_BATCHES batches). Rows taken. */
export const flush_net_beacons_once = async (): Promise<number> => {
  let total = 0;
  for (let i = 0; i < FLUSH_MAX_BATCHES && !is_draining(); i++) {
    const n = await flush_batch();
    total += n;
    if (n < FLUSH_BATCH) break;
  }
  return total;
};

let flushing: Promise<unknown> | null = null;

const flush_tick = () => {
  if (flushing || is_draining() || !net_beacon_active(sync_v2_flags())) return;
  flushing = track(flush_net_beacons_once())
    .catch((err: any) => {
      count("NET", "beacon_flush_failed");
      console.error(`[NET] beacon flush failed: ${err?.message ?? err}`);
    })
    .finally(() => {
      flushing = null;
    });
};

const retention_once = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  let total = 0;
  for (let i = 0; i < 200 && !is_draining(); i++) {
    const n = await run_pg_singleton_sql("net_beacons_retention", (tx) =>
      delete_old_beacons_sql(tx, cutoff, RETENTION_BATCH));
    if (!n) break;
    total += n;
    if (n < RETENTION_BATCH) break;
  }
  return total;
};

let retention_running: Promise<unknown> | null = null;

/** Boot: flusher + daily retention (both idle while telemetry is off). */
export { retention_once as net_beacons_retention_once };

export const start_net_beacons = (): (() => Promise<void>) => {
  const flush_timer = setInterval(flush_tick, FLUSH_EVERY_MS);
  const retention_timer = setInterval(() => {
    if (retention_running || is_draining() || !sync_v2_flags().markers.net_beacons) return;
    retention_running = track(run_daily("net_beacons_retention", retention_once)).finally(() => {
      retention_running = null;
    });
  }, RETENTION_CHECK_MS);
  flush_timer.unref?.();
  retention_timer.unref?.();
  return async () => {
    clearInterval(flush_timer);
    clearInterval(retention_timer);
    if (flushing) await flushing;
  };
};

/** GET /admin/net-health: beacon aggregates (when the table exists) + queue length. */
export const net_health = async (hours: number) => {
  const f = sync_v2_flags();
  const [beacons, queue] = await Promise.all([
    f.markers.net_beacons ? net_health_sql(pg_client, hours) : Promise.resolve(null),
    deadline(rfast.llen(k.beacons()), REDIS_DEADLINE_MS, "beacon llen").catch(() => null),
  ]);
  return { enabled: net_beacon_active(f), telemetry: f.net_telemetry, table: f.markers.net_beacons, queue, beacons };
};
