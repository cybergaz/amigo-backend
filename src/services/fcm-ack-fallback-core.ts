// =============================================================================
// FCM fallback for unacked foreground WS deliveries — pure core
// (SYNC_V2_PROGRESS.md F item "R1b: FCM fallback for message:new to WS
// recipients that haven't acked delivered within ~10 s"; spec §3.14, §14.13)
// =============================================================================
// Why: a recipient whose socket looks FOREGROUND gets message:new over the WS
// only (the fan-out pushes FCM to offline + background users). When the OS
// froze or killed that socket without a close (Android cuts the network of a
// backgrounded app at ~5 s; a missed connection:status leaves the server
// thinking "foreground"), the frame goes into a dead socket and nothing wakes
// the phone until the user opens the app. Both app builds ack every stored
// non-system message:new with a `delivered` status:ack, but through a
// TRAILING 800 ms debounce with no max wait (StatusAckService.ackMessage):
// in a busy group a live, reading client can send no ack for the whole
// burst. So "no ack after ~10 s" only makes a socket SUSPECT; a suspect
// foreground socket that has not talked to us since the send is probed with
// a server socket:ping (both builds answer with socket:pong) and pushed only
// if it stays silent for PROBE_MS — a 4.2.2 app notifies every message:new
// push it gets, even for the chat on screen.
//
// Shape (cheap at N=1, cluster-safe):
//   - ONE FIFO wheel per worker. The delay is the same for every entry, so
//     deadlines are already in arming order: one batch per fan-out (the
//     message + a Set of recipients), not one timer per recipient. A 1 s tick
//     takes the due batches from the head.
//   - The wheel lives where the socket lives: the fan-out worker arms its
//     local sockets, a remote worker arms the sockets it delivered an inbox
//     frame to (router.ts). An ack on that socket cancels in memory (O(1)).
//   - Before pushing, the pending store (the cluster-wide record of "not acked
//     yet": every ack path drains `{uid}:message:new:{id}`) is checked, so an
//     ack that reached ANOTHER worker (REST /message/delivered, a reconnect
//     elsewhere replaying its offline acks) also suppresses the push. A
//     proto-2 lease holder has no such entry (§3.13 suppression), so for
//     them the check is chat_members.delivered_seq ≥ the message's seq
//     (create_v2_aware_checker).
//   - Skipped: the sender, system rows (apps never ack them), recipients
//     that are still on a foreground socket here that has talked to us since
//     the message was sent (the app is alive in the foreground and syncs the
//     message itself; a push would only double-notify), users without a
//     token, and messages deleted / expired meanwhile (a late push would
//     resurrect a "delete for everyone" on the phone).
//   - Drain: the wheel keeps arming and firing while the sockets are handed
//     over (~45 s), then fire_all() runs one final pass over everything still
//     armed: a healthy client reconnected to a sibling and acked there (the
//     pending check filters it), a frozen phone never reconnects and needs
//     the push.
// The I/O binding is services/fcm-ack-fallback.ts.
// =============================================================================
import type Redis from "ioredis";
import type postgres from "postgres";
import type { WSMessage } from "@/types/socket.types";
import { parse_value, redis_entries_key } from "@/cache-management/pending-store-core";

export const ACK_FALLBACK_DEFAULT_MS = 10_000;
// Bounds: below ~3 s a normal 800 ms ack debounce + a slow link would push
// for messages that did land; above 2 min the push is pointless.
export const ACK_FALLBACK_MIN_MS = 3_000;
export const ACK_FALLBACK_MAX_MS = 120_000;
// Memory bound: (message, recipient) pairs waiting for their deadline.
export const ACK_FALLBACK_MAX_ENTRIES = 200_000;
// Pushes considered per tick; the rest wait for the next tick (still due).
// Caps the burst when a whole worker's sockets die at once.
export const ACK_FALLBACK_MAX_FIRE_PER_TICK = 2_000;
export const ACK_FALLBACK_TICK_MS = 1_000;
// How long a probed (server socket:ping) suspect socket has to answer before
// it is pushed. A pong is one RTT; generous for cheap Wi-Fi.
export const ACK_FALLBACK_PROBE_MS = 3_000;

