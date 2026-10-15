// =============================================================================
// Sync v2 read API: pure core (SYNC_V2_PROTOCOL.md §3.9, §3.12, §4.2, §5.12)
// =============================================================================
// Everything here is pure (no db / redis / app imports) so the repo's unit
// tests and the PGlite harness can use it directly:
//   - the gate (mode 'on' + post-backfill markers + rollout bucket)
//   - request parsing (delta query params, intents)
//   - page finalisation (through_seq / through_lo / has_more from the L+1 rows
//     the SQL returns)
//   - the heads etag
// The SQL lives in read-queries.ts, the app glue in read.service.ts /
// intents.service.ts, the routes in routes/sync.routes.ts.
// =============================================================================
import { createHash } from "node:crypto";
import { lease_action_for_connect, type SyncV2Flags } from "./flags-core";

// ── Limits (bounded pages everywhere; no OFFSET paging) ─────────────────────

/** Rows per delta / tail / backward page unless the client asks for fewer. */
export const DELTA_DEFAULT_LIMIT = 50;
/** Hard cap on rows per page (a page is one statement; bodies can be 3.5 KB). */
export const DELTA_MAX_LIMIT = 200;
/** Ids-only mods per page (tail mods and mode=mods). */
export const MODS_PAGE = 500;
/** §3.9: since NULL, or head − since > 300 → tail instead of delta. */
export const TAIL_GAP = 300;
/**
 * Shells (left / pending) see their history up to left_seq plus the system
 * rows that name them. Those rows ("X removed you") are written right after
 * the status change, so they sit just above left_seq; scanning only this many
 * clock values above it keeps a shell's delta an index range of bounded size
 * instead of a walk over everything the group said since the member left.
 */
export const SHELL_SYSTEM_WINDOW = 50;
/** POST /chat/sync/chats */
export const CHATS_MAX_IDS = 100;
/** POST /chat/sync/resolve */
export const RESOLVE_MAX_IDS = 500;
/** POST /chat/sync/intents */
export const INTENTS_MAX = 100;
/** message_ids per delete intent (same order of magnitude as the legacy delete). */
export const INTENT_MAX_IDS = 100;
/** Heads stub body (§4.2: body≤160). */
export const STUB_BODY_CHARS = 160;
/** Protocol version every /chat/sync/* response carries. */
export const SYNC_PROTO = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const is_uuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// ── Gate ─────────────────────────────────────────────────────────────────────

export type GateReason = "sync_v2_off" | "sync_v2_not_ready" | "sync_v2_not_in_rollout";
export type GateResult = { ok: true } | { ok: false; reason: GateReason };

/**
 * Rollout bucket of a user, 0..99 (FNV-1a over the lower-cased id). Stable
 * across workers and restarts, so a user is either in or out everywhere —
 * the chat list's syncProto and the /chat/sync/* gate MUST use this same
 * function or a user could be told "v2" and then get 404s.
 */
export const rollout_bucket = (user_id: string): number => {
  let h = 0x811c9dc5;
  const s = user_id.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
};

export const in_rollout = (user_id: string, pct: number): boolean =>
  pct >= 100 ? true : pct <= 0 ? false : rollout_bucket(user_id) < pct;

/**
 * app_settings.sync_v2_rollout_pct (§5.14), parsed by flags-core (default 0).
 * Still read defensively: a snapshot built without the field (tests, an
 * older caller) counts as 100, i.e. the gate is then mode 'on' + markers.
 */
