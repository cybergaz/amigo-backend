import type Redis from "ioredis";
import { k } from "./keys";
import type { PresenceStore } from "./presence-store";

// =============================================================================
// Dead-worker reaper, one pass (SYNC_V2 §13.6.6 "Peers' UI", §13.7)
// =============================================================================
// A worker that dies (crash, OOM kill, a box gone) cannot release its
// users' presence keys or tell anyone they went offline. Routing already
// copes: its worker:{wid} beat key expires in ≤ 15 s and the router then
// treats its users as offline (FCM + pending store). What nobody did was
// tell their PEERS: their apps kept showing "online" until each ws key's own
// 45 s TTL ran out, and even then nothing announced "offline" (the debounce
// that does so lived in the dead process).
//
// One pass, on any live worker in routing mode `on`:
//   1. candidates = wids in the `workers` index that beat recently, minus
//      self; dead = no worker:{wid} key (one pipeline of EXISTS);
//   2. per dead wid: SET reap:{wid} NX EX 300 — exactly one worker reaps it;
//   3. SMEMBERS presence:by_worker:{wid}; PRESENCE_RELEASE by the prefix
//      "{wid}|" (a key the user's NEW socket wrote on a live worker names
//      another wid and is left alone);
//   4. of the users whose key was released, those with no ws and no poll key
//      left anywhere are returned as offline (the caller announces them);
//   5. DEL the index set and ZREM the wid, so it is never a candidate again.
// A wid is reaped ≤ 25 s after its last beat (15 s TTL + two 5 s ticks). A
// gracefully drained worker deletes its own beat key and ZREMs itself after
// releasing every socket, so it is never a candidate.
//
// Never on a guess (a Redis blip / failover lets EVERY beat key expire,
// live workers' too, and the first tick after it could reap a live sibling:
// its users are released and announced offline to all their peers):
//   - `self_healthy()` false (this worker's own beat failed recently, i.e.
//     we just had Redis trouble too) → the pass does nothing;
//   - a wid is reaped only when it was seen dead on two passes at least
//     `confirm_ms` apart, so a live sibling's next beat (every 5 s)
//     re-SETs its key in between.

const REAP_CLAIM_TTL_S = 300;
// Beat entries newer than this are candidates. A wid that stopped beating
// longer ago has nothing left to reap: its ws keys (45 s) and its index set
// (60 s) have expired on their own.
const REAP_CANDIDATE_WINDOW_MS = 120_000;

type ReapResult = { wid: string; members: number; released: string[]; offline: string[] };

type ReaperKeys = Pick<typeof k, "workers" | "worker" | "reap" | "presence_by_worker">;

// Two observations of "dead" at least one beat interval apart.
const REAP_CONFIRM_MS = 5_000;

type ReaperOpts = { confirm_ms?: number; self_healthy?: () => boolean };

const create_reaper = (
  client: Redis,
  self_wid: string,
  presence: PresenceStore,
  keys: ReaperKeys = k,
  opts: ReaperOpts = {},
) => {
  const confirm_ms = opts.confirm_ms ?? REAP_CONFIRM_MS;
  const self_healthy = opts.self_healthy ?? (() => true);
  // wid → when a pass first saw it dead (cleared when seen alive again).
  const suspects = new Map<string, number>();

  const find_dead = async (now: number): Promise<string[]> => {
    const wids = ((await client.zrangebyscore(keys.workers(), now - REAP_CANDIDATE_WINDOW_MS, "+inf")) as string[])
      .filter((w) => w !== self_wid);
    if (wids.length === 0) return [];
    const p = client.pipeline();
    for (const w of wids) p.exists(keys.worker(w));
    const rows = (await p.exec()) ?? [];
    // An EXISTS that errored reads as alive: never reap on a guess.
    return wids.filter((_, i) => {
      const [err, val] = rows[i] ?? [new Error("missing"), null];
      return !err && Number(val) === 0;
    });
  };

  const reap_wid = async (wid: string): Promise<ReapResult | null> => {
    const claimed = await client.set(keys.reap(wid), self_wid, "EX", REAP_CLAIM_TTL_S, "NX");
    if (claimed !== "OK") return null;
    const members = (await client.smembers(keys.presence_by_worker(wid))) as string[];
    const released = members.length > 0 ? await presence.release_owned_by_uids(wid, members) : [];
    let offline: string[] = [];
    if (released.length > 0) {
      const pres = await presence.lookup(released);
      offline = released.filter((_, i) => !pres[i]?.ws && !pres[i]?.poll);
    }
    await client.pipeline().del(keys.presence_by_worker(wid)).zrem(keys.workers(), wid).exec();
    return { wid, members: members.length, released, offline };
  };

  /** One pass. Throws on a Redis error (the next tick retries). */
  const reap_once = async (now = Date.now()): Promise<ReapResult[]> => {
    if (!self_healthy()) {
      suspects.clear(); // our own view of Redis is suspect: start over
      return [];
    }
    const dead = await find_dead(now);
    const dead_set = new Set(dead);
    for (const w of suspects.keys()) if (!dead_set.has(w)) suspects.delete(w);
    const confirmed: string[] = [];
    for (const w of dead) {
      const first = suspects.get(w);
      if (first === undefined) suspects.set(w, now);
      else if (now - first >= confirm_ms) confirmed.push(w);
    }
    if (confirm_ms <= 0) confirmed.splice(0, confirmed.length, ...dead);
    const out: ReapResult[] = [];
    for (const wid of confirmed) {
      suspects.delete(wid);
      const r = await reap_wid(wid);
      if (r) out.push(r);
    }
    return out;
  };

  return { reap_once, find_dead };
};

type Reaper = ReturnType<typeof create_reaper>;

export { create_reaper, REAP_CLAIM_TTL_S, REAP_CANDIDATE_WINDOW_MS, REAP_CONFIRM_MS };
export type { Reaper, ReapResult, ReaperOpts };
