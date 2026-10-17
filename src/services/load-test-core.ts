// =============================================================================
// Load & accuracy test tool — pure rules (no db / redis imports)
// =============================================================================
// The sub_admin debug screen (app) and /api/sub-admin/load-test/* (backend)
// share one contract: test users, the message body format, caps and the
// verify math. Everything here is pure so tests/load-test.test.ts can pin it
// down without a database; load-test.service.ts does the I/O.
//
// Test users are recognised by phone only: `+99900` + 7 digits. +999 is not
// an assigned country calling code, so no real subscriber can own one, and
// the tool refuses to act as anyone else (not_a_test_user).
// =============================================================================
import { createHash } from "node:crypto";

export const TEST_PHONE_PREFIX = "+99900";
export const TEST_PHONE_DIGITS = 7;
export const TEST_NAME_PREFIX = "LT ";
// Group titles of the tool: `LT·<tag>·NN`. U+00B7 (middle dot), so a real
// group typed by a person ("LT ...", "LT-...") is never mistaken for one.
export const TEST_GROUP_PREFIX = "LT·";

export const CAPS = Object.freeze({
  users_per_call: 500,
  total_test_users: 3000,
  groups_per_call: 200,
  members_per_group: 1000,
  sends_per_batch: 5000,
  // Not in the contract's cap list; bounded for the same reason (one request
  // must not hold a worker for minutes).
  dm_pairs_per_call: 500,
  chats_per_call: 200,
  default_concurrency: 50,
  max_concurrency: 200,
  users_page_max: 500,
});

// ── test users ──────────────────────────────────────────────────────────────

export const test_phone = (n: number): string =>
  TEST_PHONE_PREFIX + String(n).padStart(TEST_PHONE_DIGITS, "0");

export const test_name = (n: number): string => TEST_NAME_PREFIX + String(n).padStart(4, "0");

const TEST_PHONE_RE = new RegExp(`^\\${TEST_PHONE_PREFIX}\\d{${TEST_PHONE_DIGITS}}$`);
export const is_test_phone = (phone: string | null | undefined): boolean =>
  typeof phone === "string" && TEST_PHONE_RE.test(phone);

/** The numeric suffix of a test phone (+999000000042 → 42), else null. */
export const test_phone_number = (phone: string | null | undefined): number | null =>
  is_test_phone(phone) ? Number(phone!.slice(TEST_PHONE_PREFIX.length)) : null;

// ── run tag + message body ─────────────────────────────────────────────────

export const RUN_RE = /^[a-z0-9]{6}$/;
export const BODY_RE = /^(\d+)(?:\/(\d+))? \[LT ([a-z0-9]{6})\]$/;

export const format_body = (n: number, run: string, N?: number | null): string =>
  N != null ? `${n}/${N} [LT ${run}]` : `${n} [LT ${run}]`;

export type ParsedBody = { n: number; N: number | null; run: string };

export const parse_body = (body: string | null | undefined): ParsedBody | null => {
  if (typeof body !== "string") return null;
  const m = BODY_RE.exec(body);
  if (!m) return null;
  return { n: Number(m[1]), N: m[2] !== undefined ? Number(m[2]) : null, run: m[3] };
};

// The SQL side of the same match (verify): LIKE prefilter + the exact regex
// for ONE run. `run` must have passed RUN_RE (it is a bind parameter anyway).
export const body_like_for = (run: string): string => `% [LT ${run}]`;
export const body_regex_for = (run: string): string => `^[0-9]+(/[0-9]+)? \\[LT ${run}\\]$`;

// ── checksum ────────────────────────────────────────────────────────────────
// Order-independent: sum over message ids of int(first 8 hex chars of
// md5(id as text)) mod 2^32, as a decimal string. The app computes the same
// from its Drift rows; the server computes the per-stream sums in SQL
// (load_test verify) and folds them here.

export const CHECKSUM_MOD = 4294967296n;

export const id_checksum_part = (id: string): number =>
  parseInt(createHash("md5").update(id).digest("hex").slice(0, 8), 16);

export const checksum_of_ids = (ids: Iterable<string>): string => {
  let s = 0n;
  for (const id of ids) s += BigInt(id_checksum_part(id));
  return (s % CHECKSUM_MOD).toString();
};

/** Fold partial sums (decimal strings / numbers, e.g. per-stream SQL sums). */
export const fold_checksums = (parts: Iterable<string | number | bigint | null | undefined>): string => {
  let s = 0n;
  for (const p of parts) {
    if (p === null || p === undefined || p === "") continue;
    s += BigInt(typeof p === "number" ? Math.trunc(p) : p);
  }
  return (s % CHECKSUM_MOD).toString();
};

