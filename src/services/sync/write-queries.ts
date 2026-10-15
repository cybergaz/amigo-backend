// =============================================================================
// Sync v2 write-path SQL (SYNC_V2_PROTOCOL.md §3.3, §3.7, §3.10, §3.12).
// =============================================================================
// Every statement the R1a write path adds, as pure functions over a
// postgres-js client (pg_client, a transaction, or a script's connection).
// No side effects and no app imports, so the PGlite harness runs these exact
// statements against the real triggers.
//
// Round trips: each function is ONE statement (one round trip) unless noted.
// =============================================================================
import type postgres from "postgres";

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const is_uuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const n_or_null = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

// The app's pg_client is shared with drizzle, and drizzle's postgres-js
// driver patches it: json/jsonb serializers become pass-through (so a
// postgres-js json helper would send a raw object and fail) and timestamp
// parsers return the server's text ("2026-10-14 18:46:26.518+00") instead of
// a Date. Every statement here therefore (a) sends JSON as text with an
// explicit ::jsonb cast, and (b) normalises timestamps with to_date — the same
// parse drizzle itself applies — so results are identical whichever client
// runs them (the app's patched one, a script's or the harness's plain one).
// The cast is ::text::jsonb, not ::jsonb: with a bare ::jsonb the server
// types the parameter jsonb, and a PLAIN client then JSON-encodes the
// already-encoded string a second time (a jsonb string scalar, not the
// object); typed text, neither client touches it.
const json_param = (v: unknown): string => JSON.stringify(v);
export const to_date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v));

const TS_FIELDS = ["sent_at", "expires_at", "created_at", "deleted_at"] as const;
const norm_row = <T extends Record<string, unknown>>(r: T): T => {
  const out: Record<string, unknown> = { ...r };
  for (const f of TS_FIELDS) if (f in out) out[f] = to_date(out[f]);
  return out as T;
};

// ── Receipts: apply_receipts (§3.7) ─────────────────────────────────────────

/**
 * One chat's receipt input. Positions may be given as seqs (v2 intents, R1b)
 * or as message ids (every legacy input, mapped to seq(id) in the statement).
 * `join` = the legacy conversation:join / mark_read rule: when the frame's
 * last_read_msg_id is the chat's current last_msg_id, read = seq_head, which
 * also covers trailing pin/delete clock values (§3.7 legacy table).
 */
export type ReceiptInput = {
  chat_id: string;
  read_seq?: number | null;
  delivered_seq?: number | null;
  read_ids?: string[];
  delivered_ids?: string[];
  join?: boolean;
};

export type ReceiptStatus = "applied" | "noop" | "rejected" | "retry";

export type ReceiptOutcome = {
  chat_id: string;
  status: ReceiptStatus;
  chat_type: string | null;
  seq_head: number | null;
  // Resolved positions before clamping (null = nothing resolvable).
  r: number | null;
  d: number | null;
  prev_read: number | null;
  read_seq: number | null;
  prev_deliv: number | null;
  delivered_seq: number | null;
  // Second-lowest values over the chat's counted members (null = no mins row
  // yet). §3.7: a group's mins can only move when prev ≤ min2.
  r_min2: number | null;
  d_min2: number | null;
};

/**
 * apply_receipts(auth_user, items) as ONE statement (§3.7):
 *   read_seq      = GREATEST(read_seq, LEAST(r, seq_head))
 *   delivered_seq = GREATEST(delivered_seq, LEAST(GREATEST(d, r), seq_head))
 * for the user's ACTIVE membership (a hidden DM row — removed_at set, status
 * active — is still updated, so hiding never freezes the peer's ticks).
 *
 * Classification per chat:
 *   retry    — chat not numbered yet (seq_head NULL) → 425 for intents
 *   rejected — the user is not an active member → 403, terminal
 *   noop     — nothing resolvable (unknown ids) or no advance
 *   applied  — at least one watermark moved
 *
 * A non-advancing receipt writes nothing (the WHERE skips it), so replayed
 * legacy acks cost a read, never a dead tuple on chat_members.
 *
 * `user_id` MUST be the authenticated id. Ids must be valid uuids (filter
 * with is_uuid first: one bad id would fail the whole statement).
 */
