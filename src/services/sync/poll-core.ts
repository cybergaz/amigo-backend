// =============================================================================
// Poll v2 (POST /chat/sync/poll): pure core (SYNC_V2_PROTOCOL.md §3.11,
// §13.17, §14.9)
// =============================================================================
// No db / redis / app imports, so tests/r3-poll-v2.test.ts and the PGlite
// harness (scratchpad pglite/pollv2.ts) use it directly:
//   - request parsing and limits
//   - the versioned pending plan (merge tiers, drop acked, holds, expiry)
//   - inline delta attestation (through_seq / has_more after the caps)
// The SQL is poll-queries.ts, the waiters sync-nudge(-core).ts, the
// orchestration poll.service.ts, the route routes/sync.routes.ts.
// =============================================================================
import type { VitalWSMessage } from "@/types/socket.types";
import {
  RESEND_EXPIRY_MS,
  resend_hold_ms,
  type ReturnMeta,
} from "@/utils/poll-ack-drain.utils";
import { sort_pending_for_replay } from "@/utils/pending-order.utils";
import { is_derivable_for_v2 } from "./pending-suppress-core";
import { TAIL_GAP, is_uuid, type Parsed } from "./read-core";
import type { PinJson, SettingsJson } from "./read-queries";

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * Longest server-side wait. The timeout ladder (§13.10.5): server wait 25 s
 * < Bun idleTimeout 40 s < nginx poll read 35 s (today's /chat/poll, the
 * example config's /api/chat/sync/poll has 45 s) < Cloudflare 100 s. The
 * final computation is bounded by POLL_COMPUTE_BUDGET_MS and what follows
 * it by 2 × POLL_TAIL_AWAIT_MS, so a response always leaves before ~33 s.
 */
export const POLL_MAX_WAIT_S = 25;
/** First nudge → wait this long for more before recomputing (§3.11 step 6). */
export const POLL_COALESCE_MS = 300;
/**
 * + 0..this per waiter and window. One group message nudges every member's
 * waiter in the same tick; identical 300 ms windows would then start every
 * recomputation at once against an admission limit of ~8 (deviation from a
 * flat 300 ms: ≤ 150 ms more latency, the burst spread over the window).
 */
export const POLL_COALESCE_JITTER_MS = 150;
/**
 * A woken recomputation refused by admission control retries after
 * wake_retry_ms(attempt): 150 ms doubling to 1 s, ±25 % jitter. Without a
 * retry the news would wait for the request's deadline (up to 25 s late).
 */
export const POLL_WAKE_RETRY_MS = 150;
export const POLL_WAKE_RETRY_MAX_MS = 1_000;
export const wake_retry_ms = (attempt: number, rand: () => number = Math.random): number => {
  const base = Math.min(POLL_WAKE_RETRY_MAX_MS, POLL_WAKE_RETRY_MS * 2 ** Math.min(Math.max(0, attempt), 10));
  return Math.round(base * (0.75 + rand() * 0.5));
};
/**
 * Bound on what a response awaits AFTER its computation (the return marks,
 * the ack drain). Both use the main Redis client (offline queue, no command
 * timeout) and the ack drain's PG DELETE queues on the pool: unbounded, a
 * stalled Redis / saturated pool would hold the answer past nginx and Bun's
 * idleTimeout. Giving up costs at most a duplicate (the work continues,
 * tracked for the drain).
 */
export const POLL_TAIL_AWAIT_MS = 1_000;
/** A computation (one statement + one Redis pipeline) that takes longer answers 503. */
export const POLL_COMPUTE_BUDGET_MS = 6_000;
/** watch[] entries (§3.11: visible chat + recent chats). */
export const POLL_WATCH_MAX = 50;
/** ack[] entries per request (a response carries ≤ POLL_PENDING_MAX; the client may batch two). */
export const POLL_ACK_MAX = 500;
/** pending entries per response (§3.11 step 4); the rest → pending_more. */
export const POLL_PENDING_MAX = 200;
/** Inline delta rows per watched chat, and per response (§3.11 step 7). */
export const POLL_DELTA_PER_CHAT = 50;
export const POLL_DELTA_TOTAL = 300;
/** Entries read from the DB tier per computation (= the v1 per-user cap). */
export const POLL_PENDING_DB_READ = 500;

// ── Request ──────────────────────────────────────────────────────────────────

export type PollWatch = { chat_id: string; since: number };
export type PollAck = { key: string; v: string };

export type PollRequest = {
  req_id: string;
  wait_s: number;
  // Normalised (no W/, no quotes); null = the client has no heads yet.
  heads_etag: string | null;
  // The client's background flag in poll-lease terms: "1" (fg:false),
  // "0" (fg:true), undefined (not sent: the registry keeps what it has).
  raw_bg: "1" | "0" | undefined;
  last_resp_ver: number | null;
  watch: PollWatch[];
  ack: PollAck[];
  stubs_after: number | null;
};

// req_id travels in Redis values ("wid|req_id") and inbox headers (newline
// separated), so it is restricted to characters neither format uses.
const REQ_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
// A version the client echoes back: a UUIDv7 (lower-cased here; RC-3 mints
// lower-case and compares bytes) or "" (an entry stored before RC-3). Never
// "*": "any version" is for server-side acks that name a message, not for a
// client that names what it applied.
const ACK_V_RE = /^[0-9a-f-]{0,64}$/;
const ETAG_MAX = 100;

const seq_of = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) return Number(v);
  return undefined;
};

