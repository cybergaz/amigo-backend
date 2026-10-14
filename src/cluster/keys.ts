import { DB_FINGERPRINT, REDIS_NS } from "./identity";

// =============================================================================
// Redis key builders for cluster state (SYNC_V2 §13.4, P-9)
// =============================================================================
// Every NEW key goes through here so it carries the deployment namespace
// (`p:` prod, `d:` dev). Existing keys (pending store, receipts, caches) are
// untouched until RC-2/RC-3 move them.

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
};

export { k };