// JSON.stringify of the `{type, payload, ws_timestamp}` literals every
// message:new fan-out builds starts with this; lets the inbox path skip
// JSON.parse for every other frame.
export const MESSAGE_NEW_FRAME_PREFIX = '{"type":"message:new"';

export const clamp_delay_ms = (raw: unknown): number => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return ACK_FALLBACK_DEFAULT_MS;
  return Math.min(ACK_FALLBACK_MAX_MS, Math.max(ACK_FALLBACK_MIN_MS, Math.round(n)));
};

/** This worker's view of the recipient's socket; null = no open socket here. */
export type LocalConn = { background: boolean; last_inbound_at?: number } | null;

export type FallbackItem = { uid: string; msg_id: string; conv_id?: string; seq?: number | null };

export type AckFallbackDeps = {
  /** Flag check (sync); off → nothing is armed and due entries are dropped. */
  enabled: () => boolean;
  delay_ms: number;
  local_conn: (uid: string) => LocalConn;
  /** Per item: is the pending entry still there (= not acked anywhere)?
   * null = the lookup failed (the push then goes out; the client dedups). */
  still_pending: (items: FallbackItem[]) => Promise<boolean[] | null>;
  /** Users among `uids` that have an FCM token. */
  with_token: (uids: string[]) => Promise<Set<string>>;
  /** Ids (lower-cased) still live (not deleted, not expired); null = failed. */
  live_ids: (ids: string[]) => Promise<Set<string> | null>;
  muted: (conv_id: string) => Promise<Set<string>>;
  send: (uid: string, msg: WSMessage, opts: { silent: boolean }) => void;
  /** Send a server socket:ping on uid's open socket here; false = none. */
  probe?: (uid: string) => boolean;
  probe_ms?: number;
  count: (name: string, n?: number) => void;
  now?: () => number;
  max_entries?: number;
  max_fire_per_tick?: number;
};

type Batch = {
  key: string; // lower-cased message id
  msg_id: string; // as stored (the pending field uses this spelling)
  conv_id: string;
  seq: number | null; // the row's seq (sync_v2 'on' frames); null otherwise
  msg: WSMessage;
  uids: Set<string>;
  armed_at: number;
  due_at: number;
};

type Eligible = { msg_id: string; conv_id: string; sender_id: string | null; seq: number | null };

/**
 * Is this frame a message:new the recipient's app will ack? null = no
 * (with the reason, for the counter). System rows / the disappearing notice
 * are never acked by either app build; an oversize stub is FCM-only.
 */
export const fallback_eligible = (msg: WSMessage | null | undefined): Eligible | { skip: string } => {
  if (!msg || msg.type !== "message:new") return { skip: "type" };
  const p = (msg.payload ?? {}) as Record<string, any>;
  if (typeof p.id !== "string" || !p.id || typeof p.conv_id !== "string" || !p.conv_id) return { skip: "shape" };
  if (p.msg_type === "system" || p.system_actor === true || p.partial === true) return { skip: "system" };
  return {
    msg_id: p.id,
    conv_id: p.conv_id,
    sender_id: typeof p.sender_id === "string" ? p.sender_id : null,
    seq: typeof p.seq === "number" && Number.isFinite(p.seq) ? p.seq : null,
  };
};

/** `{uid}:message:new:{id}` → id (the pending store's correlation key). */
export const acked_message_id = (uid: string, key: string): string | null => {
  const prefix = `${uid}:message:new:`;
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null;
};