export const normalize_etag = (raw: string): string =>
  raw.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");

/**
 * Validate a poll body. Every malformed field is a 400 with a stable
 * `reason` (the client never retries a 400 unchanged).
 */
export const parse_poll_request = (body: unknown): Parsed<PollRequest> => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "bad_body" };
  const o = body as Record<string, unknown>;

  if (typeof o.req_id !== "string" || !REQ_ID_RE.test(o.req_id)) return { ok: false, reason: "bad_req_id" };

  let wait_s = POLL_MAX_WAIT_S;
  if (o.wait !== undefined && o.wait !== null) {
    const w = typeof o.wait === "number" ? o.wait : typeof o.wait === "string" && o.wait.trim() !== "" ? Number(o.wait) : NaN;
    if (!Number.isFinite(w) || w < 0) return { ok: false, reason: "bad_wait" };
    wait_s = Math.min(POLL_MAX_WAIT_S, Math.floor(w));
  }

  let heads_etag: string | null = null;
  if (o.heads_etag !== undefined && o.heads_etag !== null && o.heads_etag !== "") {
    if (typeof o.heads_etag !== "string" || o.heads_etag.length > ETAG_MAX) return { ok: false, reason: "bad_heads_etag" };
    heads_etag = normalize_etag(o.heads_etag) || null;
  }

  let raw_bg: "1" | "0" | undefined;
  if (o.fg !== undefined && o.fg !== null) {
    if (typeof o.fg !== "boolean") return { ok: false, reason: "bad_fg" };
    raw_bg = o.fg ? "0" : "1";
  }

  let last_resp_ver: number | null = null;
  if (o.last_resp_ver !== undefined && o.last_resp_ver !== null) {
    const v = seq_of(o.last_resp_ver);
    if (v === undefined) return { ok: false, reason: "bad_last_resp_ver" };
    last_resp_ver = v;
  }

  let stubs_after: number | null = null;
  if (o.stubs_after !== undefined && o.stubs_after !== null) {
    const v = seq_of(o.stubs_after);
    if (v === undefined) return { ok: false, reason: "bad_stubs_after" };
    stubs_after = v;
  }

  const watch: PollWatch[] = [];
  if (o.watch !== undefined && o.watch !== null) {
    if (!Array.isArray(o.watch)) return { ok: false, reason: "bad_watch" };
    if (o.watch.length > POLL_WATCH_MAX) return { ok: false, reason: `too_many_watch_max_${POLL_WATCH_MAX}` };
    const seen = new Set<string>();
    for (const raw of o.watch) {
      const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      if (!is_uuid(w.chat_id)) return { ok: false, reason: "bad_watch" };
      // Required: a client without a sync_hi for a chat does not watch it
      // (it fetches the tail, GET /chat/sync/:chat_id). A default of 0 paged
      // such a chat from its OLDEST rows, 50 per poll.
      const since = seq_of(w.since);
      if (since === undefined) return { ok: false, reason: "bad_watch" };
      const chat_id = w.chat_id.toLowerCase();
      // First occurrence wins: the client lists the visible chat first.
      if (seen.has(chat_id)) continue;
      seen.add(chat_id);
      watch.push({ chat_id, since });
    }
  }

  const ack: PollAck[] = [];
  if (o.ack !== undefined && o.ack !== null) {
    if (!Array.isArray(o.ack)) return { ok: false, reason: "bad_ack" };
    if (o.ack.length > POLL_ACK_MAX) return { ok: false, reason: `too_many_acks_max_${POLL_ACK_MAX}` };
    for (const raw of o.ack) {
      const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      if (typeof a.key !== "string" || a.key.length === 0 || a.key.length > 300) return { ok: false, reason: "bad_ack" };
      if (typeof a.v !== "string") return { ok: false, reason: "bad_ack" };
      const v = a.v.toLowerCase();
      if (!ACK_V_RE.test(v)) return { ok: false, reason: "bad_ack" };
      ack.push({ key: a.key, v });
    }
  }

  return {
    ok: true,
    value: { req_id: o.req_id, wait_s, heads_etag, raw_bg, last_resp_ver, watch, ack, stubs_after },
  };
};