// ── verify math ─────────────────────────────────────────────────────────────

export type StreamStats = {
  sender_id: string | null;
  count: number;
  distinct_n: number;
  min_n: number | null;
  max_n: number | null;
  declared_N: number | null;
  duplicates: number;
  order_violations: number;
};

/** One row per (chat, sender) as the verify SQL returns it. */
export type StreamAggRow = {
  chat_id: string;
  sender_id: string | null;
  cnt: number | string;
  distinct_n: number | string;
  min_n: number | string | null;
  max_n: number | string | null;
  declared_n: number | string | null;
  order_violations: number | string;
  ck_sum: string | number | null;
  min_seq: number | string | null;
  max_seq: number | string | null;
};

export type SeqRange = { min: number; max: number; rows_in_range: number; holes: number } | null;

export type VerifyChat = {
  chat_id: string;
  total: number;
  checksum: string;
  streams: StreamStats[];
  seq: SeqRange;
  my_unread: number | null;
  my_read_seq: number | null;
  my_delivered_seq: number | null;
};

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

export const stream_from_agg = (r: StreamAggRow): StreamStats => {
  const count = Number(r.cnt);
  const distinct = Number(r.distinct_n);
  return {
    sender_id: r.sender_id,
    count,
    distinct_n: distinct,
    min_n: num(r.min_n),
    max_n: num(r.max_n),
    declared_N: num(r.declared_n),
    duplicates: count - distinct,
    order_violations: Number(r.order_violations),
  };
};

/** The run's seq span in one chat from its stream rows (null = unnumbered). */
export const seq_span = (rows: StreamAggRow[]): { min: number; max: number } | null => {
  let min: number | null = null;
  let max: number | null = null;
  for (const r of rows) {
    const a = num(r.min_seq);
    const b = num(r.max_seq);
    if (a !== null && (min === null || a < min)) min = a;
    if (b !== null && (max === null || b > max)) max = b;
  }
  return min === null || max === null ? null : { min, max };
};

export const seq_range = (span: { min: number; max: number } | null, rows_in_range: number): SeqRange =>
  span === null
    ? null
    : { min: span.min, max: span.max, rows_in_range, holes: span.max - span.min + 1 - rows_in_range };

/** One chat's verify entry from its stream rows (+ the I/O-sourced parts). */
export const build_verify_chat = (
  chat_id: string,
  rows: StreamAggRow[],
  extra: { rows_in_range: number; my_unread: number | null; my_read_seq: number | null; my_delivered_seq: number | null },
): VerifyChat => {
  const streams = rows.map(stream_from_agg).sort((a, b) => String(a.sender_id).localeCompare(String(b.sender_id)));
  return {
    chat_id,
    total: streams.reduce((s, x) => s + x.count, 0),
    checksum: fold_checksums(rows.map((r) => (r.ck_sum === null ? null : String(r.ck_sum)))),
    streams,
    seq: seq_range(seq_span(rows), extra.rows_in_range),
    my_unread: extra.my_unread,
    my_read_seq: extra.my_read_seq,
    my_delivered_seq: extra.my_delivered_seq,
  };
};

export type RawRunRow = {
  id: string;
  sender_id: string | null;
  body: string | null;
  seq: number | null;
  created_at: Date | string | number;
  deleted?: boolean;
};

/**
 * Reference implementation of the verify math over raw message rows of ONE
 * chat (what the SQL computes): only live rows whose body matches the run.
 * Order = seq (nulls last), then created_at, then id — the SQL's window order.
 * Used by the tests to pin the SQL down; the app does the same locally.
 */
