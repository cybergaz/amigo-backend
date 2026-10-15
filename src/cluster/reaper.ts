import { count } from "@/utils/counters";
import { own_beat_fresh } from "./beat";
import { WORKER_ID } from "./identity";
import { is_draining, track } from "./lifecycle";
import { presence_authoritative } from "./mode";
import { create_presence } from "./presence-store";
import { create_reaper } from "./reaper-core";
import { deadline, rfast } from "./redis-fast";

// =============================================================================
// Dead-worker reaper, scheduling (SYNC_V2 §13.6.6; one pass: reaper-core.ts)
// =============================================================================
// Runs only in routing mode `on`: in `local` there are no presence keys, and
// in `shadow` peers' presence is still decided locally (keys simply expire).
// Every worker ticks every 5 s; the reap:{wid} claim makes exactly one of
// them act on each dead worker. The offline announcement itself belongs to
// the socket layer (register_reap_offline_notifier, from socket.server.ts),
// so this module never imports it (cycle).

const REAP_TICK_MS = 5_000;
// The whole pass (EXISTS pipeline + per dead worker: claim, SMEMBERS,
// release, lookup) on rfast. Generous: rare, and off every request path.
const REAP_DEADLINE_MS = 5_000;

type OfflineNotifier = (uids: string[]) => Promise<void>;
let notify_offline: OfflineNotifier | null = null;

const register_reap_offline_notifier = (fn: OfflineNotifier) => {
  notify_offline = fn;
};

// self_healthy: our own beat reached Redis within 2 intervals. After a
// Redis blip every beat key may have expired, ours included; reaping then
// would release live siblings' users and announce them offline.
const reaper = create_reaper(rfast, WORKER_ID, create_presence(rfast, WORKER_ID), undefined, {
  self_healthy: () => {
    const ok = own_beat_fresh();
    if (!ok) count("CLUSTER", "reaper_skipped_stale_beat");
    return ok;
  },
});

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;

const tick = () => {
  if (running || is_draining()) return;
  running = track(
    (async () => {
      const results = await deadline(reaper.reap_once(), REAP_DEADLINE_MS, "reaper pass");
      for (const r of results) {
        count("CLUSTER", "reaped_workers");
        count("CLUSTER", "reaped_users", r.released.length);
        console.warn(
          `[CLUSTER] reaped dead worker ${r.wid}: indexed=${r.members} released=${r.released.length} offline=${r.offline.length}`,
        );
        if (r.offline.length > 0 && notify_offline) {
          try {
            await notify_offline(r.offline);
          } catch (err: any) {
            console.error(`[CLUSTER] reaper offline announce failed: ${err?.message ?? err}`);
          }
        }
      }
    })(),
  )
    .catch((err: any) => {
      count("CLUSTER", "reaper_failed");
      console.error(`[CLUSTER] reaper pass failed: ${err?.message ?? err}`);
    })
    .finally(() => {
      running = null;
    });
};

/** Boot: start ticking (mode `on` only). Returns the drain stopper. */
const start_reaper = (): (() => Promise<void>) => {
  if (!presence_authoritative() || timer) return async () => { };
  timer = setInterval(tick, REAP_TICK_MS);
  console.log(`[CLUSTER] reaper started (every ${REAP_TICK_MS / 1000}s)`);
  return async () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (running) await running;
  };
};

export { start_reaper, register_reap_offline_notifier };