/**
 * The newest acked version per key. Two acks of one key keep the higher v
 * (a client that applied v2 has necessarily seen everything ≤ v2).
 */
export const acked_versions = (ack: PollAck[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const a of ack) {
    const prev = m.get(a.key);
    if (prev === undefined || a.v > prev) m.set(a.key, a.v);
  }
  return m;
};

// ── Pending plan (§3.11 step 4, versioned; F's ret_v1 hold/expiry reused) ───
//
// "poll:sent" is F's return-meta hash poll:user:{uid}:ret_v1 (one field per
// correlation key: first:last:n, plus the version v2 returned), not a third
// structure. Rules for a poll v2 reader (it acks EVERY entry it applies with
// {key, v}, so every type is ack-drained here, unlike v1):
//   - nothing is deleted on read;
//   - an entry returned within its hold (5 s, doubling per return, ≤ 30 min)
//     and not acked is HELD: it neither makes a parked request answer early
//     nor rides a response — except a wait:0 request (LP2's recovery after a
//     timeout / error, §14.9), which gets held entries back at once;
//   - an entry first returned more than 7 days ago and never acked is
//     dropped (as v1);
//   - for a self-compacting key a NEWER version is a new fact: no hold;
//     message:new versions are the same message, so their history carries.
//   - a proto-2 lease holder (§3.13 suppression active) gets no derivable
//     entries: heads / delta rebuild them; they are drained instead (what
//     §3.13 calls the purge on the first lease, applied on every poll — the
//     same residue can also come from a lease lookup that failed open).

export type PendingEntryLike = {
  v: string;
  message_id: string; // correlation key
  ws_message: VitalWSMessage;
  created_at: number;
};

export type PendingOut = { key: string; v: string; msg: VitalWSMessage };

export type PendingPlanInput = {
  db_rows: PendingEntryLike[];
  redis_entries: PendingEntryLike[];
  meta: Map<string, ReturnMeta>;
  // Both Redis reads succeeded: only then are return marks written / pruned
  // (writing marks without having read them would reset first-return times,
  // i.e. push expiry out — v1's rule).
  meta_ok: boolean;
  entries_ok: boolean;
  acked: Map<string, string>;
  now: number;
  ignore_hold: boolean;
  suppress_derivable: boolean;
  cap?: number;
};

