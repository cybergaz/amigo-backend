// =============================================================================
// Poll v2: POST /chat/sync/poll (SYNC_V2_PROTOCOL.md §3.11, §13.17, §14.9)
// =============================================================================
// One request = one long-poll of the user's whole sync state:
//
//   1. lease: the v1 polling lease (FCM bucketing; held fresh for the whole
//      wait), presence:{uid}:poll EX wait+15, the proto:{uid} capability
//      lease (§3.13, flag-gated) and the waiter (supersedes the user's older
//      request, here or — routing `on` with siblings — on another worker);
//   2. acks {key, v}: drain_pending, compare-and-delete "stored v ≤ v", in
//      parallel with the computation (acked versions are filtered out of it);
//   3. compute = ONE statement (poll-queries.ts: etag, heads rows, inline
//      deltas, the pending DB tier) ∥ ONE Redis pipeline (pending entries +
//      return marks), planned by poll-core;
//   4. answer now if the client's heads are stale, a watched chat moved past
//      its `since`, a pending entry is returnable, or wait = 0;
//   5. otherwise park until a nudge (coalesced 300 ms) → recompute against
//      the request-start view (partial heads); answer if anything is new,
//      else park again — or until the deadline → one last computation,
//      answered whatever it holds (a lost nudge costs ≤ wait) — or until a
//      newer request / the drain / the client's disconnect → an empty answer
//      at once. A woken recomputation refused by admission retries after a
//      short jittered backoff (never waits for the deadline).
//
// Only computations hold a DB connection or an admission slot; waiting holds
// neither (§13.11 "long-polls hold no PG connection while waiting").
// =============================================================================
import { pg_client } from "@/config/db";
import { sync_v2_flags } from "@/services/app-settings.service";
import { count, observe_ms } from "@/utils/counters";
import { is_draining, track } from "@/cluster/lifecycle";
import { deadline } from "@/cluster/redis-fast";
import { drain_pending, read_pending_redis, write_return_meta } from "@/cache-management/polling.cache";
import {
  poll_draining,
  register_waiter,
  release_waiter,
  type Registered,
} from "@/cache-management/sync-nudge";
import { drop_poll_hold, end_poll_hold, touch_poll_lease } from "@/sockets/poll-lease";
import { pending_suppression_active } from "./flags-core";
import { set_proto_lease_soon } from "./proto-lease";
import { is_busy, with_sync_admission } from "./admission";
import { SYNC_PROTO } from "./read-core";
import {
  POLL_COMPUTE_BUDGET_MS,
  POLL_TAIL_AWAIT_MS,
  acked_versions,
  finalize_poll_deltas,
  has_news,
  plan_pending_v2,
  wake_retry_ms,
  type HeadsView,
  type PendingPlan,
  type PollDelta,
  type PollRequest,
} from "./poll-core";
import { poll_state_sql, type PollStateRaw } from "./poll-queries";

export type PollServed =
  | { status: 200; body: Record<string, unknown>; close?: boolean }
  | { status: 429; retry_after_s: number }
  | { status: 503; reason: string };

type Woken = "immediate" | "nudge" | "timeout" | "superseded" | "drain" | "aborted";
type Stopped = "superseded" | "drain" | "aborted";

// ── proto:{uid} lease, refreshed at most every few minutes per user ─────────
// The lease lives a day; re-SETting it on every poll (every ≤ 25 s per
// polling user) would be one Redis write per request for nothing.
const PROTO_REFRESH_MS = 5 * 60_000;
const PROTO_REFRESH_MAX = 50_000;
const proto_refreshed = new Map<string, number>();

const refresh_proto_lease = (user_id: string, now: number): void => {
  if (!sync_v2_flags().proto_lease) return;
  const at = proto_refreshed.get(user_id);
  if (at !== undefined && now - at < PROTO_REFRESH_MS) return;
  proto_refreshed.delete(user_id);
  proto_refreshed.set(user_id, now);
  if (proto_refreshed.size > PROTO_REFRESH_MAX) {
    const oldest = proto_refreshed.keys().next().value;
    if (oldest !== undefined) proto_refreshed.delete(oldest);
  }
  set_proto_lease_soon(user_id);
};

/**
 * A poll v1 request cleared the lease (downgrade, §3.13): forget the
 * throttle so the user's next v2 poll sets it again at once.
 */
export const forget_proto_refresh = (user_id: string): void => {
  proto_refreshed.delete(user_id);
};

// ── one computation ─────────────────────────────────────────────────────────

type Computed = { st: PollStateRaw; plan: PendingPlan; deltas: PollDelta[] };

class Slow extends Error { }

const with_budget = <T>(p: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Slow("poll compute budget")), POLL_COMPUTE_BUDGET_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