export const rollout_pct_of = (f: SyncV2Flags): number => {
  const raw = (f as SyncV2Flags & { rollout_pct?: unknown }).rollout_pct;
  if (raw === undefined || raw === null) return 100;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

/**
 * THE gate for every R1b read/intent surface (/chat/sync/*, the pinned
 * endpoint). Open only when:
 *   - app_settings.sync_v2 = 'on' (shadow serves nothing new),
 *   - the backfill and post-backfill indexes are done (markers
 *     sync_v2_backfill + sync_v2_indexes_post): before them seq is NULL on old
 *     rows and every delta would walk a chat without its (chat_id, seq) index,
 *   - the user's rollout bucket is in (sync_v2_rollout_pct, once it exists).
 * Closed → the routes answer 404, exactly what an old backend answers, which
 * is what the client's capability probe expects (§4.1).
 */
export const sync_v2_gate = (user_id: string, f: SyncV2Flags): GateResult => {
  if (f.mode !== "on") return { ok: false, reason: "sync_v2_off" };
  if (!f.markers.backfill || !f.markers.indexes_post) return { ok: false, reason: "sync_v2_not_ready" };
  if (!in_rollout(user_id, rollout_pct_of(f))) return { ok: false, reason: "sync_v2_not_in_rollout" };
  return { ok: true };
};

/** The syncProto value for this user (§4.1): 2 when the gate is open, else 0. */
export const sync_proto_for = (user_id: string, f: SyncV2Flags): 2 | 0 =>
  sync_v2_gate(user_id, f).ok ? 2 : 0;

/**
 * socket:ready `proto` (§4.3, §14.5 item 5). 2 only when the client asked for
 * it (?proto=2, parsed exactly like the proto:{uid} lease) AND the gate is
 * open for this user; otherwise the legacy 1. Both conditions matter: a
 * proto-2 client told "2" while the gate is closed would switch to the
 * /chat/sync/* routes and get 404s, and an old app must keep seeing today's
 * frame byte for byte.
 */
export const ws_ready_proto = (user_id: string, query_proto: string | null | undefined, f: SyncV2Flags): 1 | 2 =>
  lease_action_for_connect(query_proto) === "set" && sync_v2_gate(user_id, f).ok ? 2 : 1;

// ── Delta query params (GET /chat/sync/:chat_id) ─────────────────────────────

export type DeltaMode = "auto" | "delta" | "tail" | "backward" | "mods";
export type DeltaParams = {
  mode: DeltaMode;
  since: number | null;
  before: number | null;
  limit: number;
};

const parse_seq = (v: unknown): number | null | undefined => {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{1,15}$/.test(s)) return undefined; // not a non-negative safe integer
  return Number(s);
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * since: last clock value the client holds contiguously (absent → tail).
 * mode:  auto (default) | delta | tail | backward | mods.
 *        auto = tail when since is absent or head − since > 300, else delta.
 *        backward needs `before`; mods needs `since` and `before` (the
 *        through_lo of the tail it continues).
 * limit: 1..200 rows (default 50); mods pages are fixed at 500 ids.
 */
export const parse_delta_params = (q: Record<string, unknown>): Parsed<DeltaParams> => {
  const since = parse_seq(q.since);
  const before = parse_seq(q.before);
  if (since === undefined) return { ok: false, reason: "bad_since" };
  if (before === undefined || before === 0) return { ok: false, reason: "bad_before" };
  let limit = DELTA_DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== "") {
    const l = parse_seq(q.limit);
    if (l === undefined || l === null || l < 1) return { ok: false, reason: "bad_limit" };
    limit = Math.min(DELTA_MAX_LIMIT, l);
  }
  const raw_mode = q.mode === undefined || q.mode === "" ? null : String(q.mode);
  let mode: DeltaMode;
  if (raw_mode === null) mode = before !== null ? "backward" : "auto";
  else if (["auto", "delta", "tail", "backward", "mods"].includes(raw_mode)) mode = raw_mode as DeltaMode;
  else return { ok: false, reason: "bad_mode" };
  if (mode === "backward" && before === null) return { ok: false, reason: "before_required" };
  if (mode === "mods" && (before === null || since === null)) return { ok: false, reason: "since_and_before_required" };
  return { ok: true, value: { mode, since, before, limit } };
};

/** The mode the SQL resolves `auto` to (mirrored in read-queries.ts). */
export const resolve_mode = (p: DeltaParams, seq_head: number): Exclude<DeltaMode, "auto"> => {
  if (p.mode !== "auto") return p.mode;
  return p.since === null || seq_head - p.since > TAIL_GAP ? "tail" : "delta";
};