export type PendingPlan = {
  pending: PendingOut[];
  pending_more: boolean;
  // returnable entries (fresh + re-sends whose hold elapsed): any → answer now
  returnable: number;
  redelivered: number;
  held: number;
  meta_updates: Map<string, ReturnMeta>;
  stale_meta: string[];
  // compare-and-delete with these versions (never "*")
  drop: { key: string; v: string }[];
  expired: number;
  suppressed: number;
  // Acks that named an OLDER version than the one stored (§10
  // compare_delete_miss): the compare-and-delete kept the newer entry, which
  // this very response carries. Expected after a re-store; a steady stream
  // means a client acking stale versions.
  ack_newer: number;
};

const same_delivery = (m: ReturnMeta, e: PendingEntryLike): boolean =>
  e.ws_message.type === "message:new" || (m.v !== undefined && m.v === e.v);

export const plan_pending_v2 = (inp: PendingPlanInput): PendingPlan => {
  const cap = inp.cap ?? POLL_PENDING_MAX;
  // Tier merge: newest v per key, DB first then Redis (equal versions → the
  // Redis copy, as fetch_pending_messages).
  const merged = new Map<string, PendingEntryLike>();
  for (const e of inp.db_rows) merged.set(e.message_id, e);
  for (const e of inp.redis_entries) {
    const prev = merged.get(e.message_id);
    merged.set(e.message_id, prev && prev.v > e.v ? prev : e);
  }

  const drop: { key: string; v: string }[] = [];
  let suppressed = 0;
  let ack_newer = 0;
  const live: PendingEntryLike[] = [];
  for (const e of merged.values()) {
    // Acked in this very request: the drain runs in parallel and removes
    // exactly these (stored v ≤ acked v); a NEWER version stays and is sent.
    const a = inp.acked.get(e.message_id);
    if (a !== undefined && e.v <= a) continue;
    if (a !== undefined) ack_newer++;
    if (inp.suppress_derivable && is_derivable_for_v2(e.ws_message)) {
      drop.push({ key: e.message_id, v: e.v });
      suppressed++;
      continue;
    }
    live.push(e);
  }

  // Store order: v is a UUIDv7 (string order = store order) — the stable
  // created_at sort then only moves conversation:new ahead on a same-ms tie.
  live.sort((x, y) => (x.v < y.v ? -1 : x.v > y.v ? 1 : 0));
  sort_pending_for_replay(live);

  const candidates: { e: PendingEntryLike; m: ReturnMeta | undefined; resend: boolean }[] = [];
  let held = 0;
  let expired = 0;
  for (const e of live) {
    const m0 = inp.meta.get(e.message_id);
    const m = m0 && same_delivery(m0, e) ? m0 : undefined;
    if (m && inp.now - m.first >= RESEND_EXPIRY_MS) {
      drop.push({ key: e.message_id, v: e.v });
      expired++;
      continue;
    }
    if (m && !inp.ignore_hold && inp.now - m.last < resend_hold_ms(m.n)) {
      held++;
      continue;
    }
    candidates.push({ e, m, resend: !!m });
  }

  const out = candidates.slice(0, cap);
  const meta_updates = new Map<string, ReturnMeta>();
  let redelivered = 0;
  for (const c of out) {
    if (c.resend) redelivered++;
    meta_updates.set(c.e.message_id, {
      first: c.m?.first ?? inp.now,
      last: inp.now,
      n: (c.m?.n ?? 0) + 1,
      v: c.e.v,
    });
  }
  const stale_meta: string[] = [];
  if (inp.meta_ok && inp.entries_ok) {
    for (const k of inp.meta.keys()) if (!merged.has(k)) stale_meta.push(k);
  }
  return {
    pending: out.map((c) => ({ key: c.e.message_id, v: c.e.v, msg: c.e.ws_message })),
    pending_more: candidates.length > out.length,
    returnable: candidates.length,
    redelivered,
    held,
    meta_updates: inp.meta_ok && inp.entries_ok ? meta_updates : new Map(),
    stale_meta,
    drop,
    expired,
    suppressed,
    ack_newer,
  };
};

