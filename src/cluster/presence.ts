import { count } from "@/utils/counters";
import { WORKER_ID } from "./identity";
import { presence_writes } from "./mode";
import { deadline, rfast } from "./redis-fast";
import { PRESENCE_DEADLINE_MS, type Presence } from "./presence-core";
import { create_presence, type ClaimResult, type RefreshEntry } from "./presence-store";

// =============================================================================
// Presence registry for this worker (SYNC_V2 §13.3 presence.ts, §13.5)
// =============================================================================
// presence-store.ts bound to rfast (no offline queue, 400 ms command timeout)
// and WORKER_ID, with a hard deadline on every call so a slow Redis can never
// hold up an open, a close or a fan-out (P-7).
//
// Two flavours:
//   - awaited calls (claim, lookup, refresh_many) for the paths that act on
//     the answer — they reject on error / deadline, the caller degrades;
//   - fire-and-forget writes (*_soon) for paths that only need the registry
//     to converge. They are no-ops in `local` mode, so CLUSTER_ROUTING=local
//     adds zero Redis traffic.

const store = create_presence(rfast, WORKER_ID);

// Refresh is one pipeline per 250 sockets, off any request path; it may take
// longer than a single lookup without hurting anyone.
const REFRESH_DEADLINE_MS = 2_000;

let last_error_log_at = 0;
const log_write_failure = (op: string, err: unknown) => {
  count("CLUSTER", `presence_${op}_failed`);
  const now = Date.now();
  if (now - last_error_log_at < 30_000) return;
  last_error_log_at = now;
  console.error(`[CLUSTER] presence ${op} failed: ${(err as Error)?.message ?? err}`);
};

const claim = (uid: string, cid: string, bg: boolean): Promise<ClaimResult> =>
  deadline(store.claim(uid, cid, bg), PRESENCE_DEADLINE_MS, "presence claim");

const lookup = (uids: string[], opts: { waiters?: boolean } = {}): Promise<Presence[]> =>
  uids.length === 0
    ? Promise.resolve([])
    : deadline(store.lookup(uids, opts), PRESENCE_DEADLINE_MS, "presence lookup");

const refresh_many = (entries: RefreshEntry[]): Promise<number[]> =>
  entries.length === 0
    ? Promise.resolve([])
    : deadline(store.refresh_many(entries), REFRESH_DEADLINE_MS, "presence refresh");

const release = (uid: string, cid: string): Promise<boolean> =>
  deadline(store.release(uid, cid), PRESENCE_DEADLINE_MS, "presence release");

// ---- fire-and-forget ---------------------------------------------------------

const claim_soon = (uid: string, cid: string, bg: boolean): void => {
  if (!presence_writes()) return;
  claim(uid, cid, bg).catch((err) => log_write_failure("claim", err));
};

const release_soon = (uid: string, cid: string | undefined): void => {
  if (!presence_writes() || !cid) return;
  release(uid, cid).catch((err) => log_write_failure("release", err));
};

// The router found a ws key naming THIS worker for a user with no local
// socket (and not mid-open): a leftover of a socket whose release was lost.
// Compare-delete by its own cid, so a socket that claims meanwhile is safe.
const release_stale_soon = (uid: string, cid: string): void => {
  if (!presence_writes()) return;
  count("CLUSTER", "presence_stale_released");
  release(uid, cid).catch((err) => log_write_failure("release", err));
};

const release_owned_by_soon = (owner_wid: string, uids: string[]): void => {
  if (!presence_writes() || uids.length === 0) return;
  deadline(store.release_owned_by(owner_wid, uids), PRESENCE_DEADLINE_MS, "presence release_owned_by")
    .catch((err) => log_write_failure("release_owned_by", err));
};

const set_bg_soon = (uid: string, cid: string | undefined, bg: boolean): void => {
  if (!presence_writes() || !cid) return;
  deadline(store.set_bg(uid, cid, bg), PRESENCE_DEADLINE_MS, "presence set_bg")
    .catch((err) => log_write_failure("set_bg", err));
};

// `flag`: the client's explicit bg (null = none sent; the registry then keeps
// what it has). `fallback_bg`: this worker's lease status, for a new lease.
// `ttl_s` (poll v2): the lease must outlive the parked long-poll.
const set_poll_soon = (uid: string, flag: boolean | null, fallback_bg: boolean, ttl_s?: number): void => {
  if (!presence_writes()) return;
  deadline(store.touch_poll(uid, flag, fallback_bg, ttl_s), PRESENCE_DEADLINE_MS, "presence set_poll")
    .catch((err) => log_write_failure("set_poll", err));
};

const set_poll_bg_soon = (uid: string, bg: boolean): void => {
  if (!presence_writes()) return;
  deadline(store.set_poll_bg(uid, bg), PRESENCE_DEADLINE_MS, "presence set_poll_bg")
    .catch((err) => log_write_failure("set_poll_bg", err));
};

export {
  claim,
  lookup,
  refresh_many,
  release,
  claim_soon,
  release_soon,
  release_stale_soon,
  release_owned_by_soon,
  set_bg_soon,
  set_poll_soon,
  set_poll_bg_soon,
};