const compute = async (
  user_id: string,
  req: PollRequest,
  phase: "start" | "wake",
  view: HeadsView | null,
  acked: Map<string, string>,
  suppress: boolean,
): Promise<Computed | "busy"> => {
  const r = await with_sync_admission(async () => {
    const t0 = performance.now();
    // The admission slot is held until the work really ends, even when the
    // budget below gave up waiting for it: the pool is what admission guards.
    const [st, rd] = await Promise.all([
      poll_state_sql(pg_client, user_id, {
        client_etag: phase === "start" ? req.heads_etag : null,
        known: phase === "wake" ? view : null,
        // The view is what a parked request diffs against; only a request
        // that may park needs it.
        want_view: phase === "start" && req.wait_s > 0,
        // Partial heads always carry the stub of a changed row (it changed
        // during this wait); full heads honour the client's stubs_after.
        stubs_after: phase === "start" ? req.stubs_after : 0,
        watch: req.watch,
      }),
      read_pending_redis(user_id),
    ]);
    const plan = plan_pending_v2({
      db_rows: st.pending_db,
      redis_entries: rd.entries,
      meta: rd.meta,
      meta_ok: rd.meta_ok,
      entries_ok: rd.entries_ok,
      acked,
      now: Date.now(),
      ignore_hold: req.wait_s === 0,
      suppress_derivable: suppress,
    });
    observe_ms("POLL2", "compute_ms", performance.now() - t0);
    return { st, plan, deltas: finalize_poll_deltas(st.deltas) };
  });
  if (is_busy(r)) return "busy";
  return r;
};

// ── responses ───────────────────────────────────────────────────────────────

const busy = (): PollServed => {
  count("POLL2", "429");
  return { status: 429, retry_after_s: 2 + Math.floor(Math.random() * 4) };
};

// Nobody reads an "aborted" answer (the client is gone); it is shaped like
// "superseded" only so the route has something to return.
const empty = (req: PollRequest, woken: Stopped): PollServed => ({
  status: 200,
  close: woken === "drain",
  body: {
    success: true,
    code: 200,
    data: {
      proto: SYNC_PROTO,
      sync_proto: SYNC_PROTO,
      server_time: new Date().toISOString(),
      // 0: carries no state; a client discards it (≤ anything it applied).
      resp_ver: 0,
      req_id: req.req_id,
      woken,
      ...(woken === "drain" ? { drain: true } : { superseded: true }),
      heads: null,
      deltas: [],
      pending: [],
      pending_more: false,
    },
  },
});

const answer = async (
  user_id: string,
  req: PollRequest,
  c: Computed,
  woken: Woken,
  heads_changed: boolean,
  full: boolean,
): Promise<PollServed> => {
  const { st, plan, deltas } = c;
  // The marks are awaited: the client's next request (sent the moment this
  // one lands) must already see what was handed out, or it would get the
  // same entries again before acking them. Bounded: a stalled Redis costs a
  // duplicate at worst, never an answer past the proxy timeouts.
  await deadline(write_return_meta(user_id, plan.meta_updates, plan.stale_meta), POLL_TAIL_AWAIT_MS, "poll return marks")
    .catch(() => count("POLL2", "return_meta_slow"));
  if (plan.drop.length > 0) track(drain_pending(user_id, plan.drop));
  if (plan.redelivered) count("POLL2", "redelivered_same_key", plan.redelivered);
  if (plan.held) count("POLL2", "held", plan.held);
  if (plan.expired) {
    count("POLL2", "expired_unacked", plan.expired);
    console.warn(`[POLL2] expired_unacked user=${user_id} n=${plan.expired}`);
  }
  if (plan.suppressed) count("POLL2", "suppressed_derivable", plan.suppressed);
  if (plan.ack_newer) count("POLL2", "compare_delete_miss", plan.ack_newer);
  if (plan.pending.length) count("POLL2", "pending_sent", plan.pending.length);
  if (plan.pending_more) count("POLL2", "pending_more");
  if (deltas.length) count("POLL2", "deltas", deltas.length);
  if (heads_changed) count("POLL2", full ? "heads_full" : "heads_partial");
  count("POLL2", `answered_${woken}`);
  if (req.last_resp_ver !== null && req.last_resp_ver > st.resp_ver) count("POLL2", "client_resp_ver_ahead");
  return {
    status: 200,
    body: {
      success: true,
      code: 200,
      data: {
        proto: SYNC_PROTO,
        sync_proto: SYNC_PROTO,
        server_time: st.server_time,
        resp_ver: st.resp_ver,
        req_id: req.req_id,
        woken,
        heads: heads_changed ? { etag: st.etag, full, chats: st.chats, gone: full ? [] : st.gone } : null,
        deltas,
        pending: plan.pending,
        pending_more: plan.pending_more,
      },
    },
  };
};

// ── the request ─────────────────────────────────────────────────────────────

