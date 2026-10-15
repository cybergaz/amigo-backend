import { DB_FINGERPRINT, REDIS_NS } from "./identity";

// =============================================================================
// Redis key builders for cluster state (SYNC_V2 §13.4, P-9)
// =============================================================================
// Every NEW key and channel goes through here so it carries the deployment
// namespace (`p:` prod, `d:` dev). Existing keys (pending store, receipts,
// caches) and the existing un-prefixed channels are deliberately NOT renamed
// (§13.4 note): renaming them on deploy would orphan live data (a week of
// pending queues, membership sets) and split old/new workers during an A/B
// swap onto different channels. They are listed under `legacy` so every name
// is in one place, unchanged.

const ns = (s: string) => `${REDIS_NS}:${s}`;
// Keys whose holder ACTS on the shared world (fires call timeouts, claims a
// daily job) are also scoped to the DB this worker serves, the same filter
// the beat / boot guard apply. REDIS_NS alone depends on env detection; a
// dev box that resolved to "p" would otherwise win ZREMs on prod's ring
// deadlines (and clear prod's un-namespaced call cache) or claim prod's
// daily jobs. Workers of one deployment share DB_URL host/port/db, so they
// still share these keys.
const ns_db = (s: string) => `${REDIS_NS}:${DB_FINGERPRINT}:${s}`;

const k = {
  // Liveness of one worker: the key existing (TTL 15 s) IS the liveness.
  worker: (wid: string) => ns(`worker:${wid}`),
  // Index of worker ids by last beat (ms). Lets a reader find candidates
  // without SCAN over the shared keyspace; liveness still comes from worker().
  workers: () => ns("workers"),
  // run_daily() marker: holds the claiming wid for ≤10 min while the job
  // runs, then the ISO finish time until the next run is due (§13.8).
  jobs_last: (name: string) => ns_db(`jobs:last:${name}`),
  // Ring deadlines: call_id → deadline (ms). DB-scoped on purpose: dev and
  // prod share one Redis (V14), and a dev worker ticking prod's call ids
  // would "time out" prod calls against the dev DB.
  ring_deadline: () => ns_db("calls:ring_deadline"),

  // ---- RC-2 presence + routing (§13.4) ------------------------------------
  // `{uid}` is a hash tag: both presence keys of one user land in the same
  // slot, so PRESENCE_CLAIM (2 keys) stays legal on a sharded Redis (V15).
  // Value "wid|cid|bg", TTL 45 s, refreshed every 15 s by the owner.
  presence_ws: (uid: string) => ns(`presence:{${uid}}:ws`),
  // Value "wid|bg", TTL 12 s (v1 poll lease), set on every poll / send.
  presence_poll: (uid: string) => ns(`presence:{${uid}}:poll`),
  // Last background state the user ANNOUNCED ("1" / "0": connection:status,
  // bg=1 / bg=0 on a poll, the WS open's bg), TTL 7 days. The cluster-wide
  // twin of presence-flags.ts's in-process hint: an old (4.2.2) app sends no
  // bg, so a poll lease created on a worker that never saw its announcement
  // must still start 'background'.
  presence_hint: (uid: string) => ns(`presence:{${uid}}:hint`),
  // uids a worker claimed (for the RC-3 reaper). TTL 60 s, refreshed.
  presence_by_worker: (wid: string) => ns(`presence:by_worker:{${wid}}`),
  // Per-worker inbox channel (§13.6.2). One PUBLISH per remote worker per
  // fan-out; the owner's bus subscriber delivers to its local sockets.
  inbox: (wid: string) => ns(`ws:deliver:${wid}`),

  // ---- Sync v2 R1a ---------------------------------------------------------
  // Capability lease (§3.13): "2" while the client speaks sync proto 2, EX 1
  // day. `{uid}` hash tag: same slot as the presence keys, so R1b's pending
  // suppression can MGET it in the router's presence pipeline. Written only
  // with app_settings.sync_v2_proto_lease on.
  proto: (uid: string) => ns(`proto:{${uid}}`),
  // Chats whose receipt mins may have moved (§3.7, a hint). DB-scoped: the
  // runner that drains it writes this deployment's Postgres.
  minwm_dirty: () => ns_db("minwm:dirty"),

  // ---- R3 poll v2 (§13.4, §13.17.2) -----------------------------------------
  // "{wid}|{req_id}" of the user's parked long-poll, EX wait+5. Written only
  // in routing `on` with a live sibling (at N=1 the waiter is in-process and
  // a nudge never needs Redis). A new request swaps it (old value back →
  // supersede that worker's waiter); fan-outs read it in the router's
  // presence pipeline to nudge the worker that holds it. `{uid}` hash tag:
  // same slot as the user's presence keys, so it rides their pipeline.
  poll_waiter: (uid: string) => ns(`poll:waiter:{${uid}}`),

  // ---- RC-3 (§13.4, §13.6.6, §13.7) ----------------------------------------
  // Channel: an app setting changed (payload = the setting's key). Workers
  // drop their in-process copy at once instead of waiting out its TTL (E5–E7).
  settings_invalidate: () => ns("settings:invalidate"),
  // Reaper claim for a dead worker: whoever SETs it NX releases that
  // worker's presence keys and announces its users offline (once).
  reap: (wid: string) => ns(`reap:${wid}`),
  // redis_lease(): "{wid}|{fence}" while held; the fence counter only grows,
  // so a holder that lost its lease can never write after the next one took
  // over. DB-scoped: leased jobs act on this deployment's users (D3). `{job}`
  // is a hash tag: the lease scripts touch two of these keys at once.
  lease: (job: string) => ns_db(`lease:{${job}}`),
  lease_fence: (job: string) => ns_db(`lease:{${job}}:fence`),
  // Fenced progress of a leased job (the FCM broadcast's keyset cursor).
  lease_cursor: (job: string) => ns_db(`lease:{${job}}:cursor`),

  // ---- R1b network telemetry (§14.13, §14.14) ------------------------------
  // FCM health per user per UTC day (yyyymmdd): hash {sent, fast}, EX 8 days.
  // `{uid}` hash tag like every per-user key.
  fcm_health: (uid: string, day: string) => ns(`fcm:h:{${uid}}:${day}`),
  // Same counters summed over every user, per day: the admin page reads 7
  // keys instead of scanning per-user ones.
  fcm_health_all: (day: string) => ns(`fcm:h:all:${day}`),
  // Beacon rate limit: SET NX EX 60 per user (§14.14).
  beacon_rl: (uid: string) => ns(`net:beacon:rl:{${uid}}`),
  // Beacon queue (LIST) drained into PG net_beacons by the flusher. DB-scoped:
  // the flusher writes this deployment's Postgres.
  beacons: () => ns_db("net:beacons"),
};

// Pre-existing names, kept verbatim (see header). Dev has its own Redis now
// (ops item "Give dev its own Redis"), which is what makes leaving these
// un-prefixed safe (§13.4: V14 was the blocker).
const legacy = {
  ws_broadcast_channel: "ws:broadcast",
  ws_force_logout_channel: "ws:force_logout",
  conv_invalidate_channel: "conv:invalidate",
  user_peer_invalidate_channel: "user_peer:invalidate",
  fcm_invalidate_channel: "fcm:invalidate",
};

export { k, legacy };