export const summarize_run_rows = (run: string, rows: RawRunRow[]) => {
  const ms = (v: Date | string | number) => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v));
  const mine = rows
    .filter((r) => !r.deleted)
    .map((r) => ({ r, p: parse_body(r.body) }))
    .filter((x): x is { r: RawRunRow; p: ParsedBody } => x.p !== null && x.p.run === run);
  const by_sender = new Map<string, { r: RawRunRow; p: ParsedBody }[]>();
  for (const x of mine) {
    const k = String(x.r.sender_id);
    const list = by_sender.get(k) ?? [];
    list.push(x);
    by_sender.set(k, list);
  }
  const streams: StreamStats[] = [];
  for (const list of by_sender.values()) {
    list.sort((a, b) => {
      const sa = a.r.seq, sb = b.r.seq;
      if (sa !== sb) {
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sa - sb;
      }
      const t = ms(a.r.created_at) - ms(b.r.created_at);
      return t !== 0 ? t : a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0;
    });
    const ns = list.map((x) => x.p.n);
    let order_violations = 0;
    for (let i = 1; i < ns.length; i++) if (ns[i] < ns[i - 1]) order_violations++;
    const declared = list.map((x) => x.p.N).filter((v): v is number => v !== null);
    const distinct = new Set(ns).size;
    streams.push({
      sender_id: list[0].r.sender_id,
      count: list.length,
      distinct_n: distinct,
      min_n: Math.min(...ns),
      max_n: Math.max(...ns),
      declared_N: declared.length ? Math.max(...declared) : null,
      duplicates: list.length - distinct,
      order_violations,
    });
  }
  streams.sort((a, b) => String(a.sender_id).localeCompare(String(b.sender_id)));
  const seqs = mine.map((x) => x.r.seq).filter((s): s is number => s !== null);
  const span = seqs.length ? { min: Math.min(...seqs), max: Math.max(...seqs) } : null;
  // Every row of the chat (any body, deleted too: a deleted row keeps its seq).
  const rows_in_range = span ? rows.filter((r) => r.seq !== null && r.seq >= span.min && r.seq <= span.max).length : 0;
  return {
    total: mine.length,
    checksum: checksum_of_ids(mine.map((x) => x.r.id)),
    streams,
    seq: seq_range(span, rows_in_range),
  };
};

// ── latency stats ───────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0..100) of an unsorted list; 0 when empty. */
export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
};

export type SendResult = {
  chat_id: string;
  sender_id: string;
  n: number;
  id: string;
  ok: boolean;
  code: number;
  ms: number;
  seq?: number;
};

export const send_stats = (results: SendResult[], wall_ms: number) => {
  const ms = results.map((r) => r.ms);
  let ok = 0, failed = 0, refused = 0;
  for (const r of results) {
    if (r.ok) ok++;
    else if (is_refusal(r.code)) refused++;
    else failed++;
  }
  return {
    ok,
    failed,
    refused,
    ms_p50: percentile(ms, 50),
    ms_p95: percentile(ms, 95),
    ms_max: ms.length ? Math.max(...ms) : 0,
    wall_ms,
  };
};

// "refused" = the server said no on purpose (not a member, not a test chat,
// unknown chat), as opposed to a failure the client would retry.
export const is_refusal = (code: number): boolean => code === 403 || code === 404;

// ── concurrency helpers ─────────────────────────────────────────────────────

/** Run fn over items with at most `limit` in flight; results in input order. */
export const run_pool = async <T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
};

/**
 * Like run_pool, but items with the same key run strictly one after another
 * in input order, while different keys run concurrently (at most `limit` in
 * flight overall). The send burst uses it with key = (chat, sender): a stream
 * is sent the way one phone sends it (n-1 is acked before n goes), so an
 * order violation in verify is a server fault, never an artefact of the burst.
 * Streams are served round-robin so one long stream does not starve others.
 */
export const run_keyed_pool = async <T, R>(
  items: T[],
  key: (item: T) => string,
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  const queues = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const k = key(items[i]);
    const q = queues.get(k);
    if (q) q.push(i);
    else queues.set(k, [i]);
  }
  const ready: string[] = [...queues.keys()];
  let head = 0;
  const worker = async () => {
    while (head < ready.length) {
      const k = ready[head++];
      const q = queues.get(k)!;
      const i = q.shift()!;
      out[i] = await fn(items[i], i);
      if (q.length > 0) ready.push(k);
    }
  };
  // Never more workers than streams: a worker only ever holds one stream.
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queues.size)) }, worker));
  return out;
};

/** k distinct random picks from `pool` (Fisher–Yates prefix). */
export const pick_random = <T>(pool: readonly T[], k: number, rnd: () => number = Math.random): T[] => {
  const a = [...pool];
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

// ── group titles ────────────────────────────────────────────────────────────

const TAG_RE = /^[A-Za-z0-9_-]{1,16}$/;

export const random_tag = (rnd: () => number = Math.random): string =>
  Array.from({ length: 4 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rnd() * 36)]).join("");

/** `LT·<tag>·NN` — NN zero-padded to the width of `count` (min 2). */
export const group_title = (tag: string, index1: number, count: number): string =>
  `${TEST_GROUP_PREFIX}${tag}·${String(index1).padStart(Math.max(2, String(count).length), "0")}`;

