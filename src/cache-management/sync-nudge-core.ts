import type Redis from "ioredis";
import type { k as Keys } from "@/cluster/keys";
import {
  format_waiter_value,
  parse_waiter_value,
  type WaiterPresence,
} from "@/cluster/presence-core";
import { encode_nudge, encode_supersede, type InboxMessage } from "@/cluster/router-core";

// =============================================================================
// Poll v2 waiters + nudges — pure core (SYNC_V2 §3.11 steps 1/6, §13.17.2–3)
// =============================================================================
// No config import: tests drive the registry with a fake clock and run the
// Redis half against an ephemeral redis-server with two in-process
// "workers". sync-nudge.ts binds it to the app (rfast, WORKER_ID, the bus).
//
// A parked POST /chat/sync/poll is a PollWaiter, one per user per worker
// (single device: a second request from the same user means the first one
// is dead or abandoned). It wakes for exactly one of:
//   nudge       a fan-out committed something for the user; coalesced: the
//               first nudge starts a 300 ms timer, later ones ride it, so a
//               burst of N frames costs one recomputation, not N;
//   timeout     the request's wait elapsed (a lost nudge costs ≤ wait);
//   superseded  a newer request of the same user arrived (here, or on
//               another worker via the inbox `s` frame);
//   drain       this worker is shutting down (§13.9.3 t0): answer now so
//               the client re-polls a sibling instead of timing out;
//   aborted     the client's connection closed (request.signal): nobody
//               reads the answer, so stop holding the lease / waiter now.
// timeout / superseded / drain / aborted are final; a nudge that finds
// nothing new re-arms (the caller asks next() again).
//
// Cross-worker (routing `on` with a live sibling): the user's parked request
// is advertised in poll:waiter:{uid} = "wid|req_id" (EX wait+5). A new
// request SWAPS it (Lua, one key) and gets the previous holder back: a
// different worker is told to supersede that req_id through its inbox.
// Fan-outs read the key in the router's presence pipeline and publish
// `n\n{uids}\n{chat}` once per holding worker (§13.6.2). At N=1 none of this
// touches Redis: the registry is in-process and the router wakes it directly.

type WakeReason = "nudge" | "timeout" | "superseded" | "drain" | "aborted";

type Clock = {
  now: () => number;
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
};

const real_clock: Clock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const NUDGE_CHATS_MAX = 64;

class PollWaiter {
  readonly deadline_at: number;
  // Chats named by the nudges so far (diagnostics; the recomputation covers
  // every chat anyway). Bounded.
  readonly chats = new Set<string>();
  nudges = 0;
  private final: WakeReason | null = null;
  private resolver: ((r: WakeReason) => void) | null = null;
  // A coalesced nudge fired while nobody waited (the caller was computing):
  // the next next() returns it at once — a nudge is never lost to a race
  // with a computation in flight.
  private due = false;
  private coalesce_h: unknown = null;
  private deadline_h: unknown = null;

  constructor(
    readonly uid: string,
    readonly req_id: string,
    wait_ms: number,
    private readonly clock: Clock,
    private readonly coalesce_ms: number,
    // Extra 0..n ms per coalesce window: a group fan-out nudges every
    // member's waiter in the same tick, and identical windows would fire
    // every recomputation at once into an admission limit of ~8.
    private readonly jitter: () => number = () => 0,
  ) {
    this.deadline_at = clock.now() + wait_ms;
    this.deadline_h = clock.set(() => {
      this.deadline_h = null;
      this.finish("timeout");
    }, Math.max(0, wait_ms));
  }

  get reason(): WakeReason | null {
    return this.final;
  }

