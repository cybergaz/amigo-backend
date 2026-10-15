import { rfast, deadline } from "@/cluster/redis-fast";
import { k } from "@/cluster/keys";
import { WORKER_ID } from "@/cluster/identity";
import { presence_authoritative } from "@/cluster/mode";
import { is_sole_worker } from "@/cluster/beat";
import { track } from "@/cluster/lifecycle";
import { PRESENCE_DEADLINE_MS } from "@/cluster/presence-core";
import type { InboxMessage } from "@/cluster/router-core";
import { count } from "@/utils/counters";
import { POLL_COALESCE_JITTER_MS, POLL_COALESCE_MS } from "@/services/sync/poll-core";
import { sync_v2_flags } from "@/services/app-settings.service";
import {
  WaiterRegistry,
  apply_poll_inbox,
  create_waiter_redis,
  remote_waiters_by_wid,
  type PollWaiter,
} from "./sync-nudge-core";

// =============================================================================
// Poll v2 waiters and nudges for this worker (SYNC_V2 §3.11, §9.1
// "sync-nudge.ts", §13.17.2–3)
// =============================================================================
// The registry is in-process. Redis is used ONLY in routing `on` with a live
// sibling (remote_waiters_active): then a parked request is advertised in
// poll:waiter:{uid} so a fan-out on another worker can nudge it, and a new
// request on another worker can supersede it. At N=1 (local / shadow, or
// `on` without siblings) a nudge is a Map lookup in the router's fan-out:
// no Redis round trip, exactly as cheap as today's path.
//
// The global `sync:nudge` channel of §3.11 is replaced by per-worker inbox
// frames (`n` / `s`, §13.17.3): the fan-out already knows (from the presence
// pipeline) which worker holds each waiter, so no worker parses nudges for
// users it does not hold.
//
// Counters [POLL2]: waiters_registered, woken_by_nudge, nudge_local,
// nudge_remote_sent, nudge_remote_received, nudge_remote_failed,
// supersede_local, supersede_remote_sent, supersede_remote_received,
// waiter_swap_failed, drain_answered.

const registry = new WaiterRegistry(undefined, POLL_COALESCE_MS, POLL_COALESCE_JITTER_MS);
const wredis = create_waiter_redis(rfast, k);

/**
 * Can anybody be a poll v2 user right now (THE gate is open for some
 * bucket: mode 'on' + markers + rollout > 0)? While not, the fan-out reads
 * no poll:waiter keys and mins rises look up no members: R3 then costs
 * nothing anywhere, at any N.
 */
const poll_v2_possible = (): boolean => {
  const f = sync_v2_flags();
  return f.mode === "on" && f.markers.backfill && f.markers.indexes_post && f.rollout_pct > 0;
};

/** Do waiters need Redis right now (another worker may fan out to / poll for our users)? */
const remote_waiters_active = (): boolean => presence_authoritative() && !is_sole_worker() && poll_v2_possible();

type Registered = { waiter: PollWaiter; remote: boolean };

/**
 * Park a request (wait_s may be 0: it still supersedes the user's older
 * request, §3.11 step 1). In remote mode the advertisement is awaited (one
 * round trip, deadline-bound) BEFORE the caller computes, so a commit landing
 * between the computation's snapshot and the park is nudged, not missed.
 */
const register_waiter = async (uid: string, req_id: string, wait_ms: number): Promise<Registered> => {
  const { waiter, superseded } = registry.register(uid, req_id, wait_ms);
  count("POLL2", "waiters_registered");
  if (superseded) count("POLL2", "supersede_local");
  if (!remote_waiters_active()) return { waiter, remote: false };
  try {
    // wait + 5 s (§13.4): outlives the parked request, then expires by itself.
    const old = await deadline(wredis.swap(uid, WORKER_ID, req_id, wait_ms / 1000 + 5), PRESENCE_DEADLINE_MS, "poll waiter swap");
    if (old && old.wid !== WORKER_ID) {
      count("POLL2", "supersede_remote_sent");
      track(
        deadline(wredis.publish_supersede(old.wid, uid, old.req_id), PRESENCE_DEADLINE_MS, "poll supersede")
          .catch(() => count("POLL2", "supersede_remote_failed")),
      );
    }
    return { waiter, remote: true };
  } catch {
    // Not advertised: nudges from siblings miss it (it answers at its
    // deadline instead, ≤ wait). Never fails the request.
    count("POLL2", "waiter_swap_failed");
    return { waiter, remote: false };
  }
};