// ── Page finalisation (the SQL returns up to L+1 rows; JS cuts and attests) ──

export type PageRowKeys = { seq: number; mod_seq: number };

export type PageAttest<R> = {
  rows: R[];
  through_seq: number;
  through_lo: number | null;
  floor: boolean;
  has_more: boolean;
};

/**
 * delta: rows ordered by mod_seq; through_seq = last returned mod_seq when the
 *        page is cut, else head (everything up to head is attested, rows
 *        below the viewer's floor included — skipped but covered).
 * tail:  rows ordered by seq DESC; attests [through_lo, head]; through_lo =
 *        the lowest returned seq when cut, else floor+1 (floor: true).
 * backward: rows ordered by seq DESC below `before`; attests
 *        [through_lo, before−1].
 */
export const finalize_page = <R extends PageRowKeys>(
  mode: "delta" | "tail" | "backward",
  rows: R[],
  limit: number,
  seq_head: number,
  floor_seq: number,
  before: number | null = null,
): PageAttest<R> => {
  const cut = rows.length > limit;
  const page = cut ? rows.slice(0, limit) : rows;
  if (mode === "delta") {
    return {
      rows: page,
      through_seq: cut ? page[page.length - 1]!.mod_seq : seq_head,
      through_lo: null,
      floor: false,
      has_more: cut,
    };
  }
  const through_lo = cut ? page[page.length - 1]!.seq : floor_seq + 1;
  return {
    rows: page,
    through_seq: mode === "tail" ? seq_head : Math.min(seq_head, (before ?? seq_head + 1) - 1),
    through_lo,
    floor: !cut,
    has_more: mode === "backward" ? cut : false,
  };
};

/** Mods page: ids ordered by mod_seq, M+1 fetched. */
export const finalize_mods = <M extends { mod_seq: number }>(mods: M[], seq_head: number) => {
  const cut = mods.length > MODS_PAGE;
  const page = cut ? mods.slice(0, MODS_PAGE) : mods;
  return {
    mods: page,
    has_more_mods: cut,
    // Continue with since = mods_through (and the same before) while has_more_mods.
    mods_through: cut ? page[page.length - 1]!.mod_seq : seq_head,
  };
};

// ── Heads etag ───────────────────────────────────────────────────────────────

export type EtagInput = {
  chat_id: string;
  status: string;
  seq_head: number | null;
  read_seq: number;
  delivered_seq: number;
  joined_seq: number;
  cleared_seq: number;
  left_seq: number | null;
  pin_seq: number;
  settings_seq: number;
  roster_seq: number;
  others_read_seq: number | null;
  others_delivered_seq: number | null;
};

/**
 * md5 over the per-chat absolute state (§2.1 "heads etag"), rows in chat id
 * order. A change detector, not a cursor. Unread is not an input (it is
 * derived from these). For shells only the frozen floors count, so a group
 * the user left does not churn the etag with every message it receives.
 */
export const heads_etag = (rows: EtagInput[]): string => {
  const lines = rows
    .map((r) =>
      r.status === "active"
        ? [r.chat_id, "a", r.seq_head ?? "n", r.read_seq, r.delivered_seq, r.joined_seq, r.cleared_seq,
          r.pin_seq, r.settings_seq, r.roster_seq, r.others_read_seq ?? "n", r.others_delivered_seq ?? "n"].join(",")
        : [r.chat_id, r.status, r.left_seq ?? "n", r.joined_seq, r.cleared_seq].join(","))
    .sort();
  return "h2-" + createHash("md5").update(lines.join("\n")).digest("hex");
};

/**
 * If-None-Match match, tolerant of weak validators and lists: Cloudflare or
 * nginx may weaken an ETag when compressing (§14.7), so W/ is stripped on
 * both sides.
 */
export const etag_matches = (if_none_match: string | null | undefined, etag: string): boolean => {
  if (!if_none_match) return false;
  const norm = (s: string) => s.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
  const want = norm(etag);
  return if_none_match.split(",").some((t) => {
    const v = norm(t);
    return v === "*" || v === want;
  });
};