export async function apply_receipts_sql(
  sql: Sql,
  user_id: string,
  items: ReceiptInput[],
): Promise<ReceiptOutcome[]> {
  if (items.length === 0) return [];
  const input = items.map((i) => ({
    chat_id: i.chat_id,
    r_ids: i.read_ids?.length ? i.read_ids : null,
    d_ids: i.delivered_ids?.length ? i.delivered_ids : null,
    r_seq: i.read_seq ?? null,
    d_seq: i.delivered_seq ?? null,
    j: i.join === true,
  }));
  const rows = await sql<Record<string, unknown>[]>`
    WITH v AS (
      SELECT * FROM jsonb_to_recordset(${json_param(input)}::text::jsonb)
        AS v(chat_id uuid, r_ids uuid[], d_ids uuid[], r_seq bigint, d_seq bigint, j boolean)
    ),
    x AS (
      SELECT v.chat_id, c.type, c.seq_head,
        (SELECT max(s) FROM (VALUES
            (v.r_seq),
            (CASE WHEN v.j AND c.last_msg_id = ANY(v.r_ids) THEN c.seq_head END),
            ((SELECT max(m.seq) FROM messages m WHERE m.id = ANY(v.r_ids) AND m.chat_id = v.chat_id))
          ) t(s)) AS r,
        (SELECT max(s) FROM (VALUES
            (v.d_seq),
            ((SELECT max(m.seq) FROM messages m WHERE m.id = ANY(v.d_ids) AND m.chat_id = v.chat_id))
          ) t(s)) AS d
      FROM v LEFT JOIN chats c ON c.id = v.chat_id
    ),
    mem AS (
      SELECT cm.id, cm.chat_id, cm.read_seq, cm.delivered_seq
        FROM chat_members cm JOIN x ON x.chat_id = cm.chat_id
       WHERE cm.user_id = ${user_id}::uuid AND cm.status = 'active'
         AND x.seq_head IS NOT NULL AND (x.r IS NOT NULL OR x.d IS NOT NULL)
       ORDER BY cm.chat_id            -- rows locked in chat order: two applies
         FOR UPDATE OF cm             -- for one user can never deadlock
    ),
    upd AS (
      UPDATE chat_members cm SET
        read_seq      = GREATEST(cm.read_seq, LEAST(COALESCE(x.r, 0), x.seq_head)),
        delivered_seq = GREATEST(cm.delivered_seq,
                                 LEAST(GREATEST(COALESCE(x.d, 0), COALESCE(x.r, 0)), x.seq_head))
        FROM mem o JOIN x ON x.chat_id = o.chat_id
       WHERE cm.id = o.id
         AND (LEAST(COALESCE(x.r, 0), x.seq_head) > cm.read_seq
              OR LEAST(GREATEST(COALESCE(x.d, 0), COALESCE(x.r, 0)), x.seq_head) > cm.delivered_seq)
      RETURNING cm.chat_id, o.read_seq AS prev_read, cm.read_seq,
                o.delivered_seq AS prev_deliv, cm.delivered_seq
    )
    SELECT x.chat_id, x.type, x.seq_head::text AS seq_head, x.r::text AS r, x.d::text AS d,
           u.prev_read::text AS prev_read, u.read_seq::text AS read_seq,
           u.prev_deliv::text AS prev_deliv, u.delivered_seq::text AS delivered_seq,
           (u.chat_id IS NOT NULL) AS advanced,
           EXISTS (SELECT 1 FROM chat_members m2
                    WHERE m2.chat_id = x.chat_id AND m2.user_id = ${user_id}::uuid
                      AND m2.status = 'active') AS member,
           mins.r_min2::text AS r_min2, mins.d_min2::text AS d_min2
      FROM x
      LEFT JOIN upd u ON u.chat_id = x.chat_id
      LEFT JOIN chat_receipt_mins mins ON mins.chat_id = x.chat_id`;

  // A user with two active rows in one chat (malformed legacy data) returns
  // two lines; keep one per chat, preferring the advanced one.
  const by_chat = new Map<string, ReceiptOutcome>();
  for (const row of rows) {
    const chat_id = String(row.chat_id);
    const seq_head = n_or_null(row.seq_head);
    const r = n_or_null(row.r);
    const d = n_or_null(row.d);
    const advanced = row.advanced === true;
    const status: ReceiptStatus =
      seq_head === null ? (row.type == null ? "rejected" : "retry")
        : row.member !== true ? "rejected"
          : advanced ? "applied" : "noop";
    const out: ReceiptOutcome = {
      chat_id,
      status,
      chat_type: row.type == null ? null : String(row.type),
      seq_head,
      r,
      d,
      prev_read: n_or_null(row.prev_read),
      read_seq: n_or_null(row.read_seq),
      prev_deliv: n_or_null(row.prev_deliv),
      delivered_seq: n_or_null(row.delivered_seq),
      r_min2: n_or_null(row.r_min2),
      d_min2: n_or_null(row.d_min2),
    };
    const prev = by_chat.get(chat_id);
    if (!prev || (out.status === "applied" && prev.status !== "applied")) by_chat.set(chat_id, out);
  }
  return Array.from(by_chat.values());
}