export const is_test_group_title = (title: string | null | undefined): boolean =>
  typeof title === "string" && title.startsWith(TEST_GROUP_PREFIX);

// ── request parsing ─────────────────────────────────────────────────────────
// Bodies are parsed here (not by Elysia's t.*) so a bad request gets one
// clear 400 with a reason the app can show, and the rules are unit-tested.

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string; reason: string };

const bad = (message: string, reason = "bad_request"): { ok: false; message: string; reason: string } =>
  ({ ok: false, message, reason });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const is_uuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const obj = (b: unknown): Record<string, unknown> | null =>
  b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;

const int_in = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

const uuid_list = (v: unknown, max: number, field: string): Parsed<string[]> => {
  if (!Array.isArray(v) || v.length === 0) return bad(`${field} must be a non-empty array`);
  if (v.length > max) return bad(`${field}: at most ${max} per call`, "cap_exceeded");
  if (!v.every(is_uuid)) return bad(`${field} must contain ids (uuid)`);
  return { ok: true, value: [...new Set(v.map((s) => s.toLowerCase()))] };
};

export const parse_users_body = (b: unknown): Parsed<{ count: number }> => {
  const o = obj(b);
  const count = int_in(o?.count, 1, Number.MAX_SAFE_INTEGER);
  if (count === null) return bad("count must be a positive integer");
  if (count > CAPS.users_per_call) return bad(`count: at most ${CAPS.users_per_call} per call`, "cap_exceeded");
  return { ok: true, value: { count } };
};

export const parse_page_query = (q: Record<string, unknown> | undefined): { limit: number; offset: number } => {
  const n = (v: unknown, d: number) => {
    const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(x) ? Math.trunc(x) : d;
  };
  return {
    limit: Math.min(CAPS.users_page_max, Math.max(1, n(q?.limit, 100))),
    offset: Math.max(0, n(q?.offset, 0)),
  };
};

export const parse_dms_body = (b: unknown): Parsed<{ pairs: [string, string][] }> => {
  const pairs = obj(b)?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) return bad("pairs must be a non-empty array of [a, b]");
  if (pairs.length > CAPS.dm_pairs_per_call) return bad(`pairs: at most ${CAPS.dm_pairs_per_call} per call`, "cap_exceeded");
  const out: [string, string][] = [];
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2 || !is_uuid(p[0]) || !is_uuid(p[1])) return bad("every pair must be [user_id, user_id]");
    const a = p[0].toLowerCase(), c = p[1].toLowerCase();
    if (a === c) return bad("a pair needs two different users");
    out.push([a, c]);
  }
  return { ok: true, value: { pairs: out } };
};

export const parse_groups_body = (b: unknown): Parsed<{ count: number; members_per_group: number; include_me: boolean; title_prefix: string | null }> => {
  const o = obj(b);
  const count = int_in(o?.count, 1, Number.MAX_SAFE_INTEGER);
  if (count === null) return bad("count must be a positive integer");
  if (count > CAPS.groups_per_call) return bad(`count: at most ${CAPS.groups_per_call} per call`, "cap_exceeded");
  const mpg = int_in(o?.members_per_group, 0, Number.MAX_SAFE_INTEGER);
  if (mpg === null) return bad("members_per_group must be a non-negative integer");
  if (mpg > CAPS.members_per_group) return bad(`members_per_group: at most ${CAPS.members_per_group}`, "cap_exceeded");
  if (o?.include_me !== undefined && typeof o.include_me !== "boolean") return bad("include_me must be a boolean");
  const include_me = o?.include_me !== false;
  // Without the caller the creator is one of the members, so there must be one.
  if (!include_me && mpg < 1) return bad("members_per_group must be >= 1 when include_me is false");
  let title_prefix: string | null = null;
  if (o?.title_prefix !== undefined && o.title_prefix !== null && o.title_prefix !== "") {
    if (typeof o.title_prefix !== "string" || !TAG_RE.test(o.title_prefix)) {
      return bad("title_prefix: 1-16 chars of A-Z a-z 0-9 _ -");
    }
    title_prefix = o.title_prefix;
  }
  return { ok: true, value: { count, members_per_group: mpg, include_me, title_prefix } };
};