/** stubs_after: epoch ms; absent → no stubs. */
export const parse_stubs_after = (v: unknown): number | null | undefined => {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (!/^\d{1,16}$/.test(s)) return undefined;
  return Number(s);
};

// ── Id lists (chats / resolve) ───────────────────────────────────────────────

export const parse_id_list = (raw: unknown, max: number): Parsed<string[]> => {
  if (!Array.isArray(raw)) return { ok: false, reason: "ids_required" };
  if (raw.length > max) return { ok: false, reason: `too_many_ids_max_${max}` };
  const ids = Array.from(new Set(raw.filter(is_uuid).map((s) => s.toLowerCase())));
  return { ok: true, value: ids };
};

// ── Intents (POST /chat/sync/intents, §4.2 / §5.12) ──────────────────────────

export type IntentKind = "receipt" | "pin" | "react" | "delete_everyone" | "delete_me" | "clear";
export const INTENT_KINDS: readonly IntentKind[] = ["receipt", "pin", "react", "delete_everyone", "delete_me", "clear"];

type IntentBase = { request_id: string; chat_id: string };
export type Intent =
  | (IntentBase & { kind: "receipt"; read_seq: number | null; delivered_seq: number | null })
  | (IntentBase & { kind: "pin"; message_id: string | null; base_pin_seq: number | null; unpin_target: string | null })
  | (IntentBase & { kind: "react"; message_id: string; reaction: string | null })
  | (IntentBase & { kind: "delete_everyone"; message_ids: string[] })
  | (IntentBase & { kind: "delete_me"; message_ids: string[] })
  | (IntentBase & { kind: "clear"; upto_seq: number | null });

export type IntentStatus = "applied" | "noop" | "rejected" | "retry";

export type IntentResult = {
  request_id: string;
  kind: string;
  chat_id: string | null;
  status: IntentStatus;
  code: number;
  // Machine-readable why (rejections, retries and noops). Stable strings:
  // the client keys toasts / restores on them.
  reason?: string;
  // Authoritative state (§4.2), present even on `rejected` when the chat is
  // readable by the caller.
  state: unknown;
};

const opt_seq = (v: unknown): number | null | undefined => {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) return Number(v);
  return undefined;
};

const id_list = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v) || v.length === 0 || v.length > INTENT_MAX_IDS) return undefined;
  if (!v.every(is_uuid)) return undefined;
  return Array.from(new Set((v as string[]).map((s) => s.toLowerCase())));
};

export type ParsedIntent =
  | { ok: true; intent: Intent }
  | { ok: false; result: IntentResult };

/**
 * Validate one raw intent. A malformed intent is a terminal `rejected` 400
 * with a reason (never retried by the client), and it never stops the rest
 * of the batch.
 */
