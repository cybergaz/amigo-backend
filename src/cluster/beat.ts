import { statSync } from "node:fs";
import { count } from "@/utils/counters";
import {
  CLUSTER_MAX,
  DB_FINGERPRINT,
  GIT_REV,
  HOSTNAME,
  INSTANCE_ID,
  SLOT_ID,
  STARTED_AT,
  SWAP_FILE,
  WORKER_ID,
} from "./identity";
import { k } from "./keys";
import { deadline, rfast } from "./redis-fast";
import { drain_sleep, event_loop_lag_ms, is_draining, state } from "./lifecycle";

// =============================================================================
// Worker beat + boot guard (SYNC_V2 §13.3 beat.ts, §13.9.2 step 4)
// =============================================================================
// Every 5 s: SET {ns}:worker:{wid} <json> EX 15, ZADD {ns}:workers <ms> <wid>.
// The TTL key existing IS the liveness signal (no wall-clock comparisons): a
// crashed or wedged worker stops beating and disappears within 15 s. The ZSET
// is only an index so readers never SCAN the shared keyspace.
//
// At N=1 the beat has two readers: the boot guard (refuse a stray second
// worker) and the drain (is there a live sibling to hand users to?).

const BEAT_INTERVAL_MS = 5_000;
const BEAT_TTL_S = 15;
// Index entries older than this are pruned (a crashed worker's ZSET entry is
// never ZREM'd by itself).
const WORKERS_INDEX_PRUNE_MS = 60 * 60 * 1000;
// Candidates are read from the index by recent score; generous so clock skew
// between boxes (later) cannot hide a live worker. Liveness is the key.
const WORKERS_INDEX_WINDOW_MS = 120_000;
// A swap file younger than this authorises a second worker (deploy.sh).
const SWAP_FRESH_MS = 180_000;
const BOOT_GUARD_RECHECK_MS = 5_000;
// After this many consecutive Redis failures the guard lets the boot
// proceed: a Redis blip during a legitimate restart must not keep the only
// worker down (fail-open; a stray second worker during a Redis outage is
// the lesser risk).
const BOOT_GUARD_MAX_ERRORS = 3;

type WorkerBeat = {
  wid: string;
  host: string;
  inst: string;
  slot: string;
  pid: number;
  rev: string;
  db: string;
  started: number;
  ts: number;
  ws: number;
  poll: number;
  lag_ms: number;
  // Listening and passed the boot guard. A worker that is still booting (or
  // refused by its guard) beats with ready:false; it is nobody's sibling.
  ready: boolean;
};

type BeatStats = () => { ws: number; poll: number };

let stats_provider: BeatStats = () => ({ ws: 0, poll: 0 });
let beat_timer: ReturnType<typeof setInterval> | null = null;
let beat_in_flight: Promise<void> | null = null;
let beat_count = 0;
let last_beat_error_log_at = 0;

const build_beat = (): WorkerBeat => {
  const stats = stats_provider();
  return {
    wid: WORKER_ID,
    host: HOSTNAME,
    inst: INSTANCE_ID,
    slot: SLOT_ID,
    pid: process.pid,
    rev: GIT_REV,
    db: DB_FINGERPRINT,
    started: STARTED_AT,
    ts: Date.now(),
    ws: stats.ws,
    poll: stats.poll,
    lag_ms: event_loop_lag_ms(),
    ready: state.ready && !state.draining,
  };
};

const write_beat = async (): Promise<void> => {
  const beat = build_beat();
  const pipe = rfast
    .pipeline()
    .set(k.worker(WORKER_ID), JSON.stringify(beat), "EX", BEAT_TTL_S)
    .zadd(k.workers(), beat.ts, WORKER_ID);
  if (++beat_count % 12 === 0) {
    pipe.zremrangebyscore(k.workers(), "-inf", beat.ts - WORKERS_INDEX_PRUNE_MS);
  }
  await deadline(pipe.exec(), 1_000, "worker beat");
};

const beat_once = () => {
  if (beat_in_flight) return; // never stack beats on a slow Redis
  beat_in_flight = write_beat()
    .catch((err) => {
      count("CLUSTER", "beat_failed");
      const now = Date.now();
      if (now - last_beat_error_log_at >= 60_000) {
        last_beat_error_log_at = now;
        console.error(`[CLUSTER] worker beat failed: ${err?.message ?? err}`);
      }
    })
    .finally(() => {
      beat_in_flight = null;
    });
};

const start_beat = (provider?: BeatStats) => {
  if (provider) stats_provider = provider;
  if (beat_timer) return;
  beat_once();
  beat_timer = setInterval(beat_once, BEAT_INTERVAL_MS);
  console.log(`[CLUSTER] worker beat started wid=${WORKER_ID} rev=${GIT_REV}`);
};

// Beat right now (e.g. the moment we become ready) instead of ≤5 s later.
const beat_now = () => {
  if (beat_timer) beat_once();
};