export const parse_members_body = (b: unknown): Parsed<{ chat_ids: string[]; add: number; remove: number }> => {
  const o = obj(b);
  const ids = uuid_list(o?.chat_ids, CAPS.chats_per_call, "chat_ids");
  if (!ids.ok) return ids;
  const add = o?.add === undefined ? 0 : int_in(o.add, 0, CAPS.members_per_group);
  const remove = o?.remove === undefined ? 0 : int_in(o.remove, 0, CAPS.members_per_group);
  if (add === null) return bad(`add must be an integer 0..${CAPS.members_per_group}`);
  if (remove === null) return bad(`remove must be an integer 0..${CAPS.members_per_group}`);
  if (add === 0 && remove === 0) return bad("nothing to do: add and remove are both 0");
  return { ok: true, value: { chat_ids: ids.value, add, remove } };
};

export type SendItem = { chat_id: string; sender_id: string; n: number; N: number | null };

export const parse_send_body = (b: unknown): Parsed<{ run: string; sends: SendItem[]; concurrency: number }> => {
  const o = obj(b);
  if (typeof o?.run !== "string" || !RUN_RE.test(o.run)) return bad("run must be 6 lowercase base36 chars");
  const sends = o.sends;
  if (!Array.isArray(sends) || sends.length === 0) return bad("sends must be a non-empty array");
  if (sends.length > CAPS.sends_per_batch) return bad(`sends: at most ${CAPS.sends_per_batch} per batch`, "cap_exceeded");
  const out: SendItem[] = [];
  for (const s of sends) {
    const x = obj(s);
    const n = int_in(x?.n, 1, Number.MAX_SAFE_INTEGER);
    const N = x?.N === undefined || x?.N === null ? null : int_in(x.N, 1, Number.MAX_SAFE_INTEGER);
    if (!x || !is_uuid(x.chat_id) || !is_uuid(x.sender_id) || n === null) {
      return bad("every send needs chat_id, sender_id (uuid) and n >= 1");
    }
    if (N === null && x.N !== undefined && x.N !== null) return bad("N must be a positive integer");
    out.push({ chat_id: x.chat_id.toLowerCase(), sender_id: x.sender_id.toLowerCase(), n, N });
  }
  let concurrency: number = CAPS.default_concurrency;
  if (o.concurrency !== undefined && o.concurrency !== null) {
    const c = int_in(o.concurrency, 1, CAPS.max_concurrency);
    if (c === null) return bad(`concurrency must be an integer 1..${CAPS.max_concurrency}`);
    concurrency = c;
  }
  return { ok: true, value: { run: o.run, sends: out, concurrency } };
};

export const parse_receipts_body = (b: unknown): Parsed<{ chat_ids: string[]; status: "delivered" | "read" }> => {
  const o = obj(b);
  const ids = uuid_list(o?.chat_ids, CAPS.chats_per_call, "chat_ids");
  if (!ids.ok) return ids;
  if (o?.status !== "delivered" && o?.status !== "read") return bad('status must be "delivered" or "read"');
  return { ok: true, value: { chat_ids: ids.value, status: o.status } };
};

export const parse_verify_body = (b: unknown): Parsed<{ run: string; chat_ids: string[] }> => {
  const o = obj(b);
  if (typeof o?.run !== "string" || !RUN_RE.test(o.run)) return bad("run must be 6 lowercase base36 chars");
  const ids = uuid_list(o.chat_ids, CAPS.chats_per_call, "chat_ids");
  if (!ids.ok) return ids;
  return { ok: true, value: { run: o.run, chat_ids: ids.value } };
};

export const parse_cleanup_body = (b: unknown): Parsed<{ scope: "me_out" | "purge_queues" }> => {
  const s = obj(b)?.scope;
  if (s !== "me_out" && s !== "purge_queues") return bad('scope must be "me_out" or "purge_queues"');
  return { ok: true, value: { scope: s } };
};

/**
 * Who may be named in a request: the caller, or a test user. Returns the
 * offending ids (empty = allowed). `test_ids` = the ids that resolved to a
 * test-phone user.
 */
export const not_allowed_ids = (ids: Iterable<string>, caller_id: string, test_ids: ReadonlySet<string>): string[] => {
  const bad_ids: string[] = [];
  for (const id of new Set(ids)) if (id !== caller_id && !test_ids.has(id)) bad_ids.push(id);
  return bad_ids;
};

/** LOAD_TEST_ENABLED, read at request time ("true" / "1" / "on" / "yes"). */
export const load_test_enabled = (env: Record<string, string | undefined> = process.env): boolean =>
  ["1", "true", "on", "yes"].includes(String(env.LOAD_TEST_ENABLED ?? "").trim().toLowerCase());