export const handle_poll = async (
  user_id: string,
  client_ip: string,
  req: PollRequest,
  // The HTTP request's signal: aborted when the client's connection closes.
  signal?: AbortSignal,
): Promise<PollServed> => {
  const t0 = Date.now();
  count("POLL2", "requests");
  if (req.wait_s === 0) count("POLL2", "requests_wait0");
  // LP2 drain rule (§14.9): a worker that is leaving answers at once. The
  // acks still drain (tracked: the drain waits for them): the answer is a
  // 200, so a client may well consider them delivered.
  if (is_draining() || poll_draining()) {
    if (req.ack.length > 0) {
      const acked = acked_versions(req.ack);
      count("POLL2", "acks", acked.size);
      track(drain_pending(user_id, Array.from(acked, ([key, v]) => ({ key, v }))));
    }
    count("POLL2", "answered_drain");
    return empty(req, "drain");
  }

  const wait_ms = req.wait_s * 1000;
  const held_until = t0 + wait_ms + POLL_COMPUTE_BUDGET_MS;
  touch_poll_lease(user_id, client_ip, req.raw_bg, { held_until, presence_ttl_s: req.wait_s + 15 });
  refresh_proto_lease(user_id, t0);
  const suppress = pending_suppression_active(sync_v2_flags());

  // Registered BEFORE the first computation: a commit that lands after the
  // statement's snapshot nudges this waiter instead of being missed.
  const reg: Registered = await register_waiter(user_id, req.req_id, wait_ms);
  const acked = acked_versions(req.ack);
  // Tracked: when the answer stops waiting for it (POLL_TAIL_AWAIT_MS) the
  // drain still waits for it at shutdown.
  const ack_p = acked.size > 0
    ? track(drain_pending(user_id, Array.from(acked, ([key, v]) => ({ key, v }))))
    : Promise.resolve();
  if (acked.size) count("POLL2", "acks", acked.size);

  // Client gone: stop at once (no marks are written for an answer nobody
  // reads) and age the lease out, so FCM covers the user again.
  const on_abort = (): void => {
    reg.waiter.finish("aborted");
  };
  if (signal) {
    if (signal.aborted) on_abort();
    else signal.addEventListener("abort", on_abort, { once: true });
  }

  const finish = async (r: PollServed): Promise<PollServed> => {
    signal?.removeEventListener("abort", on_abort);
    // drain_pending never throws; the deadline does (caught).
    await deadline(ack_p, POLL_TAIL_AWAIT_MS, "poll ack drain").catch(() => count("POLL2", "ack_drain_slow"));
    release_waiter(reg);
    if (reg.waiter.reason === "aborted") drop_poll_hold(user_id, held_until);
    else end_poll_hold(user_id, held_until);
    observe_ms("POLL2", "request_ms", Date.now() - t0);
    return r;
  };
  const stopped = (): Stopped | null => {
    const why = reg.waiter.reason;
    return why === "superseded" || why === "drain" || why === "aborted" ? why : null;
  };

  try {
    const start = await with_budget(compute(user_id, req, "start", null, acked, suppress));
    if (start === "busy") return await finish(busy());
    // A newer request (or the drain) took over while we computed: hand out
    // nothing (no marks written), the newer request does.
    const s0 = stopped();
    if (s0) {
      count("POLL2", `answered_${s0}`);
      return await finish(empty(req, s0));
    }
    const start_changed = start.st.etag !== req.heads_etag;
    if (wait_ms === 0 || has_news({
      heads_rows: start_changed ? 1 : 0, gone: 0, deltas: start.deltas.length, returnable: start.plan.returnable,
    })) {
      return await finish(await answer(user_id, req, start, "immediate", start_changed, true));
    }

    // Parked. The client's heads == the start view (its etag matched).
    const view = start.st.view ?? new Map();
    const view_etag = start.st.etag;
    count("POLL2", "parked");
    let busy_wakes = 0;
    for (;;) {
      const why = await reg.waiter.next();
      if (why === "superseded" || why === "drain" || why === "aborted") {
        count("POLL2", `answered_${why}`);
        return await finish(empty(req, why));
      }
      if (why === "nudge") count("POLL2", "woken_by_nudge");
      const c = await with_budget(compute(user_id, req, "wake", view, acked, suppress));
      if (c === "busy") {
        // Busy on the final computation: the client honours Retry-After.
        if (why === "timeout") return await finish(busy());
        // Busy on a wake: nothing would nudge this waiter again, so its news
        // would wait for the deadline. Retry shortly (jittered, growing): a
        // group fan-out's herd then drains through the admission slots.
        count("POLL2", "wake_busy");
        reg.waiter.retry_in(wake_retry_ms(busy_wakes++));
        continue;
      }
      const s1 = stopped();
      if (s1) {
        count("POLL2", `answered_${s1}`);
        return await finish(empty(req, s1));
      }
      const changed = c.st.etag !== view_etag;
      const news = has_news({ heads_rows: changed ? 1 : 0, gone: 0, deltas: c.deltas.length, returnable: c.plan.returnable });
      if (news || why === "timeout" || reg.waiter.reason === "timeout") {
        const woken: Woken = news && why === "nudge" ? "nudge" : "timeout";
        if (why === "nudge" && !news) count("POLL2", "timeout_after_wake");
        return await finish(await answer(user_id, req, c, woken, changed, false));
      }
      count("POLL2", "wake_no_news");
    }
  } catch (err: any) {
    if (err instanceof Slow) {
      count("POLL2", "slow");
      return await finish({ status: 503, reason: "slow" });
    }
    count("POLL2", "failed");
    console.error(`[POLL2] poll failed user=${user_id}: ${err?.code ?? ""} ${err?.message ?? err}`);
    return await finish({ status: 503, reason: "server_error" });
  }
};