export const parse_intent = (raw: unknown): ParsedIntent => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const request_id = typeof o.request_id === "string" && o.request_id.length > 0 && o.request_id.length <= 100
    ? o.request_id : "";
  const kind = typeof o.kind === "string" ? o.kind : "";
  const chat_id = is_uuid(o.chat_id) ? o.chat_id.toLowerCase() : null;
  const bad = (reason: string): ParsedIntent => ({
    ok: false,
    result: { request_id, kind, chat_id, status: "rejected", code: 400, reason, state: null },
  });
  if (!request_id) return bad("bad_request_id");
  if (!INTENT_KINDS.includes(kind as IntentKind)) return bad("unknown_kind");
  if (!chat_id) return bad("bad_chat_id");
  const base = { request_id, chat_id };
  switch (kind as IntentKind) {
    case "receipt": {
      const read_seq = opt_seq(o.read_seq);
      const delivered_seq = opt_seq(o.delivered_seq);
      if (read_seq === undefined || delivered_seq === undefined) return bad("bad_seq");
      if (read_seq === null && delivered_seq === null) return bad("empty_receipt");
      return { ok: true, intent: { ...base, kind: "receipt", read_seq, delivered_seq } };
    }
    case "pin": {
      const message_id = o.message_id === null || o.message_id === undefined ? null
        : is_uuid(o.message_id) ? o.message_id.toLowerCase() : undefined;
      const unpin_target = o.unpin_target === null || o.unpin_target === undefined ? null
        : is_uuid(o.unpin_target) ? o.unpin_target.toLowerCase() : undefined;
      const base_pin_seq = opt_seq(o.base_pin_seq);
      if (message_id === undefined) return bad("bad_message_id");
      if (unpin_target === undefined) return bad("bad_unpin_target");
      if (base_pin_seq === undefined) return bad("bad_base_pin_seq");
      return { ok: true, intent: { ...base, kind: "pin", message_id, base_pin_seq, unpin_target } };
    }
    case "react": {
      if (!is_uuid(o.message_id)) return bad("bad_message_id");
      const reaction = o.reaction === null || o.reaction === undefined ? null
        : typeof o.reaction === "string" && o.reaction.length > 0 && o.reaction.length <= 50 ? o.reaction : undefined;
      if (reaction === undefined) return bad("bad_reaction");
      return { ok: true, intent: { ...base, kind: "react", message_id: o.message_id.toLowerCase(), reaction } };
    }
    case "delete_everyone":
    case "delete_me": {
      const ids = id_list(o.message_ids);
      if (!ids) return bad("bad_message_ids");
      return { ok: true, intent: { ...base, kind: kind as "delete_everyone" | "delete_me", message_ids: ids } };
    }
    case "clear": {
      const upto_seq = opt_seq(o.upto_seq);
      if (upto_seq === undefined) return bad("bad_upto_seq");
      return { ok: true, intent: { ...base, kind: "clear", upto_seq } };
    }
  }
};

// ── set_pin classification (§3.12) ──────────────────────────────────────────

export type PinOutcome = "applied" | "noop" | "conflict" | "not_stored" | "not_found" | "forbidden" | "unsupported" | "no_chat";

/**
 * Why a set_pin UPDATE changed nothing, from a FRESH read of the chat (the
 * UPDATE's own snapshot may predate a concurrent pin it waited for).
 * Order matters: "already in that state" wins over a stale base (§3.12).
 */
export const classify_pin_miss = (s: {
  chat_exists: boolean;
  member: boolean;
  chat_type: string | null;
  pinned_msg_id: string | null;
  pin_seq: number;
  target_in_chat: boolean;   // a row with that id exists in this chat
  target_live: boolean;      // ... and is not deleted
}, req: { message_id: string | null; base_pin_seq: number | null; unpin_target: string | null }): PinOutcome => {
  if (!s.chat_exists) return "no_chat";
  if (!s.member) return "forbidden";
  if (s.chat_type === "broadcast") return "unsupported";
  const same = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  if (same(s.pinned_msg_id, req.message_id)) return "noop";
  if (req.base_pin_seq !== null && s.pin_seq !== req.base_pin_seq) return "conflict";
  if (req.unpin_target !== null && !same(s.pinned_msg_id, req.unpin_target)) return "conflict";
  if (req.message_id !== null && !s.target_in_chat) return "not_stored";
  if (req.message_id !== null && !s.target_live) return "not_found";
  // The fresh read says the UPDATE should have matched: a concurrent change
  // landed between the two statements. Report it as a conflict with the
  // fresh state; the client re-bases (§5.12 409).
  return "conflict";
};

export const PIN_OUTCOME_HTTP: Record<PinOutcome, { status: IntentStatus; code: number }> = {
  applied: { status: "applied", code: 200 },
  noop: { status: "noop", code: 200 },
  conflict: { status: "rejected", code: 409 },
  not_stored: { status: "retry", code: 425 },
  not_found: { status: "rejected", code: 404 },
  forbidden: { status: "rejected", code: 403 },
  unsupported: { status: "rejected", code: 400 },
  no_chat: { status: "rejected", code: 404 },
};