// Stop beating and remove our key, so siblings / a booting worker stop
// counting us at once instead of after the 15 s TTL.
const stop_beat_and_delete = async (): Promise<void> => {
  if (beat_timer) {
    clearInterval(beat_timer);
    beat_timer = null;
  }
  if (beat_in_flight) await beat_in_flight;
  try {
    await deadline(
      rfast.pipeline().del(k.worker(WORKER_ID)).zrem(k.workers(), WORKER_ID).exec(),
      1_000,
      "beat delete",
    );
  } catch (err: any) {
    console.error(`[CLUSTER] beat delete failed (expires in ≤${BEAT_TTL_S}s): ${err?.message ?? err}`);
  }
};

// Live, READY workers of THIS deployment other than ourselves: key present,
// same DB, ready flag set. Counting only ready workers means two workers that
// boot at the same moment cannot refuse each other forever, and a refused
// stray is never mistaken for a sibling that can take our users.
// Throws on Redis failure (callers decide what failure means).
const list_live_siblings = async (): Promise<WorkerBeat[]> => {
  const now = Date.now();
  const wids = (await deadline(
    rfast.zrangebyscore(k.workers(), now - WORKERS_INDEX_WINDOW_MS, "+inf"),
    1_000,
    "workers index",
  )) as string[];
  const others = wids.filter((w) => w !== WORKER_ID);
  if (others.length === 0) return [];
  const raws = (await deadline(
    rfast.mget(...others.map((w) => k.worker(w))),
    1_000,
    "worker keys",
  )) as (string | null)[];
  const out: WorkerBeat[] = [];
  for (const raw of raws) {
    if (!raw) continue; // TTL expired → dead (or drained: key deleted)
    try {
      const b = JSON.parse(raw) as WorkerBeat;
      if (b.db === DB_FINGERPRINT && b.ready === true) out.push(b);
    } catch { }
  }
  return out;
};

// Drain helper: is anyone else live to take our users? Errors → "no", so the
// drain uses the short schedule (users are not left waiting 45 s for a
// sibling we cannot prove exists).
const has_live_sibling = async (): Promise<boolean> => {
  try {
    return (await list_live_siblings()).length > 0;
  } catch (err: any) {
    console.error(`[CLUSTER] sibling check failed: ${err?.message ?? err}`);
    return false;
  }
};

const swap_file_age_ms = (): number | null => {
  try {
    return Date.now() - statSync(SWAP_FILE).mtimeMs;
  } catch {
    return null; // missing / unreadable
  }
};

// §13.9.2 step 4. While CLUSTER_MAX=1, refuse to become ready next to another
// fresh worker of the same deployment unless deploy.sh authorised it by
// touching SWAP_FILE within the last 180 s. Ignored on purpose:
//   - earlier boots of OUR slot (same host:INSTANCE_ID): a crash-restart or a
//     tmux restart is a replacement, not a second instance — and if that old
//     process were really still alive, binding the same ports would fail;
//   - workers serving another DB (dev on the shared Redis).
// Never blocks a first start: with no other beat it returns immediately.
// Resolves when allowed; while refused it re-checks every 5 s (the other
// worker may drain away), and returns early if a drain starts.
const run_boot_guard = async (): Promise<void> => {
  if (CLUSTER_MAX !== 1) return;
  let errors = 0;
  let last_refusal_log_at = 0;
  while (!is_draining()) {
    let others: WorkerBeat[];
    try {
      others = (await list_live_siblings()).filter((b) => b.slot !== SLOT_ID);
      errors = 0;
    } catch (err: any) {
      errors++;
      console.error(`[CLUSTER] boot guard: worker lookup failed (${errors}/${BOOT_GUARD_MAX_ERRORS}): ${err?.message ?? err}`);
      if (errors >= BOOT_GUARD_MAX_ERRORS) {
        console.warn("[CLUSTER] boot guard: Redis unavailable, proceeding without the check");
        return;
      }
      await drain_sleep(BOOT_GUARD_RECHECK_MS);
      continue;
    }
    if (others.length === 0) return;

    const age = swap_file_age_ms();
    const names = others.map((b) => `${b.wid}(rev=${b.rev})`).join(", ");
    if (age !== null && age < SWAP_FRESH_MS) {
      console.log(`[CLUSTER] boot guard: swap authorised (${SWAP_FILE} age ${Math.round(age / 1000)}s), live: ${names}`);
      return;
    }
    const now = Date.now();
    if (now - last_refusal_log_at >= 30_000) {
      last_refusal_log_at = now;
      count("CLUSTER", "refused_second_instance");
      console.error(
        `[CLUSTER] refused_second_instance: live worker(s) ${names}; ${SWAP_FILE} ${age === null ? "missing" : `is ${Math.round(age / 1000)}s old`} — staying not-ready (CLUSTER_MAX=1)`,
      );
    }
    await drain_sleep(BOOT_GUARD_RECHECK_MS);
  }
};

export {
  start_beat,
  beat_now,
  stop_beat_and_delete,
  list_live_siblings,
  has_live_sibling,
  run_boot_guard,
};
export type { WorkerBeat };
