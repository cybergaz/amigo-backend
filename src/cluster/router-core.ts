import type { Presence, WsPresence } from "./presence-core";

// =============================================================================
// Router — pure decision logic (SYNC_V2 §13.6)
// =============================================================================
// No sockets, no Redis: router.ts does the I/O and calls these. Kept apart so
// every classification rule (and the inbox wire format) is unit-tested in
// tests/rc2-router.test.ts.

// ---- FCM / delivery buckets (the return shape of broadcast_message) --------
// Insertion-ordered sets: a recipient lands in exactly one of online /
// polling / offline; `background` is a subset of online ∪ polling (users who
// also need an FCM push). Reclassification after a failed remote publish
// moves a user from online to offline and out of background.
type Buckets = {
  online: Set<string>;
  offline: Set<string>;
  polling: Set<string>;
  background: Set<string>;
};

type BucketArrays = {
  online: string[];
  offline: string[];
  polling: string[];
  background: string[];
};

const new_buckets = (): Buckets => ({
  online: new Set(),
  offline: new Set(),
  polling: new Set(),
  background: new Set(),
});

const bucket_arrays = (b: Buckets): BucketArrays => ({
  online: Array.from(b.online),
  offline: Array.from(b.offline),
  polling: Array.from(b.polling),
  background: Array.from(b.background),
});

const reclassify_offline = (b: Buckets, uid: string) => {
  b.online.delete(uid);
  b.background.delete(uid);
  b.offline.add(uid);
};

// ---- v1 poll lease (today's in-process rule, kept for local mode) ---------
// A poll in the last 10 s = polling (R0: non-destructive lease); older =
// stale → offline and the lease is evicted.
const POLL_LEASE_FRESH_MS = 10_000;

type LeaseVerdict = "polling" | "stale";
const poll_lease_verdict = (last_poll_at_ms: number | undefined, now: number): LeaseVerdict =>
  last_poll_at_ms !== undefined && now - last_poll_at_ms < POLL_LEASE_FRESH_MS ? "polling" : "stale";

// The time a lease was last "seen" for poll_lease_verdict. A poll v2
// long-poll (R3) parks for up to 25 s between two requests, far past the
// 10 s v1 freshness: while it is parked the lease carries `held_until` (the
// latest moment its response can go out), and counts as seen until then, so
// a foreground long-poller is not reclassified offline (FCM) — or evicted —
// mid-wait. v1 leases never set it: unchanged behaviour.
const lease_seen_ms = (lease: { last_poll_at?: Date; held_until?: number } | undefined): number | undefined => {
  if (!lease) return undefined;
  const polled = lease.last_poll_at?.getTime();
  const held = lease.held_until;
  if (held === undefined) return polled;
  if (polled === undefined) return held;
  return Math.max(polled, held);
};

// ---- presence classification (§13.6.3 step 2) ------------------------------
type PresencePlan = {
  // remote worker id → uids whose socket lives there
  remote: Map<string, string[]>;
  // ws keys naming THIS worker for users with no local socket and not mid-open
  stale_self: { uid: string; ws: WsPresence }[];
};

// `rest` = recipients the local fast path did not deliver to; `pres` is
// aligned with it. Mutates `b`.
const classify_presence = (
  b: Buckets,
  rest: string[],
  pres: Presence[],
  self_wid: string,
  is_opening: (cid: string) => boolean,
): PresencePlan => {
  const plan: PresencePlan = { remote: new Map(), stale_self: [] };
  rest.forEach((uid, i) => {
    const ws = pres[i]?.ws ?? null;
    const poll = pres[i]?.poll ?? null;
    if (ws && ws.wid !== self_wid) {
      const list = plan.remote.get(ws.wid);
      if (list) list.push(uid);
      else plan.remote.set(ws.wid, [uid]);
      b.online.add(uid);
      if (ws.bg) b.background.add(uid);
    } else if (poll) {
      b.polling.add(uid);
      // A backgrounded poller also gets FCM (keeps the R0 / F2-5 fix).
      if (poll.bg) b.background.add(uid);
    } else {
      b.offline.add(uid);
      if (ws && !is_opening(ws.cid)) plan.stale_self.push({ uid, ws });
    }
  });
  return plan;
};

// ---- liveness after PUBLISH (§13.6.3, V7) ----------------------------------
// Per remote worker: PUBLISH receiver count + whether worker:{wid} exists.
type Liveness = { receivers: number; alive: boolean };

type LivenessStats = {
  remote_deliveries: number;
  publish_zero_live: number;
  publish_zero_dead: number;
  wedged_reclass: number;
  liveness_unknown: number;
};

// Mutates `b`. Returns the dead workers whose users' keys may be released
// (prefix "wid|"), plus counters.
//   receivers=0, key missing  → dead: offline for this fan-out + release
//   receivers=0, key present  → keep online (V7: the count may lie behind a
//                               proxy; never delete on a 0 alone)
//   receivers>0, key missing  → wedged worker (beat stopped): offline, no release
//   no answer (deadline)      → unknown: offline (FCM + store cover it)
const apply_liveness = (
  b: Buckets,
  remote: Map<string, string[]>,
  res: Map<string, Liveness> | null,
): { dead: { wid: string; uids: string[] }[]; stats: LivenessStats } => {
  const stats: LivenessStats = {
    remote_deliveries: 0,
    publish_zero_live: 0,
    publish_zero_dead: 0,
    wedged_reclass: 0,
    liveness_unknown: 0,
  };
  const dead: { wid: string; uids: string[] }[] = [];
  for (const [wid, uids] of remote) {
    const r = res?.get(wid);
    if (!r) {
      stats.liveness_unknown += uids.length;
      for (const uid of uids) reclassify_offline(b, uid);
    } else if (r.receivers === 0 && !r.alive) {
      stats.publish_zero_dead += uids.length;
      for (const uid of uids) reclassify_offline(b, uid);
      dead.push({ wid, uids });
    } else if (r.receivers === 0) {
      stats.publish_zero_live += uids.length;
    } else if (!r.alive) {
      stats.wedged_reclass += uids.length;
      for (const uid of uids) reclassify_offline(b, uid);
    } else {
      stats.remote_deliveries += uids.length;
    }
  }
  return { dead, stats };
};