/** The request answered. Compare-delete the advertisement (a newer request may own it). */
const release_waiter = (r: Registered): void => {
  registry.release(r.waiter);
  if (!r.remote) return;
  track(
    deadline(wredis.release(r.waiter.uid, WORKER_ID, r.waiter.req_id), PRESENCE_DEADLINE_MS, "poll waiter release")
      .catch(() => count("POLL2", "waiter_release_failed")),
  );
};

/**
 * After a fan-out committed and stored a frame for `recipients`: wake their
 * parked requests. `remote` = holders on other workers, as the router's
 * presence pipeline found them (null at N=1). Never throws, never awaits.
 */
const nudge_after_fanout = (
  recipients: string[],
  chat_id: string,
  remote: Map<string, string[]> | null,
): void => {
  const n = registry.nudge(recipients, chat_id);
  if (n) count("POLL2", "nudge_local", n);
  if (!remote || remote.size === 0) return;
  publish_remote(remote, chat_id);
};

const publish_remote = (remote: Map<string, string[]>, chat_id: string): void => {
  let users = 0;
  for (const list of remote.values()) users += list.length;
  count("POLL2", "nudge_remote_sent", users);
  track(
    deadline(wredis.publish_nudges(remote, chat_id), PRESENCE_DEADLINE_MS, "poll nudge")
      .then((res) => {
        for (const n of res.values()) if (n <= 0) count("POLL2", "nudge_remote_unreceived");
      })
      .catch(() => count("POLL2", "nudge_remote_failed")),
  );
};

/**
 * Nudge users outside a fan-out (receipt mins rose while no chat:wm frame
 * is sent: §3.11 "also published on mins changes"). Local registry first;
 * with siblings, one GET pipeline on poll:waiter for the rest.
 */
const nudge_users = (uids: string[], chat_id: string): void => {
  if (uids.length === 0) return;
  const n = registry.nudge(uids, chat_id);
  if (n) count("POLL2", "nudge_local", n);
  if (!remote_waiters_active()) return;
  const rest = uids.filter((u) => !registry.has(u));
  if (rest.length === 0) return;
  track(
    deadline(wredis.lookup(rest), PRESENCE_DEADLINE_MS, "poll waiter lookup")
      .then((ws) => {
        const by = remote_waiters_by_wid(rest, ws, WORKER_ID);
        if (by.size) publish_remote(by, chat_id);
      })
      .catch(() => count("POLL2", "nudge_remote_failed")),
  );
};

/** Is it worth looking for waiters at all (skip member lookups when no poll v2 user can be parked)? */
const poll_waiters_possible = (): boolean => registry.size() > 0 || remote_waiters_active();

/** router.handle_inbox: the `n` / `s` frames. */
const handle_poll_inbox = (m: InboxMessage): boolean => {
  const r = apply_poll_inbox(registry, m);
  if (!r) return false;
  count("POLL2", r.kind === "nudge" ? "nudge_remote_received" : "supersede_remote_received");
  if (r.kind === "nudge" && r.hit === 0) count("POLL2", "nudge_remote_miss");
  return true;
};

/** Drain t0 (§13.9.3): answer every parked request with {drain:true}. */
const drain_poll_waiters = (): number => {
  const n = registry.drain_all();
  if (n) count("POLL2", "drain_answered", n);
  return n;
};

const poll_waiter_count = (): number => registry.size();
const poll_draining = (): boolean => registry.is_closed();

export {
  register_waiter,
  release_waiter,
  nudge_after_fanout,
  nudge_users,
  poll_waiters_possible,
  handle_poll_inbox,
  drain_poll_waiters,
  poll_waiter_count,
  poll_draining,
  remote_waiters_active,
  poll_v2_possible,
};
export type { Registered };