// ── Inline deltas (§3.9 delta mode, batched; §3.11 step 7) ──────────────────

export type PollDeltaRaw = {
  chat_id: string;
  chat_type: string | null;
  status: string | null;
  hidden: boolean;
  since: number;
  seq_head: number;
  last_seq: number | null;
  read_seq: number | null;
  delivered_seq: number | null;
  joined_seq: number | null;
  cleared_seq: number | null;
  left_seq: number | null;
  floor_seq: number;
  roster_seq: number | null;
  pin: PinJson | null;
  settings: SettingsJson | null;
  rows: { mod_seq: number }[];
  // head − since > TAIL_GAP (§3.9 auto → tail): no rows were read.
  tail: boolean;
  n_kept: number;    // rows returned (≤ per-chat cap, after the response-wide cap)
  last_mod: number | null;
  fetched: number;   // rows the statement read for the chat (≤ cap + 1)
};

export type PollDelta = Omit<PollDeltaRaw, "n_kept" | "last_mod" | "fetched" | "since" | "tail"> & {
  mode: "delta";
  mods: [];
  through_seq: number;
  has_more: boolean;
  // The chat is too far behind for inline deltas: rows [], through_seq =
  // since. The client fetches it with GET /chat/sync/:chat_id (auto → tail)
  // and leaves it out of `watch` until it has a sync_hi near the head.
  tail_needed: boolean;
};

/**
 * Attestation per chat, as finalize_page("delta"): rows are by mod_seq;
 * cut (by the per-chat cap or the response-wide cap) → through_seq = the last
 * returned mod_seq (or `since` when the response cap left none), else head.
 * The client continues a cut chat with GET /chat/sync/:chat_id?since=
 * through_seq (or simply keeps it in watch: head > since answers at once).
 */
export const finalize_poll_deltas = (raw: PollDeltaRaw[]): PollDelta[] =>
  raw.map((d) => {
    // Same rule as §3.9 auto (read-core TAIL_GAP); the SQL read no rows.
    const tail = d.tail === true || d.seq_head - d.since > TAIL_GAP;
    const cut = !tail && d.fetched > d.n_kept;
    const { n_kept: _n, last_mod: _l, fetched: _f, since: _s, tail: _t, ...rest } = d;
    return {
      ...rest,
      rows: tail ? [] : rest.rows,
      mode: "delta" as const,
      mods: [] as [],
      through_seq: tail ? d.since : cut ? (d.last_mod ?? d.since) : d.seq_head,
      has_more: tail || cut,
      tail_needed: tail,
    };
  });

// ── View (the client's heads as of the request start) ───────────────────────

/** chat_id → 16-hex hash of its etag line (poll-queries.ts `lh`). */
export type HeadsView = Map<string, string>;

export const view_from_json = (raw: unknown): HeadsView => {
  const m: HeadsView = new Map();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") m.set(k, v);
  }
  return m;
};

// ── Response decision (§3.11 step 5) ────────────────────────────────────────

export const has_news = (s: { heads_rows: number; gone: number; deltas: number; returnable: number }): boolean =>
  s.heads_rows > 0 || s.gone > 0 || s.deltas > 0 || s.returnable > 0;

/** A frame's chat id (conv_id / chat_id), for the nudge header; "-" when none. */
export const chat_of_frame = (msg: { payload?: unknown } | undefined): string => {
  const p = (msg?.payload ?? {}) as Record<string, unknown>;
  const c = p.conv_id ?? p.chat_id;
  return typeof c === "string" && c.length > 0 && c.length <= 64 && !/[\n,]/.test(c) ? c : "-";
};