export const create_ack_fallback = (deps: AckFallbackDeps) => {
  const now = deps.now ?? Date.now;
  const max_entries = deps.max_entries ?? ACK_FALLBACK_MAX_ENTRIES;
  const max_fire = deps.max_fire_per_tick ?? ACK_FALLBACK_MAX_FIRE_PER_TICK;
  const probe_ms = deps.probe_ms ?? ACK_FALLBACK_PROBE_MS;
  const count = (name: string, n = 1) => {
    if (n > 0) deps.count(`ack_fallback_${name}`, n);
  };

  // FIFO: queue[head..] in arming order = deadline order.
  let queue: Batch[] = [];
  let head = 0;
  const by_msg = new Map<string, Batch>();
  let entries = 0;
  let stopped = false;
  // fire_all() ran: no more probes (the sockets are closed).
  let final = false;
  let firing: Promise<void> | null = null;

  // Suspects probed at their deadline, waiting PROBE_MS for any inbound
  // frame. Constant delay → FIFO is deadline order. Keyed for acks.
  type Probe = { b: Batch; uid: string; since: number; due_at: number; done: boolean };
  let probes: Probe[] = [];
  let probe_head = 0;
  const probing = new Map<string, Probe>();
  const probe_key = (msg_key: string, uid: string) => `${msg_key}\u0000${uid}`;

  const compact = () => {
    if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    if (probe_head > 1024 && probe_head * 2 > probes.length) {
      probes = probes.slice(probe_head);
      probe_head = 0;
    }
  };

  /**
   * Arm after a WS delivery: `uids` are the recipients whose open socket on
   * THIS worker was just handed the frame. Only foreground sockets arm (a
   * background one already got the fan-out's push).
   */
  const arm = (uids: Iterable<string>, msg: WSMessage | null | undefined, at = now()): number => {
    if (stopped || !deps.enabled()) return 0;
    const e = fallback_eligible(msg);
    if ("skip" in e) {
      if (e.skip === "system") {
        let n = 0;
        for (const _ of uids) n++;
        count("skipped_system", n);
      }
      return 0;
    }
    const key = e.msg_id.toLowerCase();
    let b = by_msg.get(key);
    let armed = 0;
    for (const uid of uids) {
      if (!uid || uid === e.sender_id) continue;
      const c = deps.local_conn(uid);
      if (!c || c.background) continue;
      if (entries >= max_entries) {
        count("skipped_overflow");
        continue;
      }
      if (!b) {
        b = {
          key,
          msg_id: e.msg_id,
          conv_id: e.conv_id,
          seq: e.seq,
          msg: msg as WSMessage,
          uids: new Set(),
          armed_at: at,
          due_at: at + deps.delay_ms,
        };
        by_msg.set(key, b);
        queue.push(b);
      }
      if (b.uids.has(uid)) continue;
      b.uids.add(uid);
      entries++;
      armed++;
    }
    count("armed", armed);
    return armed;
  };

  /** Inbox path: the serialised frame; parsed only when it is a message:new. */
  const arm_frame = (uids: string[], frame: string, at = now()): number => {
    if (stopped || uids.length === 0 || !frame.startsWith(MESSAGE_NEW_FRAME_PREFIX) || !deps.enabled()) return 0;
    let msg: WSMessage;
    try {
      msg = JSON.parse(frame);
    } catch {
      return 0;
    }
    return arm(uids, msg, at);
  };

  /** The recipient acked (delivered or read) this message. */
  const ack = (uid: string, msg_id: string): boolean => {
    const key = msg_id.toLowerCase();
    const pr = probing.get(probe_key(key, uid));
    if (pr) {
      pr.done = true;
      probing.delete(probe_key(key, uid));
      count("acked");
      return true;
    }
    const b = by_msg.get(key);
    if (!b || !b.uids.delete(uid)) return false;
    entries--;
    count("acked");
    if (b.uids.size === 0) by_msg.delete(b.key); // its queue slot is skipped
    return true;
  };

  /** polling.cache drain hook: any drained `{uid}:message:new:{id}` key. */
  const note_drained = (uid: string, keys: Iterable<string>): void => {
    if (entries === 0 && probing.size === 0) return;
    for (const key of keys) {
      const id = acked_message_id(uid, key);
      if (id) ack(uid, id);
    }
  };

  // since: inbound after this proves the app alive; probed: already probed.
  type Due = { b: Batch; uids: string[]; since: number; probed: boolean };

  // Up to `max` (message, recipient) pairs whose deadline passed, in order:
  // answered-or-not probes first (they are the oldest), then the wheel.
  const take_due = (t: number, max: number): Due[] => {
    const out: Due[] = [];
    let taken = 0;
    while (probe_head < probes.length && taken < max) {
      const pr = probes[probe_head]!;
      if (pr.done) {
        probe_head++;
        continue;
      }
      if (pr.due_at > t) break;
      probe_head++;
      pr.done = true;
      probing.delete(probe_key(pr.b.key, pr.uid));
      out.push({ b: pr.b, uids: [pr.uid], since: pr.since, probed: true });
      taken++;
    }
    while (head < queue.length && taken < max) {
      const b = queue[head]!;
      if (b.uids.size === 0 || by_msg.get(b.key) !== b) {
        head++; // fully acked (or superseded)
        continue;
      }
      if (b.due_at > t) break;
      const uids: string[] = [];
      for (const uid of b.uids) {
        if (taken >= max) break;
        uids.push(uid);
        taken++;
      }
      for (const uid of uids) b.uids.delete(uid);
      entries -= uids.length;
      out.push({ b, uids, since: b.armed_at, probed: false });
      if (b.uids.size === 0) {
        by_msg.delete(b.key);
        head++;
      }
    }
    compact();
    return out;
  };

  const fire = async (due: Due[]): Promise<void> => {
    const total = due.reduce((n, d) => n + d.uids.length, 0);
    if (total === 0) return;
    if (!deps.enabled()) {
      count("skipped_off", total);
      return;
    }

    // 1. Foreground and talking to us since the send (or since the probe)
    //    → the app is alive. A silent foreground socket is probed once and
    //    decided PROBE_MS later.
    let cands: { b: Batch; uid: string }[] = [];
    let alive = 0;
    let probed = 0;
    const t = now();
    for (const d of due) {
      for (const uid of d.uids) {
        const c = deps.local_conn(uid);
        if (c && !c.background) {
          if ((c.last_inbound_at ?? 0) > d.since) {
            alive++;
            continue;
          }
          if (!d.probed && !final && deps.probe) {
            let sent = false;
            try {
              sent = deps.probe(uid);
            } catch {
              sent = false;
            }
            if (sent) {
              const pr: Probe = { b: d.b, uid, since: t, due_at: t + probe_ms, done: false };
              probes.push(pr);
              probing.set(probe_key(d.b.key, uid), pr);
              probed++;
              continue;
            }
          }
        }
        cands.push({ b: d.b, uid });
      }
    }
    count("skipped_alive", alive);
    count("probed", probed);
    if (cands.length === 0) return;

    // 2. Acked anywhere in the cluster?
    let pending: boolean[] | null = null;
    try {
      pending = await deps.still_pending(
        cands.map((c) => ({ uid: c.uid, msg_id: c.b.msg_id, conv_id: c.b.conv_id, seq: c.b.seq })),
      );
    } catch {
      pending = null;
    }
    if (pending) {
      const before = cands.length;
      cands = cands.filter((_, i) => pending![i] !== false);
      count("skipped_acked", before - cands.length);
    } else {
      count("check_failed", cands.length);
    }
    if (cands.length === 0) return;

    // 3. Token.
    try {
      const tok = await deps.with_token(Array.from(new Set(cands.map((c) => c.uid))));
      const before = cands.length;
      cands = cands.filter((c) => tok.has(c.uid));
      count("skipped_no_token", before - cands.length);
    } catch {
      count("token_check_failed", cands.length); // the send re-fetches tokens anyway
    }
    if (cands.length === 0) return;

    // 4. Still live (not deleted / expired since the send).
    let live: Set<string> | null = null;
    try {
      live = await deps.live_ids(Array.from(new Set(cands.map((c) => c.b.msg_id))));
    } catch {
      live = null;
    }
    if (live) {
      const before = cands.length;
      cands = cands.filter((c) => live!.has(c.b.key));
      count("skipped_deleted", before - cands.length);
    } else {
      count("live_check_failed", cands.length);
    }
    if (cands.length === 0) return;

    // 5. Push (muted chats → silent, as on the fan-out path).
    const mutes = new Map<string, Set<string>>();
    for (const c of cands) {
      let m = mutes.get(c.b.conv_id);
      if (!m) {
        try {
          m = await deps.muted(c.b.conv_id);
        } catch {
          m = new Set();
        }
        mutes.set(c.b.conv_id, m);
      }
      try {
        deps.send(c.uid, c.b.msg, { silent: m.has(c.uid) });
        count("sent");
      } catch {
        count("failed");
      }
    }
  };

  /** One tick: fire what is due (single-flight; a slow fire skips ticks). */
  const tick = (): Promise<void> | null => {
    if (firing || stopped) return firing;
    const due = take_due(now(), max_fire);
    if (due.length === 0) return null;
    firing = fire(due)
      .catch(() => count("failed"))
      .finally(() => {
        firing = null;
      });
    return firing;
  };

  const live_probes = () => probing.size;

  /** Forget everything not yet due and stop arming (tests; fire_all is the drain path). */
  const drop = (): number => {
    stopped = true;
    const n = entries + live_probes();
    queue = [];
    head = 0;
    probes = [];
    probe_head = 0;
    probing.clear();
    by_msg.clear();
    entries = 0;
    count("dropped", n);
    return n;
  };

  /**
   * Drain, after the sockets were handed over: one last pass over EVERY
   * armed entry and probe, due or not, then stop. No probes (the sockets are
   * closed); the pending / delivered check skips clients that reconnected to
   * a sibling and acked there.
   */
  const fire_all = async (): Promise<void> => {
    if (firing) await firing;
    final = true;
    const due = take_due(Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER);
    stopped = true;
    queue = [];
    head = 0;
    by_msg.clear();
    entries = 0;
    if (due.length === 0) return;
    count("final_pass", due.reduce((n, d) => n + d.uids.length, 0));
    await fire(due).catch(() => count("failed"));
  };

  /** (Re)start after a drop — a process only drains once, tests restart. */
  const resume = (): void => {
    stopped = false;
    final = false;
  };

  const stats = () => ({ pending: entries, probing: live_probes(), batches: by_msg.size, queue: queue.length - head, stopped });

  return { arm, arm_frame, ack, note_drained, tick, drop, fire_all, resume, stats, in_flight: () => firing };
};