// ---- inbox wire format (§13.6.2) -------------------------------------------
// The frame stays the already-serialised string; the header is newline-
// delimited. JSON.stringify never emits a raw newline, and decoding splits
// only the header lines, so a frame is carried byte-for-byte.
type InboxMessage =
  | { kind: "deliver"; uids: string[]; frame: string }
  | { kind: "evict"; uid: string; old_cid: string; new_cid: string }
  | { kind: "nudge"; uids: string[]; chat_id: string }
  | { kind: "supersede"; uid: string; req_id: string };

const encode_deliver = (uids: string[], frame: string): string => `d\n${uids.join(",")}\n${frame}`;
const encode_evict = (uid: string, old_cid: string, new_cid: string): string =>
  `e\n${uid}\n${old_cid}\n${new_cid}`;
// Poll v2 (R3, §13.17.2–3). chat_id is informational ("-" when the frame
// names none): the woken waiter recomputes its whole state anyway.
const encode_nudge = (uids: string[], chat_id: string): string => `n\n${uids.join(",")}\n${chat_id || "-"}`;
const encode_supersede = (uid: string, req_id: string): string => `s\n${uid}\n${req_id}`;

const nth_newline = (s: string, n: number): number => {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = s.indexOf("\n", idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
};

const decode_inbox = (raw: string): InboxMessage | null => {
  if (typeof raw !== "string" || raw.length < 2 || raw[1] !== "\n") return null;
  switch (raw[0]) {
    case "d": {
      const end = nth_newline(raw, 2);
      if (end < 0) return null;
      const uids = raw.slice(2, end).split(",").filter(Boolean);
      return uids.length ? { kind: "deliver", uids, frame: raw.slice(end + 1) } : null;
    }
    case "e": {
      const [uid, old_cid, new_cid] = raw.slice(2).split("\n");
      return uid && old_cid && new_cid ? { kind: "evict", uid, old_cid, new_cid } : null;
    }
    case "n": {
      const [uids, chat_id] = raw.slice(2).split("\n");
      const list = (uids ?? "").split(",").filter(Boolean);
      return list.length && chat_id ? { kind: "nudge", uids: list, chat_id } : null;
    }
    case "s": {
      const [uid, req_id] = raw.slice(2).split("\n");
      return uid && req_id ? { kind: "supersede", uid, req_id } : null;
    }
    default:
      return null;
  }
};

// ---- replace / evict damper --------------------------------------------------
// Closing a replaced socket with 4009 (§13.6.5 step 4–5) assumes one client
// per user. Two live clients of one account (an old token without device
// claims skips the single-device lock) would knock each other off forever:
// each reconnect replaces the other, whose reconnect replaces it back. Count
// replacements per user in a sliding window; past the limit, stop closing
// (today's behaviour: the old socket stays open, unrouted) until the user has
// been quiet for a full window. Attempts are counted whether allowed or not,
// so a sustained ping-pong stays damped.
const REPLACE_WINDOW_MS = 60_000;
const REPLACE_MAX_IN_WINDOW = 4;
const DAMPER_MAX_USERS = 20_000;

class ReplaceDamper {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly window_ms = REPLACE_WINDOW_MS,
    private readonly max_in_window = REPLACE_MAX_IN_WINDOW,
  ) { }

  // true = go ahead and close the replaced socket.
  allow(uid: string, now: number = Date.now()): boolean {
    const since = now - this.window_ms;
    const list = (this.hits.get(uid) ?? []).filter((t) => t > since);
    list.push(now);
    this.hits.delete(uid); // re-insert: Map order = least recently touched first
    this.hits.set(uid, list);
    if (this.hits.size > DAMPER_MAX_USERS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return list.length <= this.max_in_window;
  }

  size(): number {
    return this.hits.size;
  }
}

// ---------------------------------------------------------------------------
// the two frames of one fan-out (SYNC_V2 §3.12)
// ---------------------------------------------------------------------------

/**
 * `live` (serialised) is what open sockets get, on this worker and through
 * the inbox; `store` is the only frame the pending store sees, so polling
 * replies (v1 and v2 pending) and FCM never carry the live-only extras
 * (message:pin's pinned_message body, 'on' only). Without a live variant,
 * `live` is JSON.stringify(message) exactly as before. A live variant of a
 * different event type is ignored: sockets and the queue must agree on what
 * happened.
 */
const fanout_frames = <M extends { type: string }>(
  message: M,
  live_message?: M | null,
): { live: string; store: M } => ({
  live: JSON.stringify(live_message && live_message.type === message.type ? live_message : message),
  store: message,
});

export {
  fanout_frames,
  new_buckets,
  bucket_arrays,
  reclassify_offline,
  poll_lease_verdict,
  lease_seen_ms,
  POLL_LEASE_FRESH_MS,
  classify_presence,
  apply_liveness,
  encode_deliver,
  encode_evict,
  encode_nudge,
  encode_supersede,
  decode_inbox,
  ReplaceDamper,
  REPLACE_WINDOW_MS,
  REPLACE_MAX_IN_WINDOW,
};
export type {
  Buckets,
  BucketArrays,
  PresencePlan,
  Liveness,
  LivenessStats,
  InboxMessage,
  LeaseVerdict,
};