  next(): Promise<WakeReason> {
    if (this.final) return Promise.resolve(this.final);
    if (this.due) {
      this.due = false;
      return Promise.resolve("nudge");
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  nudge(chat_id?: string): boolean {
    if (this.final) return false;
    this.nudges++;
    if (chat_id && chat_id !== "-" && this.chats.size < NUDGE_CHATS_MAX) this.chats.add(chat_id);
    if (this.coalesce_h !== null || this.due) return true;
    this.arm(this.coalesce_ms + this.jitter());
    return true;
  }

  /**
   * Wake again (as a nudge) in `ms`: a woken recomputation was refused by
   * admission control. Without it the nudge's news would wait for the
   * deadline (up to `wait` late), since nothing nudges the waiter again. A
   * nudge already pending covers it. false when final.
   */
  retry_in(ms: number): boolean {
    if (this.final) return false;
    if (this.coalesce_h === null && !this.due) this.arm(ms);
    return true;
  }

  private arm(ms: number): void {
    this.coalesce_h = this.clock.set(() => {
      this.coalesce_h = null;
      if (this.final) return;
      const r = this.resolver;
      if (r) {
        this.resolver = null;
        r("nudge");
      } else {
        this.due = true;
      }
    }, ms);
  }

  /** timeout / superseded / drain / aborted. false when already final. */
  finish(reason: Exclude<WakeReason, "nudge">): boolean {
    if (this.final) return false;
    this.final = reason;
    this.dispose();
    const r = this.resolver;
    if (r) {
      this.resolver = null;
      r(reason);
    }
    return true;
  }

  dispose(): void {
    if (this.coalesce_h !== null) this.clock.clear(this.coalesce_h);
    if (this.deadline_h !== null) this.clock.clear(this.deadline_h);
    this.coalesce_h = null;
    this.deadline_h = null;
  }
}

class WaiterRegistry {
  private by_uid = new Map<string, PollWaiter>();
  private closed = false;

  private readonly jitter: () => number;

  constructor(
    private readonly clock: Clock = real_clock,
    private readonly coalesce_ms: number = 300,
    coalesce_jitter_ms = 0,
    rand: () => number = Math.random,
  ) {
    this.jitter = coalesce_jitter_ms > 0 ? () => Math.floor(rand() * (coalesce_jitter_ms + 1)) : () => 0;
  }

  /**
   * Park a request. An older waiter of the same user is superseded at once
   * (§3.11 step 1); while draining, the new waiter is born finished.
   */
  register(uid: string, req_id: string, wait_ms: number): { waiter: PollWaiter; superseded: PollWaiter | null } {
    const old = this.by_uid.get(uid) ?? null;
    if (old) old.finish("superseded");
    const waiter = new PollWaiter(uid, req_id, wait_ms, this.clock, this.coalesce_ms, this.jitter);
    this.by_uid.set(uid, waiter);
    if (this.closed) waiter.finish("drain");
    return { waiter, superseded: old && old.reason === "superseded" ? old : null };
  }

  /** The request answered: forget it (only if it is still the user's current one). */
  release(w: PollWaiter): void {
    if (this.by_uid.get(w.uid) === w) this.by_uid.delete(w.uid);
    w.dispose();
  }

  /** Wake the waiters of `uids` on this worker. Returns how many were nudged. */
  nudge(uids: Iterable<string>, chat_id?: string): number {
    if (this.by_uid.size === 0) return 0;
    let n = 0;
    for (const uid of uids) {
      const w = this.by_uid.get(uid);
      if (w && w.nudge(chat_id)) n++;
    }
    return n;
  }

  /** Inbox `s`: supersede only the request that was named (a newer one stays). */
  supersede(uid: string, req_id: string): boolean {
    const w = this.by_uid.get(uid);
    return !!w && w.req_id === req_id && w.finish("superseded");
  }

  /** Drain (§13.9.3 t0): answer every parked request now, and every later one at once. */
  drain_all(): number {
    this.closed = true;
    let n = 0;
    for (const w of this.by_uid.values()) if (w.finish("drain")) n++;
    return n;
  }

  get(uid: string): PollWaiter | undefined {
    return this.by_uid.get(uid);
  }

  has(uid: string): boolean {
    return this.by_uid.has(uid);
  }

  size(): number {
    return this.by_uid.size;
  }

  is_closed(): boolean {
    return this.closed;
  }
}

/** Apply an inbox frame that belongs to poll v2. false = not ours. */
const apply_poll_inbox = (reg: WaiterRegistry, m: InboxMessage): { kind: "nudge" | "supersede"; hit: number } | null => {
  if (m.kind === "nudge") return { kind: "nudge", hit: reg.nudge(m.uids, m.chat_id) };
  if (m.kind === "supersede") return { kind: "supersede", hit: reg.supersede(m.uid, m.req_id) ? 1 : 0 };
  return null;
};

// ---- Redis half (single-key scripts, shard-safe) -------------------------------

// KEYS[1]=poll:waiter:{uid} ARGV[1]="wid|req_id" ARGV[2]=ttl s → previous value or false
const LUA_POLL_WAITER_SWAP = `
local old = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return old or false
`;

// KEYS[1] ARGV[1]="wid|req_id" → 1 deleted / 0 someone newer holds it
const LUA_POLL_WAITER_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const SCRIPTS = {
  amigo_poll_waiter_swap: { numberOfKeys: 1, lua: LUA_POLL_WAITER_SWAP },
  amigo_poll_waiter_release: { numberOfKeys: 1, lua: LUA_POLL_WAITER_RELEASE },
} as const;

type ScriptClient = Record<string, (...args: (string | number)[]) => Promise<unknown>>;
type WaiterKeys = Pick<typeof Keys, "poll_waiter" | "inbox">;

/** The Redis side of the waiter registry, bound to one connection. Each call = one round trip. */
const create_waiter_redis = (client: Redis, keys: WaiterKeys) => {
  for (const [name, def] of Object.entries(SCRIPTS)) {
    if (typeof (client as unknown as ScriptClient)[name] !== "function") client.defineCommand(name, def);
  }
  const sc = client as unknown as ScriptClient;

  const swap = async (uid: string, wid: string, req_id: string, ttl_s: number): Promise<WaiterPresence | null> =>
    parse_waiter_value(await sc.amigo_poll_waiter_swap(keys.poll_waiter(uid), format_waiter_value(wid, req_id), Math.max(1, Math.ceil(ttl_s))));

  const release = async (uid: string, wid: string, req_id: string): Promise<boolean> =>
    (await sc.amigo_poll_waiter_release(keys.poll_waiter(uid), format_waiter_value(wid, req_id))) === 1;

  // GET poll:waiter per user, one pipeline (nudge paths that do not go
  // through the router's presence lookup). Aligned with `uids`; a failed
  // GET reads as "no waiter" (costs a nudge, never more).
  const lookup = async (uids: string[]): Promise<(WaiterPresence | null)[]> => {
    if (uids.length === 0) return [];
    const p = client.pipeline();
    for (const u of uids) p.get(keys.poll_waiter(u));
    const res = (await p.exec()) ?? [];
    return uids.map((_, i) => {
      const [err, raw] = res[i] ?? [new Error("missing"), null];
      return err ? null : parse_waiter_value(raw);
    });
  };

  // One PUBLISH per holding worker, one pipeline. Returns the receiver count
  // per wid (0 = nobody subscribed: the worker died; its waiter is gone too).
  const publish_nudges = async (by_wid: Map<string, string[]>, chat_id: string): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    if (by_wid.size === 0) return out;
    const wids = Array.from(by_wid.keys());
    const p = client.pipeline();
    for (const wid of wids) p.publish(keys.inbox(wid), encode_nudge(by_wid.get(wid)!, chat_id));
    const res = (await p.exec()) ?? [];
    wids.forEach((wid, i) => {
      const [err, n] = res[i] ?? [new Error("missing"), 0];
      out.set(wid, err ? -1 : Number(n) || 0);
    });
    return out;
  };

  const publish_supersede = (wid: string, uid: string, req_id: string): Promise<number> =>
    client.publish(keys.inbox(wid), encode_supersede(uid, req_id));

  return { swap, release, lookup, publish_nudges, publish_supersede };
};

type WaiterRedis = ReturnType<typeof create_waiter_redis>;

/** Group waiters by holding worker, skipping `self_wid` (those are woken in-process). */
const remote_waiters_by_wid = (
  uids: string[],
  waiters: (WaiterPresence | null | undefined)[],
  self_wid: string,
): Map<string, string[]> => {
  const by = new Map<string, string[]>();
  uids.forEach((uid, i) => {
    const w = waiters[i];
    if (!w || w.wid === self_wid) return;
    const list = by.get(w.wid);
    if (list) list.push(uid);
    else by.set(w.wid, [uid]);
  });
  return by;
};

export {
  PollWaiter,
  WaiterRegistry,
  real_clock,
  apply_poll_inbox,
  create_waiter_redis,
  remote_waiters_by_wid,
  LUA_POLL_WAITER_SWAP,
  LUA_POLL_WAITER_RELEASE,
};
export type { WakeReason, Clock, WaiterRedis, WaiterKeys };