/**
 * Whether a group's receipt mins may have moved after an advance (§3.7):
 * only when the member was at or below the second-lowest value. No mins row
 * yet (null) → refresh.
 */
export const mins_may_move = (o: ReceiptOutcome): boolean => {
  if (o.status !== "applied") return false;
  const read_moved = o.prev_read !== null && o.read_seq !== null && o.read_seq > o.prev_read;
  const deliv_moved = o.prev_deliv !== null && o.delivered_seq !== null && o.delivered_seq > o.prev_deliv;
  return (
    (read_moved && (o.r_min2 === null || (o.prev_read as number) <= o.r_min2)) ||
    (deliv_moved && (o.d_min2 === null || (o.prev_deliv as number) <= o.d_min2))
  );
};

export type MinsRow = {
  chat_id: string;
  seq_head: number | null;
  r_min1: number;
  r_min1_user: string | null;
  r_min2: number | null;
  d_min1: number;
  d_min1_user: string | null;
  d_min2: number | null;
};

/** chat_receipt_mins rows (+ the chat's seq_head) for `chat_ids`, one statement. */
export async function read_mins_sql(sql: Sql, chat_ids: string[]): Promise<Map<string, MinsRow>> {
  const out = new Map<string, MinsRow>();
  if (chat_ids.length === 0) return out;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT x.chat_id, c.seq_head::text AS seq_head,
           x.r_min1::text AS r_min1, x.r_min1_user, x.r_min2::text AS r_min2,
           x.d_min1::text AS d_min1, x.d_min1_user, x.d_min2::text AS d_min2
      FROM chat_receipt_mins x JOIN chats c ON c.id = x.chat_id
     WHERE x.chat_id = ANY(${sql.array(chat_ids)}::uuid[])`;
  for (const r of rows) {
    const chat_id = String(r.chat_id).toLowerCase();
    out.set(chat_id, {
      chat_id,
      seq_head: n_or_null(r.seq_head),
      r_min1: Number(r.r_min1 ?? 0),
      r_min1_user: (r.r_min1_user as string | null) ?? null,
      r_min2: n_or_null(r.r_min2),
      d_min1: Number(r.d_min1 ?? 0),
      d_min1_user: (r.d_min1_user as string | null) ?? null,
      d_min2: n_or_null(r.d_min2),
    });
  }
  return out;
}

/**
 * The per-viewer "others" a member sees from one mins row (§3.2):
 *   others_read_seq(me) = me = r_min1_user ? COALESCE(r_min2, seq_head) : r_min1
 * (the same rule as read-queries others_expr / seq-queries others_watermarks).
 */
export const others_from_mins = (m: MinsRow, user_id: string): { r: number; d: number } => {
  const me = user_id.toLowerCase();
  return {
    r: m.r_min1_user?.toLowerCase() === me ? (m.r_min2 ?? m.seq_head ?? 0) : m.r_min1,
    d: m.d_min1_user?.toLowerCase() === me ? (m.d_min2 ?? m.seq_head ?? 0) : m.d_min1,
  };
};

/**
 * Did any member's "others" value rise between two mins rows of one chat?
 * `all` = min1 rose (every member but the min1 user sees it); `min1_users` =
 * the min1 users whose own value (min2) rose. Mins are monotone, so a rise
 * is the only change that needs an emit (§3.7 chat:wm).
 */
export const mins_rise = (
  before: MinsRow | undefined,
  after: MinsRow,
): { all: boolean; users: string[] } => {
  if (!before) return { all: true, users: [] };
  const all = after.r_min1 > before.r_min1 || after.d_min1 > before.d_min1
    || after.r_min1_user !== before.r_min1_user || after.d_min1_user !== before.d_min1_user;
  const users = new Set<string>();
  if (!all) {
    if ((after.r_min2 ?? after.seq_head ?? 0) > (before.r_min2 ?? before.seq_head ?? 0) && after.r_min1_user) users.add(after.r_min1_user);
    if ((after.d_min2 ?? after.seq_head ?? 0) > (before.d_min2 ?? before.seq_head ?? 0) && after.d_min1_user) users.add(after.d_min1_user);
  }
  return { all, users: Array.from(users) };
};

/**
 * Refresh + regression check for the mins runner (3 statements, run inside
 * its singleton transaction, never on a request path). Counted watermarks
 * only rise and removals only raise a multiset's minimum (§3.2 "Monotonicity
 * of the mins"), so an r_min1 / d_min1 that goes DOWN means a writer broke
 * the rules: reported as [RCPT] min_regress with the chat ids. The before /
 * after rows are returned for the chat:wm emit (§3.7).
 */
export async function refresh_mins_checked(
  sql: Sql,
  chat_ids: string[],
): Promise<{ refreshed: number; regressed: string[]; before: Map<string, MinsRow>; after: Map<string, MinsRow> }> {
  const ids = Array.from(new Set(chat_ids.filter(is_uuid).map((c) => c.toLowerCase())));
  if (ids.length === 0) return { refreshed: 0, regressed: [], before: new Map(), after: new Map() };
  const before = await read_mins_sql(sql, ids);
  const refreshed = await refresh_mins_sql(sql, ids);
  const after = await read_mins_sql(sql, ids);
  const regressed: string[] = [];
  for (const a of after.values()) {
    const b = before.get(a.chat_id);
    if (b && (a.r_min1 < b.r_min1 || a.d_min1 < b.d_min1)) regressed.push(a.chat_id);
  }
  return { refreshed, regressed, before, after };
}

/**
 * Chats the mins reconcile sweep re-queues (§3.7 step 1: a sweep every 10 min
 * over chats with last_msg_at > now() - 1 day, covering a lost dirty set or a
 * crash): active within `window_s`, not broadcast lists, numbered, and either
 * there is no mins row yet or the row is STALE.
 *
 * Stale, not "behind the last message": a sender's read_seq never covers
 * their own last message, so `r_min1 < last_seq` held for nearly every active
 * chat and the sweep re-queued (and rewrote) the same 2000 newest chats every
 * time, while older chats with a lost dirty set were never reached. Watermarks
 * only rise and membership changes refresh the mins inline (triggers), so a
 * row can only be stale-LOW: the holder of min1 has since moved above it (or
 * is no longer counted). One probe of that member's row per chat: the
 * (chat_id, user_id) unremoved unique index (a hidden DM row, still counted,
 * is a second probe on DMs only). Read-only.
 */
export async function select_reconcile_chats(sql: Sql, window_s: number, limit: number): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT c.id
      FROM chats c
      LEFT JOIN chat_receipt_mins x ON x.chat_id = c.id
     WHERE c.deleted_at IS NULL
       AND c.last_msg_at > now() - make_interval(secs => ${window_s})
       AND c.type <> 'broadcast'
       AND c.seq_head IS NOT NULL AND c.last_seq IS NOT NULL
       AND (x.chat_id IS NULL
            OR (x.r_min1 < c.last_seq AND x.r_min1_user IS NOT NULL AND NOT (
                  EXISTS (SELECT 1 FROM chat_members cm
                           WHERE cm.chat_id = c.id AND cm.user_id = x.r_min1_user AND cm.removed_at IS NULL
                             AND cm.status = 'active' AND GREATEST(cm.read_seq, cm.joined_seq) <= x.r_min1)
                  OR (c.type = 'dm' AND EXISTS (SELECT 1 FROM chat_members cm
                           WHERE cm.chat_id = c.id AND cm.user_id = x.r_min1_user AND cm.removed_at IS NOT NULL
                             AND cm.status = 'active' AND GREATEST(cm.read_seq, cm.joined_seq) <= x.r_min1))))
            OR (x.d_min1 < c.last_seq AND x.d_min1_user IS NOT NULL AND NOT (
                  EXISTS (SELECT 1 FROM chat_members cm
                           WHERE cm.chat_id = c.id AND cm.user_id = x.d_min1_user AND cm.removed_at IS NULL
                             AND cm.status = 'active' AND GREATEST(cm.delivered_seq, cm.read_seq, cm.joined_seq) <= x.d_min1)
                  OR (c.type = 'dm' AND EXISTS (SELECT 1 FROM chat_members cm
                           WHERE cm.chat_id = c.id AND cm.user_id = x.d_min1_user AND cm.removed_at IS NOT NULL
                             AND cm.status = 'active' AND GREATEST(cm.delivered_seq, cm.read_seq, cm.joined_seq) <= x.d_min1)))))
     ORDER BY c.last_msg_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => String(r.id));
}

/** Refresh chat_receipt_mins for several chats, in chat-id order (ordered advisory locks). */
export async function refresh_mins_sql(sql: Sql, chat_ids: string[]): Promise<number> {
  const ids = Array.from(new Set(chat_ids.filter(is_uuid).map((c) => c.toLowerCase()))).sort();
  if (ids.length === 0) return 0;
  await sql`
    SELECT amigo_refresh_min_wm(s.c)
      FROM (SELECT c FROM unnest(${sql.array(ids)}::uuid[]) AS c ORDER BY c) s`;
  return ids.length;
}

// ── Receipt windows: the §3.7 legacy effects, from apply_receipts' prev/new ─

export type ReceiptWindow = {
  chat_id: string;
  rp: number; rn: number;   // read:      (rp, rn]
  dp: number; dn: number;   // delivered: (dp, dn]
};

export type ReceiptWindowRow = { id: string; seq: number; sender_id: string | null; broadcast_msg_id: string | null };

export type ReceiptWindowResult = {
  marked: number;                                  // message_info rows written (read window)
  senders: Map<string, string[]>;                  // chat → distinct other senders in the read window
  last_read: Map<string, string>;                  // chat → id with the max seq <= rn (visible, not system)
  delivered: Map<string, ReceiptWindowRow[]>;      // chat → newest ≤ cap rows of the delivered window, by seq
};

/** Rows of a delivered window the effects look at (status:ack, pending drain). */
export const RECEIPT_WINDOW_CAP = 200;
/**
 * Rows of a READ window that get message_info read rows and name the
 * conversation:join senders (the newest ones). Legacy mark_read_upto had no
 * bound; a reader jumping further than this leaves the oldest rows without a
 * legacy read row (Read-by of very old messages only — the watermark itself
 * is exact).
 */
export const RECEIPT_READ_WINDOW_CAP = 5_000;

/**
 * Everything the legacy effects of an apply need, for every advanced chat of
 * one user, in ONE statement (§3.7 step 2, fire-and-forget after commit):
 *   - mark_read_upto over the SEQ window (rp, rn] (newest
 *     RECEIPT_READ_WINDOW_CAP rows): message_info read_at / delivered_at for
 *     others' rows — the legacy Read-by / ticks storage;
 *   - the distinct other senders in that window (conversation:join targets)
 *     and last_read_msg_id = the visible non-system row with the max
 *     seq <= rn (what an old app looks up locally);
 *   - the newest RECEIPT_WINDOW_CAP rows of the delivered window (dp, dn]
 *     with their sender and broadcast-copy parent (status:ack delivered, the
 *     reader's pending message:new drain, the senders' sent:ack drain).
 * A replayed / non-advancing receipt has empty windows and never gets here,
 * which is what stops an outbox replay hours later from re-reading anything.
 * Index use: uniq_messages_chat_seq ranges; message_info PK for the upsert;
 * idx_bmc_message_id per delivered row.
 */
export async function receipt_windows_sql(
  sql: Sql,
  user_id: string,
  wins: ReceiptWindow[],
  at: Date,
): Promise<ReceiptWindowResult> {
  const out: ReceiptWindowResult = { marked: 0, senders: new Map(), last_read: new Map(), delivered: new Map() };
  const w = wins.filter((x) => is_uuid(x.chat_id) && (x.rn > x.rp || x.dn > x.dp));
  if (w.length === 0) return out;
  const [r] = await sql<Record<string, unknown>[]>`
    WITH w AS (
      SELECT * FROM jsonb_to_recordset(${json_param(w)}::text::jsonb)
        AS w(chat_id uuid, rp bigint, rn bigint, dp bigint, dn bigint)
    ),
    -- LATERAL + LIMIT: an index range per chat. A plain join lets the
    -- planner (which cannot estimate the recordset) hash-join a seq scan of
    -- messages against it (seen on the harness).
    rw AS MATERIALIZED (
      SELECT r.id, r.chat_id, r.sender_id
        FROM w CROSS JOIN LATERAL (
          SELECT m.id, m.chat_id, m.sender_id FROM messages m
           WHERE m.chat_id = w.chat_id AND m.seq IS NOT NULL AND m.seq > w.rp AND m.seq <= w.rn
             AND m.deleted_at IS NULL
             AND (m.sender_id IS NULL OR m.sender_id <> ${user_id}::uuid)
           ORDER BY m.seq DESC LIMIT ${RECEIPT_READ_WINDOW_CAP}) r
       WHERE w.rn > w.rp
    ),
    mr AS (
      INSERT INTO message_info (message_id, user_id, chat_id, delivered_at, read_at)
      SELECT rw.id, ${user_id}::uuid, rw.chat_id, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz
        FROM rw
      ON CONFLICT (message_id, user_id) DO UPDATE
        SET read_at      = GREATEST(message_info.read_at, EXCLUDED.read_at),
            delivered_at = COALESCE(message_info.delivered_at, EXCLUDED.delivered_at)
      RETURNING 1
    ),
    rs AS (
      SELECT rw.chat_id, array_agg(DISTINCT rw.sender_id::text) AS senders
        FROM rw WHERE rw.sender_id IS NOT NULL GROUP BY rw.chat_id
    ),
    lr AS (
      SELECT w.chat_id, l.id
        FROM w CROSS JOIN LATERAL (
          SELECT l.id FROM messages l
           WHERE l.chat_id = w.chat_id AND l.seq IS NOT NULL AND l.seq <= w.rn
             AND l.deleted_at IS NULL AND l.type <> 'system'
           ORDER BY l.seq DESC LIMIT 1) l
       WHERE w.rn > w.rp
    ),
    dw AS (
      SELECT w.chat_id, d.id, d.seq, d.sender_id, d.broadcast_msg_id
        FROM w CROSS JOIN LATERAL (
          SELECT m.id, m.seq, m.sender_id,
                 (SELECT b.broadcast_msg_id FROM broadcast_message_copies b WHERE b.message_id = m.id LIMIT 1) AS broadcast_msg_id
            FROM messages m
           WHERE m.chat_id = w.chat_id AND m.seq IS NOT NULL AND m.seq > w.dp AND m.seq <= w.dn
             AND m.deleted_at IS NULL
           ORDER BY m.seq DESC LIMIT ${RECEIPT_WINDOW_CAP}) d
       WHERE w.dn > w.dp
    )
    SELECT (SELECT count(*) FROM mr)::int AS marked,
           (SELECT json_agg(json_build_object('chat_id', rs.chat_id, 'senders', rs.senders)) FROM rs) AS senders,
           (SELECT json_agg(json_build_object('chat_id', lr.chat_id, 'id', lr.id)) FROM lr) AS last_read,
           (SELECT json_agg(json_build_object('chat_id', dw.chat_id, 'id', dw.id, 'seq', dw.seq,
                                              'sender_id', dw.sender_id, 'broadcast_msg_id', dw.broadcast_msg_id)
                            ORDER BY dw.chat_id, dw.seq) FROM dw) AS delivered`;
  out.marked = Number(r?.marked ?? 0);
  for (const x of (r?.senders as { chat_id: string; senders: string[] }[] | null) ?? []) {
    out.senders.set(String(x.chat_id).toLowerCase(), (x.senders ?? []).filter(Boolean));
  }
  for (const x of (r?.last_read as { chat_id: string; id: string }[] | null) ?? []) {
    if (x.id) out.last_read.set(String(x.chat_id).toLowerCase(), String(x.id));
  }
  for (const x of (r?.delivered as (ReceiptWindowRow & { chat_id: string })[] | null) ?? []) {
    const chat = String(x.chat_id).toLowerCase();
    const list = out.delivered.get(chat) ?? [];
    list.push({ id: String(x.id), seq: Number(x.seq), sender_id: x.sender_id ?? null, broadcast_msg_id: x.broadcast_msg_id ?? null });
    out.delivered.set(chat, list);
  }
  return out;
}

// ── Bulk soft delete, one chat per statement (§3.3.1) ───────────────────────

export type BulkDeleteRow = {
  id: string;
  chat_id: string;
  sender_id: string | null;
  type: string;
  body: string | null;
  attachments: unknown;
  replied_to: string | null;
  sent_at: Date | null;
  expires_at: Date | null;
  created_at: Date | null;
  deleted_at: Date | null;
};

export type BulkDeleteResult = {
  rows: BulkDeleteRow[];
  // Top of the allocated block (null = chat not numbered, or no clock yet).
  top: number | null;
  // Values allocated but not used (rows already deleted by someone else).
  burned: number;
};

/**
 * Soft-delete `ids` of ONE chat in one statement:
 *
 *   SET LOCAL amigo.bulk_alloc = 'on';          (set_config(.., true))
 *   top = amigo_alloc_settled(chat, n, NULL);    one clock block, one chats UPDATE
 *   UPDATE messages SET deleted_at = now(), mod_seq = top - n + rn …
 *   RETURNING …                                  RETURNING decides who broadcasts
 *
 * WHY one chat per statement: the allocation holds that chat's row lock until
 * commit. A multi-chat UPDATE would take the chats' locks in row order while
 * inserts take them one at a time — a deadlock recipe — and hold every one of
 * them for the whole statement. As an autocommit statement it is also its own
 * short transaction, so the lock lives for one round trip.
 *
 * amigo.bulk_alloc stays set until the END OF THE TRANSACTION: inside an
 * explicit transaction this must be the last statement that deletes messages.
 *
 * `use_clock` = false (the clock functions are not installed yet): the plain
 * legacy UPDATE, no allocation; once the triggers exist the row trigger would
 * allocate per row anyway, so a stale false is still correct.
 *
 * Filters: `expired_only` (the sweeper re-checks expiry under the row lock),
 * `sender_id` (broadcast copies: only the sender's own rows unless elevated).
 * Returned columns are exactly the pre-sync-v2 message columns, so HTTP
 * responses that echo them stay byte-identical for old clients.
 */
export async function bulk_soft_delete_chat(
  sql: Sql,
  chat_id: string,
  ids: string[],
  opts: { use_clock: boolean; expired_only?: boolean; sender_id?: string | null } = { use_clock: false },
): Promise<BulkDeleteResult> {
  const uniq = Array.from(new Set(ids.filter(is_uuid)));
  if (uniq.length === 0) return { rows: [], top: null, burned: 0 };
  const n = uniq.length;
  const expired = opts.expired_only === true;
  const sender = opts.sender_id ?? null;
  const cols = sql`m.id, m.chat_id, m.sender_id, m.type, m.body, m.attachments, m.replied_to,
                   m.sent_at, m.expires_at, m.created_at, m.deleted_at`;

  if (!opts.use_clock) {
    const rows = await sql<BulkDeleteRow[]>`
      UPDATE messages m SET deleted_at = now()
       WHERE m.id = ANY(${sql.array(uniq)}::uuid[]) AND m.chat_id = ${chat_id}::uuid
         AND m.deleted_at IS NULL
         AND (${!expired}::boolean OR (m.expires_at IS NOT NULL AND m.expires_at <= now()))
         AND (${sender}::uuid IS NULL OR m.sender_id = ${sender}::uuid)
      RETURNING ${cols}`;
    return { rows: rows.map(norm_row), top: null, burned: 0 };
  }

  // `a` is MATERIALIZED and joined into the UPDATE, so it runs exactly once
  // and before the first row is updated: the GUC is set before any
  // messages_bu_del fires, and the block is allocated before any mod_seq is
  // assigned. Values of rows that turn out already deleted are burned —
  // harmless, coverage is attested by through_seq (§2.1).
  const rows = await sql<(BulkDeleteRow & { top: string | null })[]>`
    WITH a AS MATERIALIZED (
      SELECT set_config('amigo.bulk_alloc', 'on', true) AS g,
             amigo_alloc_settled(${chat_id}::uuid, ${n}::int, NULL::uuid) AS top
    )
    UPDATE messages m
       SET deleted_at = now(),
           mod_seq = CASE WHEN a.top IS NULL THEN m.mod_seq ELSE a.top - ${n}::int + x.rn END
      FROM a, unnest(${sql.array(uniq)}::uuid[]) WITH ORDINALITY AS x(id, rn)
     WHERE m.id = x.id AND m.chat_id = ${chat_id}::uuid AND m.deleted_at IS NULL
       AND (${!expired}::boolean OR (m.expires_at IS NOT NULL AND m.expires_at <= now()))
       AND (${sender}::uuid IS NULL OR m.sender_id = ${sender}::uuid)
    RETURNING ${cols}, a.top::text AS top`;
  const top = rows.length ? n_or_null(rows[0]!.top) : null;
  const out = rows.map(({ top: _t, ...r }) => norm_row(r as BulkDeleteRow));
  return { rows: out, top, burned: top === null ? 0 : n - out.length };
}

/** Expired, not yet deleted rows, oldest expiry first (no lock; §3.3.1 sweeper step 2). */
export async function select_expired_candidates(
  sql: Sql,
  limit: number,
): Promise<{ id: string; chat_id: string }[]> {
  const rows = await sql<{ id: string; chat_id: string }[]>`
    SELECT id, chat_id FROM messages
     WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
     ORDER BY expires_at
     LIMIT ${limit}`;
  return [...rows];
}

/** Group (id, chat_id) pairs by chat, chats in id order (§3.3.1 lock order). */
export const group_by_chat_sorted = (rows: { id: string; chat_id: string }[]): [string, string[]][] => {
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.chat_id.toLowerCase();
    const list = by.get(key);
    if (list) list.push(r.id);
    else by.set(key, [r.id]);
  }
  return Array.from(by.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * Admin hard delete → soft delete + scrub (§3.3.3). The row stays as a
 * tombstone (the delete takes a clock value via messages_bu_del, so it
 * travels by delta); body / attachments are wiped. A system row keeps its
 * meta (tombstones of system rows keep meta, §3.9). Scrubbing an
 * already-deleted row wipes its content too, without a new clock value
 * (deleted_at does not change).
 */
export async function scrub_delete_message(sql: Sql, message_id: string): Promise<BulkDeleteRow | null> {
  if (!is_uuid(message_id)) return null;
  const rows = await sql<BulkDeleteRow[]>`
    UPDATE messages m
       SET deleted_at = COALESCE(m.deleted_at, now()),
           body = NULL,
           attachments = NULL,
           meta = CASE WHEN m.type = 'system' THEN m.meta END
     WHERE m.id = ${message_id}::uuid
    RETURNING m.id, m.chat_id, m.sender_id, m.type, m.body, m.attachments, m.replied_to,
              m.sent_at, m.expires_at, m.created_at, m.deleted_at`;
  return rows[0] ? norm_row(rows[0]) : null;
}

// ── Persisted system rows (§3.10) ───────────────────────────────────────────

export type SystemRowMeta = {
  action: string;
  members: string[];
  actor_id: string | null;
  title?: string | null;
  profile_pic?: string | null;
  owner_id?: string | null;
  disappearing_after_sec?: number | null;
};

export type StoredSystemRow = { id: string; seq: number | null; created_at: Date; inserted: boolean };

/**
 * Insert a type='system', sender_id NULL row with `meta` (§3.10). Idempotent
 * on `id` (the conversation:action event_id): a replay returns the stored row
 * with inserted=false. The messages_bi trigger numbers it and moves the
 * last-message pointer; messages_ai_sys bumps settings_seq / roster_seq.
 * One round trip (the duplicate re-select only runs on a replay).
 */
export async function insert_system_row(
  sql: Sql,
  row: { id: string; chat_id: string; body: string; meta: SystemRowMeta },
): Promise<StoredSystemRow | null> {
  const ins = await sql<{ id: string; seq: string | null; created_at: Date }[]>`
    INSERT INTO messages (id, chat_id, sender_id, type, body, sent_at, meta)
    VALUES (${row.id}::uuid, ${row.chat_id}::uuid, NULL, 'system', ${row.body}, now(), ${json_param(row.meta)}::text::jsonb)
    ON CONFLICT (id) DO NOTHING
    RETURNING id, seq::text AS seq, created_at`;
  if (ins[0]) return { id: ins[0].id, seq: n_or_null(ins[0].seq), created_at: to_date(ins[0].created_at)!, inserted: true };
  const old = await sql<{ id: string; seq: string | null; created_at: Date }[]>`
    SELECT id, seq::text AS seq, created_at FROM messages
     WHERE id = ${row.id}::uuid AND chat_id = ${row.chat_id}::uuid AND type = 'system'`;
  return old[0] ? { id: old[0].id, seq: n_or_null(old[0].seq), created_at: to_date(old[0].created_at)!, inserted: false } : null;
}

// ── Delete-for-me flag (§3.6 has_hidden) ────────────────────────────────────

/**
 * Membership check for delete-for-me that also sets has_hidden — in the SAME
 * round trip as the check it replaces. Set BEFORE the message_info tombstones
 * are written, so "a hidden row exists ⇒ has_hidden" holds even if the
 * request dies half-way (has_hidden only enables a probe; a spurious true is
 * harmless, a missing one would over-count unread). Writes the row only the
 * first time. Returns the membership id, or null when not an active member.
 */
export async function check_member_mark_hidden(sql: Sql, chat_id: string, user_id: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    WITH m AS (
      SELECT id, has_hidden FROM chat_members
       WHERE chat_id = ${chat_id}::uuid AND user_id = ${user_id}::uuid
         AND removed_at IS NULL AND status = 'active'
       LIMIT 1
    ),
    u AS (
      UPDATE chat_members cm SET has_hidden = true
        FROM m WHERE cm.id = m.id AND NOT m.has_hidden
      RETURNING cm.id
    )
    SELECT m.id::text AS id FROM m`;
  return rows[0]?.id ?? null;
}

// conversation:action → meta.action of the persisted system row (§3.10, PD-2).
// The trigger messages_ai_sys keys settings_seq / roster_seq off these names.
// Not persisted: join requests (direct-only events) and chat_delete (the chat
// is gone for everyone).
const SYSTEM_ROW_ACTION: Readonly<Record<string, string>> = Object.freeze({
  member_added: "add",
  member_removed: "remove",
  member_left: "leave",
  member_promoted: "role",
  member_demoted: "role",
  owner_changed: "owner",
  "chat_details:update": "chat_details:update",
});

export const system_row_action = (action: string): string | null => SYSTEM_ROW_ACTION[action] ?? null;