export type AckFallback = ReturnType<typeof create_ack_fallback>;

/**
 * Of `ids`, the messages still live: not deleted and not past expires_at
 * (lower-cased; Postgres returns uuids lower-case). One primary-key probe
 * per id. Non-uuid ids never match.
 */
export const live_message_ids_sql = async (
  sql: postgres.Sql<{}> | postgres.TransactionSql<{}>,
  ids: string[],
): Promise<Set<string>> => {
  const valid = ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (valid.length === 0) return new Set();
  const rows = await sql<{ id: string }[]>`
    SELECT m.id::text AS id FROM messages m
     WHERE m.id = ANY(${sql.array(valid.map((v) => v.toLowerCase()))}::uuid[])
       AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > now())`;
  return new Set(rows.map((r) => r.id.toLowerCase()));
};

/**
 * still_pending against the pending store: HGET of the exact field
 * (`{uid}:message:new:{id}`, the key the store and every ack drain use) per
 * item, pipelined in chunks — one round trip of wall time for a normal tick.
 * A tombstone (`~v`) or a missing field = drained, i.e. acked somewhere.
 * null on any error (the caller then pushes; the client dedups by id).
 */
export const create_pending_checker = (
  client: Pick<Redis, "pipeline">,
  run: <T>(p: Promise<T>) => Promise<T> = (p) => p,
  chunk = 500,
) => async (items: FallbackItem[]): Promise<boolean[] | null> => {
  const out: boolean[] = [];
  for (let i = 0; i < items.length; i += chunk) {
    const part = items.slice(i, i + chunk);
    const pipe = client.pipeline();
    for (const it of part) pipe.hget(redis_entries_key(it.uid), `${it.uid}:message:new:${it.msg_id}`);
    let res: [Error | null, unknown][] | null;
    try {
      res = await run(pipe.exec());
    } catch {
      return null;
    }
    if (!res) return null;
    for (const [err, raw] of res) {
      if (err) return null;
      out.push(typeof raw === "string" && parse_value(raw)?.kind === "entry");
    }
  }
  return out;
};

/**
 * still_pending for a world where §3.13 suppression may have kept a proto-2
 * lease holder's message:new out of the pending store: there a missing field
 * means "never stored", not "acked". For items whose field is missing and
 * whose recipient holds the lease, the truth is the delivered watermark
 * (chat_members.delivered_seq ≥ the message's seq; every v2 and, in 'on',
 * every legacy delivered ack moves it). No seq on the frame or a failed
 * lookup → treated as not delivered (push; the client dedups by id).
 * Lease flag off → `leases` answers an empty set with no I/O, i.e. exactly
 * the pending-store check.
 */
export const create_v2_aware_checker = (deps: {
  pending: (items: FallbackItem[]) => Promise<boolean[] | null>;
  leases: (uids: string[]) => Promise<Set<string>>;
  /** Of `uids`, those whose delivered_seq in conv_id is ≥ seq. */
  delivered: (conv_id: string, seq: number, uids: string[]) => Promise<Set<string>>;
  count: (name: string, n?: number) => void;
}) => async (items: FallbackItem[]): Promise<boolean[] | null> => {
  const base = await deps.pending(items);
  if (!base) return null;
  const missing: number[] = [];
  base.forEach((p, i) => {
    if (!p) missing.push(i);
  });
  if (missing.length === 0) return base;
  let holders: Set<string>;
  try {
    holders = await deps.leases(Array.from(new Set(missing.map((i) => items[i]!.uid))));
  } catch {
    deps.count("ack_fallback_v2_lease_failed", missing.length);
    return base; // unknown: keep the store's answer (pre-§3.13 behaviour)
  }
  if (holders.size === 0) return base;
  const out = base.slice();
  const groups = new Map<string, { conv_id: string; seq: number; idx: number[] }>();
  let unknown = 0;
  for (const i of missing) {
    const it = items[i]!;
    if (!holders.has(it.uid)) continue;
    if (!it.conv_id || typeof it.seq !== "number") {
      out[i] = true;
      unknown++;
      continue;
    }
    const gk = `${it.conv_id}|${it.seq}`;
    const g = groups.get(gk) ?? { conv_id: it.conv_id, seq: it.seq, idx: [] };
    g.idx.push(i);
    groups.set(gk, g);
  }
  let acked = 0;
  let unacked = unknown;
  for (const g of groups.values()) {
    let done: Set<string> | null = null;
    try {
      done = await deps.delivered(g.conv_id, g.seq, Array.from(new Set(g.idx.map((i) => items[i]!.uid))));
    } catch {
      done = null;
    }
    for (const i of g.idx) {
      const yes = done?.has(items[i]!.uid) === true;
      out[i] = !yes;
      if (yes) acked++;
      else unacked++;
    }
  }
  if (acked > 0) deps.count("ack_fallback_v2_acked", acked);
  if (unacked > 0) deps.count("ack_fallback_v2_unacked", unacked);
  return out;
};

/** Of `uids`, the members of `conv_id` whose delivered watermark reached `seq`. */
export const delivered_upto_sql = async (
  sql: postgres.Sql<{}> | postgres.TransactionSql<{}>,
  conv_id: string,
  seq: number,
  uids: string[],
): Promise<Set<string>> => {
  if (uids.length === 0) return new Set();
  // removed_at IS NULL: repeats the partial index predicate
  // (idx_chatmemeber_user_id_chat_id_unremoved), an index probe per user.
  const rows = await sql<{ uid: string }[]>`
    SELECT cm.user_id::text AS uid FROM chat_members cm
     WHERE cm.chat_id = ${conv_id}::uuid
       AND cm.user_id = ANY(${sql.array(uids)}::uuid[])
       AND cm.removed_at IS NULL
       AND cm.delivered_seq >= ${seq}`;
  return new Set(rows.map((r) => r.uid));
};
