// =============================================================================
// Sync v2 read API SQL (SYNC_V2_PROTOCOL.md §3.9, §3.12, §4.2)
// =============================================================================
// "The tables are the log": messages (by seq ∪ changed mod_seq) plus the
// chats versions ARE the replayable per-chat log. Every function here is ONE
// statement (one RDS round trip) over a postgres-js client (pg_client, a
// transaction, or the PGlite harness's plain client) and imports nothing with
// side effects.
//
// One statement per read matters beyond round trips: READ COMMITTED gives a
// statement one snapshot, and every clock allocation holds the chats row lock
// until commit, so a statement that reads seq_head = H also sees every change
// with mod_seq ≤ H (§3.2 "commit-order property"). That is what lets a page
// attest through_seq = H.
//
// Index use (verified with EXPLAIN on the post-20261021b schema, harness
// readapi.ts). Every per-chat read is an index range inside a LATERAL with a
// LIMIT, so the cost is bounded by the page size, never by the chat's size:
//   seq ranges          uniq_messages_chat_seq (chat_id, seq) WHERE seq IS NOT NULL
//   changed rows        idx_messages_chat_modchg (chat_id, mod_seq) WHERE mod_seq <> seq
//   unread              idx_messages_unread (index-only, capped at 100)
//   the viewer's row    uniq_chat_members_active (chat_id, user_id) WHERE removed_at IS NULL
//   a hidden DM row     idx_chat_members_wm (chat_id) WHERE status = 'active' (DMs only: 2 rows)
//   heads               idx_chatmemeber_user_id_chat_id_unremoved (user_id, chat_id)
//   delete-for-me       message_info PK (message_id, user_id), probed only when has_hidden
//
// JSON: rows are built with json_build_object in the statement (one row back,
// no per-row result-set framing). jsonb/json come back parsed with both the
// app's drizzle-patched client and a plain one; timestamps inside JSON are
// ISO-8601 strings either way, and bigints inside JSON are JSON numbers
// (clock values and µs epochs stay far below 2^53).
// =============================================================================
import type postgres from "postgres";
import {
  MODS_PAGE,
  SHELL_SYSTEM_WINDOW,
  STUB_BODY_CHARS,
  TAIL_GAP,
  type DeltaParams,
} from "./read-core";
import { UNREAD_CAP } from "./seq-queries";

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;
type Frag = postgres.PendingQuery<any>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ── Shared fragments ────────────────────────────────────────────────────────

/**
 * The viewer's membership row for chat `c`, as a LEFT JOIN LATERAL aliased
 * `cm`. One row per (chat, user) wins: the live row (removed_at IS NULL, at
 * most one by uniq_chat_members_active), else — DMs only — the hidden DM row
 * (delete-chat sets removed_at but keeps status 'active'; PD-6: the user still
 * owns that DM and its positions). A removed group row grants nothing.
 */
const member_lateral = (sql: Sql, uid: string): Frag => sql`
  LEFT JOIN LATERAL (
    SELECT * FROM (
      (SELECT m0.* FROM chat_members m0
        WHERE m0.chat_id = c.id AND m0.user_id = ${uid}::uuid AND m0.removed_at IS NULL
        LIMIT 1)
      UNION ALL
      (SELECT m1.* FROM chat_members m1
        WHERE c.type = 'dm' AND m1.chat_id = c.id AND m1.status = 'active'
          AND m1.user_id = ${uid}::uuid AND m1.removed_at IS NOT NULL
        ORDER BY m1.removed_at DESC
        LIMIT 1)
    ) mm LIMIT 1
  ) cm ON true`;

/**
 * Derived unread per §3.6 — the exact expression of seq-queries.ts
 * derived_unread, inlined so heads / chats / intent state / the chat list pay
 * no extra round trip. Needs aliases cm, c. The harness asserts both agree on
 * every chat (v2 floors in readapi.ts, legacy floors in r1b_app.ts).
 *
 * `legacy` adds the created_at floors the legacy history endpoints apply
 * (joined_at / cleared_at), for the chat list's `unreadCount` that old apps
 * render, so they never count rows their history hides. created_at is in
 * idx_messages_unread's INCLUDE list, so the legacy count is index-only too.
 */
const unread_expr = (sql: Sql, opts: { legacy?: boolean } = {}): Frag => {
  // Two copies of the count on purpose: the delete-for-me probe needs m.id,
  // which idx_messages_unread does not carry, so a single expression would
  // turn EVERY chat's count into heap fetches. Split on has_hidden, the
  // common case (no delete-for-me in the chat) stays index-only.
  const legacy_floor = opts.legacy === true
    ? sql`
            AND (cm.joined_at IS NULL OR um.created_at >= cm.joined_at)
            AND (cm.cleared_at IS NULL OR um.created_at > cm.cleared_at)`
    : sql``;
  const base = sql`
            um.chat_id = cm.chat_id
            AND um.seq > GREATEST(cm.read_seq, cm.joined_seq, cm.cleared_seq) AND um.seq <= c.seq_head
            AND um.deleted_at IS NULL AND um.seq IS NOT NULL AND um.type <> 'system'
            AND um.sender_id IS DISTINCT FROM cm.user_id
            AND (um.expires_at IS NULL OR um.expires_at > now())${legacy_floor}`;
  return sql`
  (CASE WHEN cm.status IS DISTINCT FROM 'active' OR cm.removed_at IS NOT NULL OR c.last_seq IS NULL
             OR GREATEST(cm.read_seq, cm.joined_seq, cm.cleared_seq) >= c.last_seq THEN 0
        WHEN NOT cm.has_hidden THEN
          (SELECT count(*) FROM (SELECT 1 FROM messages um WHERE ${base} LIMIT ${UNREAD_CAP}) ux)
        ELSE
          (SELECT count(*) FROM (SELECT 1 FROM messages um WHERE ${base}
             AND NOT EXISTS (SELECT 1 FROM message_info umi
                              WHERE umi.message_id = um.id AND umi.user_id = cm.user_id AND umi.deleted_at IS NOT NULL)
             LIMIT ${UNREAD_CAP}) uy)
   END)::int`;
};

/** Per-viewer "others" (§3.2). NULL for broadcast lists (§3.8) and chats without a mins row. */
const others_expr = (sql: Sql, uid: string, col: "r" | "d"): Frag => col === "r"
  ? sql`(CASE WHEN c.type = 'broadcast' OR x.chat_id IS NULL THEN NULL
              WHEN x.r_min1_user = ${uid}::uuid THEN COALESCE(x.r_min2, c.seq_head, 0) ELSE x.r_min1 END)`
  : sql`(CASE WHEN c.type = 'broadcast' OR x.chat_id IS NULL THEN NULL
              WHEN x.d_min1_user = ${uid}::uuid THEN COALESCE(x.d_min2, c.seq_head, 0) ELSE x.d_min1 END)`;

/** Columns every row-producing branch selects (alias m). */
// chat_id: row_joins scopes the replied-to probe to the row's own chat.
const row_cols = (sql: Sql): Frag => sql`
  m.id, m.chat_id, m.seq, m.mod_seq, m.sender_id, m.type, m.body, m.attachments, m.replied_to,
  m.sent_at, m.created_at, m.expires_at, m.deleted_at, m.meta`;

/**
 * Visibility of a message row `m` for the viewer row `v` (§3.9):
 *   - above the floor: seq > GREATEST(joined_seq, cleared_seq);
 *   - active: up to head;
 *   - shell (left / pending): up to left_seq, plus system rows that name the
 *     viewer in meta.members ("X removed you") within SHELL_SYSTEM_WINDOW
 *     clock values above it (v.hi carries that bound).
 * Rows below the floor are skipped but still covered by the attestation.
 */
const visible = (sql: Sql, uid: string, s: Frag = sql`m.seq`): Frag => sql`
  ${s} > v.fl AND ${s} <= v.hi
  AND (v.full_access OR ${s} <= v.lseq
       OR (m.type = 'system' AND m.meta -> 'members' ? ${uid}::text))`;

/**
 * Row JSON (§4.2 Row). Aliases: r (the message), u (sender), rp (replied-to
 * message, with its sender_name) — see row_joins; `hid` = deleted-for-me, `now` = the statement's
 * now(). Content (body, attachments, reply) is nulled for tombstones,
 * hidden-for-me rows and rows past expires_at that the sweeper has not
 * deleted yet; a system row keeps its meta even as a tombstone. A reply to an
 * admin-scrubbed message previews as null (sync/scrubbed.ts), a reply to a
 * deleted or expired one keeps its id/sender but no content.
 */
const row_json = (sql: Sql, hid: Frag, now: Frag): Frag => sql`
  json_build_object(
    'id', r.id, 'seq', r.seq, 'mod_seq', r.mod_seq,
    'sender_id', r.sender_id, 'sender_name', u.name, 'type', r.type,
    'body', CASE WHEN r.deleted_at IS NULL AND NOT ${hid} AND (r.expires_at IS NULL OR r.expires_at > ${now}) THEN r.body END,
    'attachments', CASE WHEN r.deleted_at IS NULL AND NOT ${hid} AND (r.expires_at IS NULL OR r.expires_at > ${now}) THEN r.attachments END,
    'replied_to', CASE WHEN r.deleted_at IS NULL AND NOT ${hid} THEN r.replied_to END,
    'replied_to_message', CASE
       WHEN rp.id IS NULL OR r.deleted_at IS NOT NULL OR ${hid}
         OR (rp.deleted_at IS NOT NULL AND rp.body IS NULL AND rp.attachments IS NULL) THEN NULL
       ELSE json_build_object(
         'id', rp.id, 'seq', rp.seq, 'sender_id', rp.sender_id, 'sender_name', rp.sender_name, 'type', rp.type,
         'body', CASE WHEN rp.deleted_at IS NULL AND (rp.expires_at IS NULL OR rp.expires_at > ${now}) THEN rp.body END,
         'attachments', CASE WHEN rp.deleted_at IS NULL AND (rp.expires_at IS NULL OR rp.expires_at > ${now}) THEN rp.attachments END,
         'sent_at', rp.sent_at, 'deleted_at', rp.deleted_at) END,
    'sent_at', r.sent_at, 'srv_ts', r.created_at, 'expires_at', r.expires_at, 'deleted_at', r.deleted_at,
    'hidden', ${hid},
    'meta', CASE WHEN NOT ${hid} AND (r.type = 'system'
                 OR (r.deleted_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > ${now}))) THEN r.meta END)`;

/**
 * The joins row_json needs, after `FROM <rows> r`. LATERAL primary-key
 * probes on purpose: a plain join lets the planner hash the whole users or
 * messages table against a page of 50 rows (seen on the harness), while a
 * lateral reference forces one index probe per row of the page. The LIMIT 1
 * keeps the planner from flattening the lateral back into a plain join.
 * The replied-to row must be in the reply's own chat: a reference stored
 * before message:new checked replied_to may name another chat's message.
 */
const row_joins = (sql: Sql): Frag => sql`
  LEFT JOIN LATERAL (SELECT su.name FROM users su WHERE su.id = r.sender_id LIMIT 1) u ON true
  LEFT JOIN LATERAL (
    SELECT q.id, q.seq, q.sender_id, q.type, q.body, q.attachments, q.sent_at, q.deleted_at, q.expires_at,
           (SELECT qu.name FROM users qu WHERE qu.id = q.sender_id) AS sender_name
      FROM messages q WHERE q.id = r.replied_to AND q.chat_id = r.chat_id LIMIT 1
  ) rp ON true`;

// ── Types ───────────────────────────────────────────────────────────────────

export type Row = {
  id: string;
  seq: number;
  mod_seq: number;
  sender_id: string | null;
  sender_name: string | null;
  type: string;
  body: string | null;
  attachments: unknown;
  replied_to: string | null;
  replied_to_message: unknown;
  sent_at: string | null;
  srv_ts: string | null;
  expires_at: string | null;
  deleted_at: string | null;
  hidden: boolean;
  meta: unknown;
};

export type ModRow = { id: string; seq: number; mod_seq: number; deleted_at: string | null; hidden: boolean };

export type PinJson = { pinned_msg_id: string | null; pin_seq: number; pinned_message: Row | null };

export type SettingsJson = {
  settings_seq: number;
  title: string | null;
  profile_pic: string | null;
  owner_id: string | null;
  disappearing_after_sec: number | null;
};

export type DeltaRaw = {
  found: boolean;            // the chat exists (and is not deleted)
  access: "full" | "shell" | "none";
  chat_type: string | null;
  mode: "delta" | "tail" | "backward" | "mods";
  status: string | null;
  hidden_chat: boolean;
  seq_head: number | null;
  last_seq: number | null;
  read_seq: number | null;
  delivered_seq: number | null;
  joined_seq: number | null;
  cleared_seq: number | null;
  left_seq: number | null;
  floor_seq: number;
  roster_seq: number | null;
  rows: Row[];               // up to limit+1 (the caller cuts; read-core finalize_page)
  mods: ModRow[];            // up to MODS_PAGE+1
  mods_below: number | null; // the through_lo the mods were computed against
  pin: PinJson | null;
  settings: SettingsJson | null;
  server_time: string;
  resp_ver: number;
};

// ── Delta / tail / backward / mods: ONE statement (§3.9) ────────────────────

/**
 * GET /chat/sync/:chat_id. Rows for all three modes come from mutually
 * exclusive LATERAL branches gated on v.mode (one-time filters), each an
 * index range with LIMIT L+1:
 *
 *   delta     (unchanged rows, seq ∈ (S, H], mod_seq = seq; by seq)
 *             ∪ (changed rows, mod_seq ∈ (S, H], mod_seq <> seq; by mod_seq)
 *             merged by mod_seq. Splitting on mod_seq = seq keeps each branch
 *             sorted by the merge key, so "first L+1 of each, then first L+1
 *             of the union" is exact (a branch keyed on seq alone would be
 *             crowded out by old rows deleted late and skip rows in between).
 *   tail      newest L+1 visible rows by seq (tombstones included); with a
 *             `since`, also the ids of rows below the tail that changed after
 *             it (mods), so a tail reset loses no delete/expiry.
 *   backward  L+1 visible rows below `before`, by seq DESC.
 *   mods      the next page of those ids (since = previous mods_through,
 *             before = the tail's through_lo).
 *
 * `auto` resolves to tail when since is NULL or H − since > TAIL_GAP.
 */
export async function delta_sql(sql: Sql, uid: string, chat_id: string, p: DeltaParams): Promise<DeltaRaw> {
  const L1 = p.limit + 1;
  const M1 = MODS_PAGE + 1;
  const since = p.since;
  const now = sql`v.now_ts`;
  const [res] = await sql<Record<string, unknown>[]>`
    WITH v AS MATERIALIZED (
      SELECT c.id, c.type, c.seq_head AS h, c.last_seq, c.pin_seq, c.pinned_msg_id,
             c.settings_seq, c.roster_seq, c.title, c.profile_pic, c.owner_id, c.disappearing_after_sec,
             cm.status, (cm.removed_at IS NOT NULL) AS hidden_chat,
             cm.read_seq, cm.delivered_seq, cm.joined_seq, cm.cleared_seq, cm.left_seq,
             COALESCE(cm.has_hidden, false) AS has_hidden,
             COALESCE(GREATEST(cm.joined_seq, cm.cleared_seq), 0) AS fl,
             COALESCE(cm.status = 'active', false) AS full_access,
             COALESCE(cm.status IN ('left', 'pending'), false) AS shell,
             CASE WHEN cm.status = 'active' THEN c.seq_head
                  WHEN cm.status IN ('left', 'pending')
                    THEN LEAST(c.seq_head, COALESCE(cm.left_seq, 0) + ${SHELL_SYSTEM_WINDOW}::bigint) END AS hi,
             COALESCE(cm.left_seq, 0) AS lseq,
             CASE WHEN ${p.mode}::text <> 'auto' THEN ${p.mode}::text
                  WHEN ${since}::bigint IS NULL OR c.seq_head - ${since}::bigint > ${TAIL_GAP}::bigint THEN 'tail'
                  ELSE 'delta' END AS mode,
             now() AS now_ts,
             to_json(clock_timestamp()) AS server_time,
             (extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS resp_ver
        FROM chats c
        ${member_lateral(sql, uid)}
       WHERE c.id = ${chat_id}::uuid AND c.deleted_at IS NULL
    ),
    dl AS (
      SELECT x.* FROM v CROSS JOIN LATERAL (
        SELECT * FROM (
          (SELECT ${row_cols(sql)} FROM messages m
            WHERE v.mode = 'delta' AND m.chat_id = ${chat_id}::uuid
              AND m.seq > GREATEST(COALESCE(${since}::bigint, 0), v.fl) AND m.seq <= v.hi
              AND m.mod_seq = m.seq AND ${visible(sql, uid)}
            ORDER BY m.seq LIMIT ${L1}::int)
          UNION ALL
          (SELECT ${row_cols(sql)} FROM messages m
            WHERE v.mode = 'delta' AND m.chat_id = ${chat_id}::uuid
              AND m.mod_seq > COALESCE(${since}::bigint, 0) AND m.mod_seq <= v.h AND m.mod_seq <> m.seq
              AND ${visible(sql, uid)}
            ORDER BY m.mod_seq LIMIT ${L1}::int)
        ) un ORDER BY un.mod_seq LIMIT ${L1}::int
      ) x
    ),
    tl AS (
      SELECT x.* FROM v CROSS JOIN LATERAL (
        SELECT ${row_cols(sql)} FROM messages m
         WHERE v.mode = 'tail' AND m.chat_id = ${chat_id}::uuid AND ${visible(sql, uid)}
         ORDER BY m.seq DESC LIMIT ${L1}::int
      ) x
    ),
    bw AS (
      SELECT x.* FROM v CROSS JOIN LATERAL (
        SELECT ${row_cols(sql)} FROM messages m
         WHERE v.mode = 'backward' AND m.chat_id = ${chat_id}::uuid
           AND m.seq < ${p.before}::bigint AND ${visible(sql, uid)}
         ORDER BY m.seq DESC LIMIT ${L1}::int
      ) x
    ),
    lo AS (
      SELECT CASE
               WHEN v.mode = 'tail' AND ${since}::bigint IS NOT NULL
                    AND (SELECT count(*) FROM tl) > ${p.limit}::int
                 THEN (SELECT min(t.seq) FROM (SELECT tl.seq FROM tl ORDER BY tl.seq DESC LIMIT ${p.limit}::int) t)
               WHEN v.mode = 'mods' THEN ${p.before}::bigint
             END AS below
        FROM v
    ),
    md AS (
      SELECT x.* FROM v CROSS JOIN lo CROSS JOIN LATERAL (
        SELECT m.id, m.seq, m.mod_seq, m.deleted_at,
               (v.has_hidden AND EXISTS (
                  SELECT 1 FROM message_info mi
                   WHERE mi.message_id = m.id AND mi.user_id = ${uid}::uuid AND mi.deleted_at IS NOT NULL)) AS hidden
          FROM messages m
         WHERE lo.below IS NOT NULL AND m.chat_id = ${chat_id}::uuid
           AND m.mod_seq > ${since}::bigint AND m.mod_seq <= v.h AND m.mod_seq <> m.seq
           -- "+ 0": keep the planner on idx_messages_chat_modchg (ordered by
           -- mod_seq, stops at the LIMIT). Given a usable seq bound it may pick
           -- the seq index and sort every old row instead.
           AND m.seq + 0 < lo.below AND ${visible(sql, uid, sql`(m.seq + 0)`)}
         ORDER BY m.mod_seq LIMIT ${M1}::int
      ) x
    ),
    pg AS (SELECT * FROM dl UNION ALL SELECT * FROM tl UNION ALL SELECT * FROM bw),
    rj AS (
      SELECT json_agg(${row_json(sql, sql`hh.hid`, now)}
                      ORDER BY CASE WHEN v.mode = 'delta' THEN r.mod_seq ELSE -r.seq END) AS rows
        FROM v CROSS JOIN pg r
        CROSS JOIN LATERAL (
          SELECT (v.has_hidden AND EXISTS (
                    SELECT 1 FROM message_info mi
                     WHERE mi.message_id = r.id AND mi.user_id = ${uid}::uuid AND mi.deleted_at IS NOT NULL)) AS hid
        ) hh
        ${row_joins(sql)}
    ),
    pj AS (
      -- PD-3: the current pin is visible to every active member, whatever
      -- their join / clear floors. Only on head-anchored pages.
      SELECT json_build_object(
               'pinned_msg_id', v.pinned_msg_id, 'pin_seq', v.pin_seq,
               'pinned_message', (SELECT ${row_json(sql, sql`false`, now)}
                                    FROM messages r ${row_joins(sql)}
                                   WHERE r.id = v.pinned_msg_id AND r.deleted_at IS NULL)) AS pin
        FROM v
       WHERE v.full_access AND v.mode IN ('delta', 'tail') AND v.pin_seq > COALESCE(${since}::bigint, -1)
    )
    SELECT (SELECT count(*) FROM v) > 0 AS found,
           v.type AS chat_type, v.mode, v.status, v.hidden_chat, v.full_access, v.shell,
           v.h::text AS seq_head, v.last_seq::text AS last_seq,
           v.read_seq::text AS read_seq, v.delivered_seq::text AS delivered_seq,
           v.joined_seq::text AS joined_seq, v.cleared_seq::text AS cleared_seq, v.left_seq::text AS left_seq,
           v.fl::text AS floor_seq, v.roster_seq::text AS roster_seq,
           CASE WHEN v.mode IN ('delta', 'tail') AND v.settings_seq > COALESCE(${since}::bigint, -1)
                THEN json_build_object('settings_seq', v.settings_seq, 'title', v.title, 'profile_pic', v.profile_pic,
                                       'owner_id', v.owner_id, 'disappearing_after_sec', v.disappearing_after_sec)
           END AS settings,
           (SELECT rows FROM rj) AS rows,
           (SELECT json_agg(json_build_object('id', md.id, 'seq', md.seq, 'mod_seq', md.mod_seq,
                                              'deleted_at', md.deleted_at, 'hidden', md.hidden)
                            ORDER BY md.mod_seq) FROM md) AS mods,
           (SELECT below FROM lo)::text AS mods_below,
           (SELECT pin FROM pj) AS pin,
           v.server_time, v.resp_ver::text AS resp_ver
      FROM (SELECT 1) one LEFT JOIN v ON true`;

  const r = res ?? {};
  const access = r.full_access === true ? "full" : r.shell === true ? "shell" : "none";
  return {
    found: r.found === true,
    access,
    chat_type: (r.chat_type as string | null) ?? null,
    mode: ((r.mode as string) ?? "tail") as DeltaRaw["mode"],
    status: (r.status as string | null) ?? null,
    hidden_chat: r.hidden_chat === true,
    seq_head: num(r.seq_head),
    last_seq: num(r.last_seq),
    read_seq: num(r.read_seq),
    delivered_seq: num(r.delivered_seq),
    joined_seq: num(r.joined_seq),
    cleared_seq: num(r.cleared_seq),
    left_seq: num(r.left_seq),
    floor_seq: num(r.floor_seq) ?? 0,
    roster_seq: num(r.roster_seq),
    rows: (r.rows as Row[] | null) ?? [],
    mods: (r.mods as ModRow[] | null) ?? [],
    mods_below: num(r.mods_below),
    pin: (r.pin as PinJson | null) ?? null,
    settings: (r.settings as SettingsJson | null) ?? null,
    server_time: String(r.server_time ?? new Date().toISOString()),
    resp_ver: Number(r.resp_ver ?? Date.now() * 1000),
  };
}

// ── Heads (§4.2) ────────────────────────────────────────────────────────────

export type HeadRow = {
  chat_id: string;
  type: string;
  status: string;
  seq_head: number | null;
  last_seq: number | null;
  last_msg_id: string | null;
  read_seq: number;
  delivered_seq: number;
  joined_seq: number;
  cleared_seq: number;
  left_seq: number | null;
  unread: number;
  pin_seq: number;
  pinned_msg_id: string | null;
  settings_seq: number;
  roster_seq: number;
  others_read_seq: number | null;
  others_delivered_seq: number | null;
  activity_at: number | null;   // chats.last_msg_at as epoch ms (compare with stubs_after)
  muted_until: string | null;
  last_message?: {
    id: string; seq: number; mod_seq: number; sender_id: string | null; sender_name: string | null;
    type: string; body: string | null; srv_ts: string; expires_at: string | null; hidden: boolean;
  } | null;
};

export type HeadsRaw = { chats: HeadRow[]; server_time: string; resp_ver: number };

/**
 * Absolute per-chat state for one user (live memberships: removed_at IS
 * NULL, the same set get-chat-list serves; deleted chats excluded). ONE
 * statement, index range on (user_id, chat_id); unread is index-only and O(1)
 * for fully read chats; stubs are primary-key lookups, only for chats whose
 * activity_at > stubs_after.
 *
 * Shells (left / pending) are frozen: no last message / pin / others, unread
 * 0, and seq_head is still the truth (the client stops fills on status).
 *
 * `chat_ids` restricts to those chats (partial heads for poll v2, R3).
 */
export async function heads_sql(
  sql: Sql, uid: string, opts: { stubs_after: number | null; chat_ids?: string[] | null },
): Promise<HeadsRaw> {
  const ids = opts.chat_ids ?? null;
  const [res] = await sql<{ chats: HeadRow[] | null; server_time: string; resp_ver: string }[]>`
    WITH h AS (${head_rows(sql, uid, opts.stubs_after, sql`
         AND (${ids === null}::boolean OR cm.chat_id = ANY(${sql.array(ids ?? [])}::uuid[]))`)}
    )
    SELECT (SELECT json_agg(h ORDER BY h.activity_at DESC NULLS LAST, h.chat_id) FROM h) AS chats,
           to_json(clock_timestamp()) AS server_time,
           (extract(epoch FROM clock_timestamp()) * 1000000)::bigint::text AS resp_ver`;
  return {
    chats: res?.chats ?? [],
    server_time: String(res?.server_time ?? new Date().toISOString()),
    resp_ver: Number(res?.resp_ver ?? Date.now() * 1000),
  };
}

/**
 * The HeadRow SELECT (one row per live membership of `uid`, plus `filter`,
 * an extra `AND …` on cm / c). Shared by GET /chat/sync/heads and poll v2's
 * full / partial heads (poll-queries.ts), so both serve byte-identical rows.
 */
const head_rows = (sql: Sql, uid: string, stubs_after: number | null, filter: Frag): Frag => sql`
      SELECT cm.chat_id, c.type, cm.status, c.seq_head,
             CASE WHEN cm.status = 'active' THEN c.last_seq END AS last_seq,
             CASE WHEN cm.status = 'active' THEN c.last_msg_id END AS last_msg_id,
             cm.read_seq, cm.delivered_seq, cm.joined_seq, cm.cleared_seq, cm.left_seq,
             ${unread_expr(sql)} AS unread,
             c.pin_seq,
             CASE WHEN cm.status = 'active' THEN c.pinned_msg_id END AS pinned_msg_id,
             c.settings_seq, c.roster_seq,
             CASE WHEN cm.status = 'active' THEN ${others_expr(sql, uid, "r")} END AS others_read_seq,
             CASE WHEN cm.status = 'active' THEN ${others_expr(sql, uid, "d")} END AS others_delivered_seq,
             (extract(epoch FROM c.last_msg_at) * 1000)::bigint AS activity_at,
             cm.muted_until,
             st.stub AS last_message
        FROM chat_members cm
        JOIN chats c ON c.id = cm.chat_id
        LEFT JOIN chat_receipt_mins x ON x.chat_id = cm.chat_id
        LEFT JOIN LATERAL (
          SELECT json_build_object(
                   'id', lm.id, 'seq', lm.seq, 'mod_seq', lm.mod_seq, 'sender_id', lm.sender_id,
                   'sender_name', lu.name, 'type', lm.type,
                   'body', CASE WHEN NOT hz.hid AND (lm.expires_at IS NULL OR lm.expires_at > now())
                                THEN left(lm.body, ${STUB_BODY_CHARS}::int) END,
                   'srv_ts', lm.created_at, 'expires_at', lm.expires_at, 'hidden', hz.hid) AS stub
            FROM messages lm
            LEFT JOIN users lu ON lu.id = lm.sender_id
            CROSS JOIN LATERAL (
              SELECT (cm.has_hidden AND EXISTS (
                        SELECT 1 FROM message_info hmi
                         WHERE hmi.message_id = lm.id AND hmi.user_id = cm.user_id AND hmi.deleted_at IS NOT NULL)) AS hid
            ) hz
           WHERE ${stubs_after}::bigint IS NOT NULL AND cm.status = 'active'
             AND c.last_msg_at > to_timestamp(${stubs_after}::bigint / 1000.0)
             AND c.last_seq > GREATEST(cm.joined_seq, cm.cleared_seq)
             AND lm.id = c.last_msg_id AND lm.deleted_at IS NULL
        ) st ON true
       WHERE cm.user_id = ${uid}::uuid AND cm.removed_at IS NULL AND c.deleted_at IS NULL${filter}`;

/**
 * One chat's line of the heads etag (read-core heads_etag), in SQL. Needs
 * aliases cm, c, x as in head_rows. MUST stay byte-identical to the JS
 * line: poll v2 (poll-queries.ts) computes the etag in the statement and the
 * client compares it with the one GET /chat/sync/heads gave it (the PGlite
 * harness pollv2.ts asserts equality on every membership shape). Every
 * column is NOT NULL except the COALESCEd ones (concat_ws skips NULLs).
 */
const etag_line = (sql: Sql, uid: string): Frag => sql`
  (CASE WHEN cm.status = 'active'
        THEN concat_ws(',', cm.chat_id, 'a', COALESCE(c.seq_head::text, 'n'), cm.read_seq, cm.delivered_seq,
                       cm.joined_seq, cm.cleared_seq, c.pin_seq, c.settings_seq, c.roster_seq,
                       COALESCE((${others_expr(sql, uid, "r")})::text, 'n'),
                       COALESCE((${others_expr(sql, uid, "d")})::text, 'n'))
        ELSE concat_ws(',', cm.chat_id, cm.status, COALESCE(cm.left_seq::text, 'n'), cm.joined_seq, cm.cleared_seq)
   END)`;

// Fragments poll v2's batched statement (poll-queries.ts) shares with the
// single-chat ones here, so a poll row and a delta row are built by the same
// SQL text.
export { member_lateral, unread_expr, others_expr, row_cols, visible, row_json, row_joins, head_rows, etag_line };
export type { Sql as ReadSql, Frag as ReadFrag };

// ── Resolve (§4.2) ──────────────────────────────────────────────────────────

export type ResolveFound = {
  id: string; chat_id: string; seq: number; mod_seq: number;
  deleted_at: string | null; srv_ts: string; expires_at: string | null; hidden: boolean;
};

/**
 * Global id lookup, membership-checked: an id is `found` only when the
 * caller may see that row (the same visibility as the delta). Everything
 * else — unknown ids, other people's chats, rows below the caller's floor —
 * is reported missing, so resolve never leaks existence. One statement: a PK
 * probe per id plus the viewer's membership row per hit.
 */
export async function resolve_sql(sql: Sql, uid: string, ids: string[]): Promise<ResolveFound[]> {
  if (ids.length === 0) return [];
  const [res] = await sql<{ found: ResolveFound[] | null }[]>`
    SELECT json_agg(json_build_object(
             'id', m.id, 'chat_id', m.chat_id, 'seq', m.seq, 'mod_seq', m.mod_seq,
             'deleted_at', m.deleted_at, 'srv_ts', m.created_at, 'expires_at', m.expires_at,
             'hidden', (cm.has_hidden AND EXISTS (
                SELECT 1 FROM message_info mi
                 WHERE mi.message_id = m.id AND mi.user_id = ${uid}::uuid AND mi.deleted_at IS NOT NULL)))
           ORDER BY m.chat_id, m.seq) AS found
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      ${member_lateral(sql, uid)}
     WHERE m.id = ANY(${sql.array(ids)}::uuid[]) AND m.seq IS NOT NULL
       AND c.seq_head IS NOT NULL AND c.deleted_at IS NULL
       AND m.seq > GREATEST(cm.joined_seq, cm.cleared_seq)
       AND (cm.status = 'active'
            OR (cm.status IN ('left', 'pending')
                AND (m.seq <= COALESCE(cm.left_seq, 0)
                     OR (m.type = 'system' AND m.seq <= COALESCE(cm.left_seq, 0) + ${SHELL_SYSTEM_WINDOW}::bigint
                         AND m.meta -> 'members' ? ${uid}::text))))`;
  return res?.found ?? [];
}

// ── Chats (§4.2: chat-list-shaped rows for chats unknown locally) ───────────

export type ChatsRaw = { chats: Record<string, unknown>[]; members: Record<string, unknown>[] };

/**
 * Chat-list-shaped rows (the camelCase keys of GET /chat/get-chat-list, so
 * the client parses them with the same model) for `ids`, plus the Sync v2
 * fields of §4.1, with v2 semantics: the last message is the row at
 * chats.last_msg_id when it is above the viewer's seq floor, unread is the
 * seq-floor count, the pinned message follows PD-3 (any active member, any
 * floor). Shells get no last / pinned message, unread 0 (as the chat list).
 * Group members (active, with their watermarks) come from a second statement
 * run in parallel by the caller. Ids the caller is not a member of are
 * dropped.
 */
export async function chats_sql(sql: Sql, uid: string, ids: string[]): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const [res] = await sql<{ chats: Record<string, unknown>[] | null }[]>`
    WITH q AS (
      SELECT c.id AS "conversationId", c.type, c.title, c."profile_pic" AS "profilePic",
             CASE WHEN cm.status = 'active' AND c.last_seq > GREATEST(cm.joined_seq, cm.cleared_seq)
                  THEN c.last_msg_id END AS "lastMsgId",
             c.last_msg_at AS "lastMsgAt", c.creater_id AS "createrId", c.owner_id AS "ownerId",
             CASE WHEN cm.status = 'active' THEN c.pinned_msg_id END AS "pinnedMsgId",
             c.disappearing_after_sec AS "disappearingAfterSec",
             cm.role, cm.status, cm.joined_at AS "joinedAt", cm.removed_at AS "deletedAt",
             cm.muted_until AS "mutedUntil", cm.cleared_at AS "clearedAt",
             peer.id AS "userId", peer.name AS "userName", peer.phone AS "userPhone",
             peer.profile_pic AS "userProfilePic", peer.last_seen AS "lastSeen",
             lm.msg AS "lastMessage",
             pm.msg AS "pinnedMessage",
             ${unread_expr(sql)} AS "unreadCount",
             CASE WHEN c.type = 'broadcast'
                  THEN (SELECT count(*)::int FROM broadcast_recipients br WHERE br.list_id = c.id) END AS "recipientCount",
             2 AS "syncProto",
             c.seq_head AS "seqHead", c.last_seq AS "lastSeq",
             cm.read_seq AS "readSeq", cm.delivered_seq AS "deliveredSeq",
             cm.joined_seq AS "joinedSeq", cm.cleared_seq AS "clearedSeq", cm.left_seq AS "leftSeq",
             c.pin_seq AS "pinSeq", c.settings_seq AS "settingsSeq", c.roster_seq AS "rosterSeq",
             CASE WHEN cm.status = 'active' THEN ${others_expr(sql, uid, "r")} END AS "othersReadSeq",
             CASE WHEN cm.status = 'active' THEN ${others_expr(sql, uid, "d")} END AS "othersDeliveredSeq"
        FROM unnest(${sql.array(ids)}::uuid[]) AS qi(id)
        JOIN chats c ON c.id = qi.id AND c.deleted_at IS NULL
        ${member_lateral(sql, uid)}
        LEFT JOIN chat_receipt_mins x ON x.chat_id = c.id
        LEFT JOIN LATERAL (
          SELECT pu.id, pu.name, pu.phone, pu.profile_pic, pu.last_seen
            FROM chat_members pcm JOIN users pu ON pu.id = pcm.user_id
           WHERE c.type = 'dm' AND pcm.chat_id = c.id AND pcm.removed_at IS NULL
             AND pcm.user_id <> ${uid}::uuid
           LIMIT 1
        ) peer ON true
        LEFT JOIN LATERAL (
          SELECT json_build_object(
                   'id', l.id, 'seq', l.seq, 'mod_seq', l.mod_seq, 'body', COALESCE(l.body, ''), 'type', l.type,
                   'sender_id', COALESCE(l.sender_id::text, ''), 'sent_at', COALESCE(l.sent_at, l.created_at),
                   'srv_ts', l.created_at, 'attachments', l.attachments, 'expires_at', l.expires_at) AS msg
            FROM messages l
           WHERE cm.status = 'active' AND l.id = c.last_msg_id
             AND c.last_seq > GREATEST(cm.joined_seq, cm.cleared_seq)
             AND l.deleted_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
        ) lm ON true
        LEFT JOIN LATERAL (
          SELECT json_build_object(
                   'id', p.id, 'conversation_id', p.chat_id, 'seq', p.seq, 'mod_seq', p.mod_seq,
                   'sender_id', p.sender_id, 'type', p.type, 'body', p.body, 'attachments', p.attachments,
                   'replied_to', p.replied_to, 'sent_at', p.sent_at, 'created_at', p.created_at,
                   'deleted_at', p.deleted_at, 'sender_name', pu2.name, 'sender_profile_pic', pu2.profile_pic) AS msg
            FROM messages p LEFT JOIN users pu2 ON pu2.id = p.sender_id
           WHERE cm.status = 'active' AND p.id = c.pinned_msg_id AND p.deleted_at IS NULL
        ) pm ON true
       WHERE cm.status IS NOT NULL
    )
    SELECT json_agg(q ORDER BY q."lastMsgAt" DESC NULLS LAST) AS chats FROM q`;
  return res?.chats ?? [];
}

/** Active members (with watermarks) of the GROUP chats in `ids` the caller is an active member of. */
export async function chat_members_sql(sql: Sql, uid: string, ids: string[]): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const rows = await sql<Record<string, unknown>[]>`
    SELECT cm.chat_id, cm.user_id, cm.role, cm.joined_at,
           cm.read_seq::text AS read_seq, cm.delivered_seq::text AS delivered_seq, cm.joined_seq::text AS joined_seq,
           u.name, u.phone, u.profile_pic, u.role AS user_role
      FROM chat_members cm
      JOIN chats c ON c.id = cm.chat_id
      JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = ANY(${sql.array(ids)}::uuid[])
       AND c.type IN ('group', 'community_group')
       AND cm.removed_at IS NULL AND cm.status = 'active'
       AND EXISTS (SELECT 1 FROM chat_members me
                    WHERE me.chat_id = cm.chat_id AND me.user_id = ${uid}::uuid
                      AND me.removed_at IS NULL AND me.status = 'active')
     ORDER BY cm.chat_id, cm.joined_at`;
  return rows.map((r) => ({
    ...r,
    read_seq: Number(r.read_seq),
    delivered_seq: Number(r.delivered_seq),
    joined_seq: Number(r.joined_seq),
  }));
}

// ── get-chat-list in sync_v2 'on' (§3.5, §3.6, §4.1) ──────────────────────

export type ChatListState = {
  chat_id: string;
  numbered: boolean;          // seq_head NOT NULL; false → the caller serves the legacy values
  status: string | null;
  // The chat's pointers as THIS statement saw them: the list query runs in
  // parallel and may straddle a send, so the payload takes these to keep
  // lastMessage.id == lastMsgId (and pinnedMessage.id == pinnedMsgId).
  last_msg_id: string | null;
  last_msg_at: Date | null;
  pinned_msg_id: string | null;
  seq_head: number | null;
  last_seq: number | null;
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
  unread: number;             // LEGACY floors (seq + created_at), capped at UNREAD_CAP
  recipient_count: number | null;
  // The row at chats.last_msg_id (null when it is deleted / expired / absent).
  last_message: {
    id: string; seq: number | null; body: string | null; type: string; sender_id: string | null;
    sent_at: Date | null; created_at: Date | null; attachments: unknown;
    // A persisted system row (§3.10) has sender_id NULL; its actor (meta).
    actor_id: string | null;
  } | null;
  // The row at chats.pinned_msg_id (null when deleted / absent), legacy keys + seq / mod_seq.
  pinned_message: {
    id: string; conversation_id: string; sender_id: string | null; type: string; body: string | null;
    attachments: unknown; replied_to: string | null; sent_at: Date | null; created_at: Date | null;
    deleted_at: Date | null; sender_name: string | null; sender_profile_pic: string | null;
    seq: number | null; mod_seq: number | null;
  } | null;
};

const ts = (v: unknown): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v));

/**
 * Everything get-chat-list enriches a membership row with, in sync_v2 'on',
 * for ONE user in ONE statement that runs in parallel with the list query
 * itself (so the whole list costs one round trip of wall time):
 *   - the clock / watermark fields of §4.1 and the per-viewer others_*;
 *   - unreadCount, DERIVED with the legacy floors (§3.6) instead of Redis;
 *   - the last message by primary key on chats.last_msg_id — PG is the truth
 *     (§3.5), so lastMessage.id == lastMsgId by construction and there is no
 *     Redis read and no read-through fallback statement;
 *   - the pinned message by primary key (+ seq), broadcast recipient counts.
 *
 * Same membership filter as the list query (user, removed_at NULL — or NOT
 * NULL for type=deleted_dm — chat not deleted, the type filter). Columns, not JSON,
 * so timestamps become Dates exactly like drizzle's (the payload keeps the
 * legacy JSON formatting byte-for-byte).
 *
 * Index use: (user_id, chat_id) membership range; chats / messages / users
 * by primary key; unread index-only on idx_messages_unread, O(1) for read
 * chats; mins by primary key.
 */
export async function chat_list_state_sql(
  sql: Sql, uid: string, opts: { deleted_dm: boolean; only_type: string | null },
): Promise<Map<string, ChatListState>> {
  // only_type null = every type but broadcast lists (get-chat-list type=all).
  const type_filter = opts.only_type === null
    ? sql`c.type <> 'broadcast'`
    : sql`c.type = ${opts.only_type}`;
  // Chosen here, not a CASE on a parameter: the statement is prepared, and a
  // CASE on $n cannot match the partial (user_id, chat_id) WHERE removed_at
  // IS NULL index in a generic plan (seq scan of chat_members). Two texts →
  // two stable plans.
  const membership = opts.deleted_dm
    ? sql`cm.removed_at IS NOT NULL`
    : sql`cm.removed_at IS NULL`;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT cm.chat_id, (c.seq_head IS NOT NULL) AS numbered, cm.status,
           c.last_msg_id, c.last_msg_at, c.pinned_msg_id,
           c.seq_head::text AS seq_head,
           CASE WHEN cm.status = 'active' THEN c.last_seq END::text AS last_seq,
           cm.read_seq::text AS read_seq, cm.delivered_seq::text AS delivered_seq,
           cm.joined_seq::text AS joined_seq, cm.cleared_seq::text AS cleared_seq, cm.left_seq::text AS left_seq,
           c.pin_seq::text AS pin_seq, c.settings_seq::text AS settings_seq, c.roster_seq::text AS roster_seq,
           CASE WHEN cm.status = 'active' THEN ${others_expr(sql, uid, "r")} END::text AS others_r,
           CASE WHEN cm.status = 'active' THEN ${others_expr(sql, uid, "d")} END::text AS others_d,
           ${unread_expr(sql, { legacy: true })} AS unread,
           CASE WHEN c.type = 'broadcast'
                THEN (SELECT count(*)::int FROM broadcast_recipients br WHERE br.list_id = c.id) END AS recipient_count,
           lm.id AS lm_id, lm.seq::text AS lm_seq, lm.body AS lm_body, lm.type AS lm_type, lm.sender_id AS lm_sender_id,
           lm.sent_at AS lm_sent_at, lm.created_at AS lm_created_at, lm.attachments AS lm_attachments,
           lm.actor_id AS lm_actor_id,
           pm.id AS pm_id, pm.chat_id AS pm_chat_id, pm.sender_id AS pm_sender_id, pm.type AS pm_type,
           pm.body AS pm_body, pm.attachments AS pm_attachments, pm.replied_to AS pm_replied_to,
           pm.sent_at AS pm_sent_at, pm.created_at AS pm_created_at, pm.deleted_at AS pm_deleted_at,
           pm.seq::text AS pm_seq, pm.mod_seq::text AS pm_mod_seq,
           pm.sender_name AS pm_sender_name, pm.sender_profile_pic AS pm_sender_profile_pic
      FROM chat_members cm
      JOIN chats c ON c.id = cm.chat_id
      LEFT JOIN chat_receipt_mins x ON x.chat_id = cm.chat_id
      LEFT JOIN LATERAL (
        SELECT l.id, l.seq, l.body, l.type, l.sender_id, l.sent_at, l.created_at, l.attachments,
               CASE WHEN l.type = 'system' THEN l.meta ->> 'actor_id' END AS actor_id
          FROM messages l
         WHERE l.id = c.last_msg_id AND l.deleted_at IS NULL
           AND (l.expires_at IS NULL OR l.expires_at > now())
         LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT p.id, p.chat_id, p.sender_id, p.type, p.body, p.attachments, p.replied_to, p.sent_at,
               p.created_at, p.deleted_at, p.seq, p.mod_seq,
               pu.name AS sender_name, pu.profile_pic AS sender_profile_pic
          FROM messages p LEFT JOIN users pu ON pu.id = p.sender_id
         WHERE p.id = c.pinned_msg_id AND p.deleted_at IS NULL
         LIMIT 1
      ) pm ON true
     WHERE cm.user_id = ${uid}::uuid
       AND ${membership}
       AND c.deleted_at IS NULL
       AND ${type_filter}`;
  const out = new Map<string, ChatListState>();
  for (const r of rows) {
    out.set(String(r.chat_id), {
      chat_id: String(r.chat_id),
      numbered: r.numbered === true,
      status: (r.status as string | null) ?? null,
      last_msg_id: (r.last_msg_id as string | null) ?? null,
      last_msg_at: ts(r.last_msg_at),
      pinned_msg_id: (r.pinned_msg_id as string | null) ?? null,
      seq_head: num(r.seq_head),
      last_seq: num(r.last_seq),
      read_seq: Number(r.read_seq ?? 0),
      delivered_seq: Number(r.delivered_seq ?? 0),
      joined_seq: Number(r.joined_seq ?? 0),
      cleared_seq: Number(r.cleared_seq ?? 0),
      left_seq: num(r.left_seq),
      pin_seq: Number(r.pin_seq ?? 0),
      settings_seq: Number(r.settings_seq ?? 0),
      roster_seq: Number(r.roster_seq ?? 0),
      others_read_seq: num(r.others_r),
      others_delivered_seq: num(r.others_d),
      unread: Number(r.unread ?? 0),
      recipient_count: num(r.recipient_count),
      last_message: r.lm_id == null ? null : {
        id: String(r.lm_id),
        seq: num(r.lm_seq),
        body: (r.lm_body as string | null) ?? null,
        type: String(r.lm_type),
        sender_id: (r.lm_sender_id as string | null) ?? null,
        sent_at: ts(r.lm_sent_at),
        created_at: ts(r.lm_created_at),
        attachments: r.lm_attachments ?? null,
        actor_id: (r.lm_actor_id as string | null) ?? null,
      },
      pinned_message: r.pm_id == null ? null : {
        id: String(r.pm_id),
        conversation_id: String(r.pm_chat_id),
        sender_id: (r.pm_sender_id as string | null) ?? null,
        type: String(r.pm_type),
        body: (r.pm_body as string | null) ?? null,
        attachments: r.pm_attachments ?? null,
        replied_to: (r.pm_replied_to as string | null) ?? null,
        sent_at: ts(r.pm_sent_at),
        created_at: ts(r.pm_created_at),
        deleted_at: ts(r.pm_deleted_at),
        sender_name: (r.pm_sender_name as string | null) ?? null,
        sender_profile_pic: (r.pm_sender_profile_pic as string | null) ?? null,
        seq: num(r.pm_seq),
        mod_seq: num(r.pm_mod_seq),
      },
    });
  }
  return out;
}

// ── message:delete frame state (§3.12 delete-unpin, §4.1 mods) ───────────

export type DeleteFrameState = {
  chat_exists: boolean;
  seq_head: number | null;
  pin_seq: number | null;
  pinned_msg_id: string | null;
  last_msg_id: string | null;
  last_msg_at: Date | null;
  mods: { id: string; mod_seq: number }[];
};

/**
 * After a delete committed: each deleted row's mod_seq (the frame's `mods`)
 * and the chat's pin / pointer state as the delete's triggers left it (the
 * frame's delete-unpin `pin`, and the pointer repair's input — which then
 * skips its own chats read, so 'on' costs no extra round trip). ONE
 * statement: chats by primary key, the rows by primary key.
 */
export async function delete_frame_state_sql(sql: Sql, chat_id: string, ids: string[]): Promise<DeleteFrameState> {
  // The rows are read as one primary-key probe per (distinct) id: a LATERAL
  // with a LIMIT is never flattened (the id is the key, so LIMIT 1 drops
  // nothing), so the planner cannot turn
  // `chat_id = c.id AND id = ANY(…)` into a range over the chat's part of
  // idx_messages_chat_created (id is its last column). It picked that range
  // on some runs of the PGlite harness (20k-row chat), which reads the whole
  // chat per delete; a sweeper batch is ≤ 500 ids per chat.
  const [r] = await sql<Record<string, unknown>[]>`
    SELECT c.seq_head::text AS seq_head, c.pin_seq::text AS pin_seq, c.pinned_msg_id, c.last_msg_id, c.last_msg_at,
           (SELECT json_agg(json_build_object('id', p.id, 'mod_seq', p.mod_seq) ORDER BY p.mod_seq)
              FROM (SELECT DISTINCT u.id FROM unnest(${sql.array(ids)}::uuid[]) AS u(id)) x
              CROSS JOIN LATERAL (
                SELECT m.id, m.mod_seq FROM messages m
                 WHERE m.id = x.id AND m.chat_id = c.id
                   AND m.deleted_at IS NOT NULL AND m.mod_seq IS NOT NULL
                 LIMIT 1) p) AS mods
      FROM chats c WHERE c.id = ${chat_id}::uuid`;
  if (!r) {
    return { chat_exists: false, seq_head: null, pin_seq: null, pinned_msg_id: null, last_msg_id: null, last_msg_at: null, mods: [] };
  }
  const mods = ((r.mods as { id: string; mod_seq: number | string }[] | null) ?? [])
    .map((m) => ({ id: String(m.id), mod_seq: Number(m.mod_seq) }));
  return {
    chat_exists: true,
    seq_head: num(r.seq_head),
    pin_seq: num(r.pin_seq),
    pinned_msg_id: (r.pinned_msg_id as string | null) ?? null,
    last_msg_id: (r.last_msg_id as string | null) ?? null,
    last_msg_at: ts(r.last_msg_at),
    mods,
  };
}

// ── Intent state (receipt / clear results, §4.2) ────────────────────────────

export type ChatState = {
  chat_id: string;
  member: boolean;
  status: string | null;
  seq_head: number | null;
  last_seq: number | null;
  read_seq: number | null;
  delivered_seq: number | null;
  cleared_seq: number | null;
  unread: number;
};

/** Absolute watermark state + derived unread for several chats (one statement). */
export async function chat_state_sql(sql: Sql, uid: string, chat_ids: string[]): Promise<Map<string, ChatState>> {
  const out = new Map<string, ChatState>();
  if (chat_ids.length === 0) return out;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT c.id AS chat_id, cm.status, c.seq_head::text AS seq_head, c.last_seq::text AS last_seq,
           cm.read_seq::text AS read_seq, cm.delivered_seq::text AS delivered_seq,
           cm.cleared_seq::text AS cleared_seq,
           ${unread_expr(sql)} AS unread
      FROM unnest(${sql.array(chat_ids)}::uuid[]) AS qi(id)
      JOIN chats c ON c.id = qi.id
      ${member_lateral(sql, uid)}`;
  for (const r of rows) {
    out.set(String(r.chat_id), {
      chat_id: String(r.chat_id),
      member: r.status != null,
      status: (r.status as string | null) ?? null,
      seq_head: num(r.seq_head),
      last_seq: num(r.last_seq),
      read_seq: num(r.read_seq),
      delivered_seq: num(r.delivered_seq),
      cleared_seq: num(r.cleared_seq),
      unread: Number(r.unread ?? 0),
    });
  }
  return out;
}

// ── Clear with upto_seq (§3.12) ─────────────────────────────────────────────

export type ClearOutcome = {
  chat_exists: boolean;
  numbered: boolean;
  member: boolean;
  chat_type: string | null;
  seq_head: number | null;
  last_seq: number | null;
  applied: boolean;
  prev_cleared_seq: number | null;
  cleared_seq: number | null;
  read_seq: number | null;
  delivered_seq: number | null;
};

/**
 * The `clear {upto_seq}` intent, one statement:
 *   cleared_seq   = GREATEST(cleared_seq, LEAST(upto_seq, seq_head))
 *   read_seq      = GREATEST(read_seq, cleared_seq)        (delivered follows)
 *   cleared_at    = created_at of the newest row at or below cleared_seq (legacy floor, forward only)
 * — the same SET as seq-queries.ts apply_clear, plus the previous value so
 * the result can say applied vs noop. A clear replayed from the outbox hours
 * later never hides or reads anything that arrived after the tap. A clear at
 * or below the current cleared_seq writes nothing. The member row is locked
 * first (FOR UPDATE) so prev is the value this UPDATE replaced.
 * `upto_seq` NULL = seq_head now (the legacy clear).
 */
export async function clear_upto_sql(sql: Sql, uid: string, chat_id: string, upto_seq: number | null): Promise<ClearOutcome> {
  const [r] = await sql<Record<string, unknown>[]>`
    WITH t AS (
      SELECT c.type, c.seq_head AS h, c.last_seq,
             GREATEST(0, LEAST(COALESCE(${upto_seq}::bigint, c.seq_head), c.seq_head)) AS upto
        FROM chats c WHERE c.id = ${chat_id}::uuid
    ),
    o AS (
      SELECT cm.id, cm.cleared_seq, cm.read_seq, cm.delivered_seq
        FROM chat_members cm
       WHERE cm.chat_id = ${chat_id}::uuid AND cm.user_id = ${uid}::uuid AND cm.removed_at IS NULL
       LIMIT 1
         FOR UPDATE
    ),
    upd AS (
      UPDATE chat_members cm SET
          cleared_seq   = GREATEST(cm.cleared_seq, t.upto),
          read_seq      = GREATEST(cm.read_seq, cm.cleared_seq, t.upto),
          delivered_seq = GREATEST(cm.delivered_seq, cm.read_seq, cm.cleared_seq, t.upto),
          cleared_at    = GREATEST(cm.cleared_at, (
                            SELECT m.created_at FROM messages m
                             WHERE m.chat_id = ${chat_id}::uuid AND m.seq IS NOT NULL
                               AND m.seq <= GREATEST(cm.cleared_seq, t.upto)
                             ORDER BY m.seq DESC LIMIT 1))
        FROM t, o
       WHERE cm.id = o.id AND t.h IS NOT NULL AND t.upto > cm.cleared_seq
      RETURNING cm.cleared_seq, cm.read_seq, cm.delivered_seq
    )
    SELECT (t.h IS NOT NULL OR t.type IS NOT NULL) AS chat_exists, t.type AS chat_type,
           t.h::text AS seq_head, t.last_seq::text AS last_seq,
           (o.id IS NOT NULL) AS member, (u.cleared_seq IS NOT NULL) AS applied,
           o.cleared_seq::text AS prev_cleared_seq,
           COALESCE(u.cleared_seq, o.cleared_seq)::text AS cleared_seq,
           COALESCE(u.read_seq, o.read_seq)::text AS read_seq,
           COALESCE(u.delivered_seq, o.delivered_seq)::text AS delivered_seq
      FROM (SELECT 1) one
      LEFT JOIN t ON true LEFT JOIN o ON true LEFT JOIN upd u ON true`;
  return {
    chat_exists: r?.chat_exists === true,
    numbered: r?.seq_head != null,
    member: r?.member === true,
    chat_type: (r?.chat_type as string | null) ?? null,
    seq_head: num(r?.seq_head),
    last_seq: num(r?.last_seq),
    applied: r?.applied === true,
    prev_cleared_seq: num(r?.prev_cleared_seq),
    cleared_seq: num(r?.cleared_seq),
    read_seq: num(r?.read_seq),
    delivered_seq: num(r?.delivered_seq),
  };
}

// ── Pin (§3.12) ─────────────────────────────────────────────────────────────

export type SetPinApplied = {
  pinned_msg_id: string | null;
  prev_pinned_msg_id: string | null;
  pin_seq: number;
  seq_head: number | null;
  message_type: string | null;   // type of the pinned (or unpinned) message, for the legacy frame
  pinned_message: Row | null;
};

/**
 * set_pin's write, ONE statement: active-membership check + the seq-CAS
 * UPDATE (§3.12). The chats_bu_pin trigger allocates pin_seq (= seq_head + 1)
 * on numbered chats when the value actually changes. Returns null when
 * nothing changed — the caller classifies with pin_state_sql (a FRESH
 * snapshot, since this statement's may predate a concurrent pin it waited on).
 * `old` locks the chat row first so prev_pinned_msg_id is the value this
 * UPDATE replaced (an intent unpin carries no target).
 */
export async function set_pin_sql(
  sql: Sql,
  req: { chat_id: string; actor_id: string; message_id: string | null; base_pin_seq: number | null; unpin_target: string | null },
): Promise<SetPinApplied | null> {
  const msg = req.message_id;
  const [r] = await sql<Record<string, unknown>[]>`
    WITH mem AS (
      SELECT 1 FROM chat_members
       WHERE chat_id = ${req.chat_id}::uuid AND user_id = ${req.actor_id}::uuid
         AND removed_at IS NULL AND status = 'active'
       LIMIT 1
    ),
    old AS MATERIALIZED (
      SELECT c.pinned_msg_id AS prev FROM chats c
       WHERE c.id = ${req.chat_id}::uuid AND EXISTS (SELECT 1 FROM mem)
         FOR NO KEY UPDATE
    ),
    upd AS (
      UPDATE chats c SET pinned_msg_id = ${msg}::uuid
        FROM old
       WHERE c.id = ${req.chat_id}::uuid AND c.type <> 'broadcast'
         AND c.pinned_msg_id IS DISTINCT FROM ${msg}::uuid
         AND (${req.base_pin_seq}::bigint IS NULL OR c.pin_seq = ${req.base_pin_seq}::bigint)
         AND (${req.unpin_target}::uuid IS NULL OR c.pinned_msg_id = ${req.unpin_target}::uuid)
         AND (${msg}::uuid IS NULL OR EXISTS (
               SELECT 1 FROM messages m
                WHERE m.id = ${msg}::uuid AND m.chat_id = ${req.chat_id}::uuid AND m.deleted_at IS NULL))
      RETURNING c.pinned_msg_id, c.pin_seq, c.seq_head, old.prev
    )
    SELECT up.pinned_msg_id, up.prev AS prev_pinned_msg_id, up.pin_seq::text AS pin_seq, up.seq_head::text AS seq_head,
           (SELECT t.type FROM messages t WHERE t.id = COALESCE(up.pinned_msg_id, up.prev)) AS message_type,
           (SELECT ${row_json(sql, sql`false`, sql`now()`)}
              FROM messages r ${row_joins(sql)}
             WHERE r.id = up.pinned_msg_id) AS pinned_message
      FROM upd up`;
  if (!r) return null;
  return {
    pinned_msg_id: (r.pinned_msg_id as string | null) ?? null,
    prev_pinned_msg_id: (r.prev_pinned_msg_id as string | null) ?? null,
    pin_seq: Number(r.pin_seq),
    seq_head: num(r.seq_head),
    message_type: (r.message_type as string | null) ?? null,
    pinned_message: (r.pinned_message as Row | null) ?? null,
  };
}

export type PinStateRaw = {
  chat_exists: boolean;
  chat_type: string | null;
  member: boolean;
  pinned_msg_id: string | null;
  pin_seq: number;
  seq_head: number | null;
  pinned_message: Row | null;
  target_in_chat: boolean;
  target_live: boolean;
};

/**
 * The chat's pin state (PD-3: the body ships with the pin, whatever the
 * caller's floors) + the caller's active membership + whether `target`
 * exists in the chat — everything classify_pin_miss and
 * GET /message/pinned/:id need, in one statement.
 */
export async function pin_state_sql(sql: Sql, uid: string, chat_id: string, target: string | null): Promise<PinStateRaw> {
  const [r] = await sql<Record<string, unknown>[]>`
    SELECT (c.id IS NOT NULL) AS chat_exists, c.type AS chat_type,
           EXISTS (SELECT 1 FROM chat_members cm
                    WHERE cm.chat_id = ${chat_id}::uuid AND cm.user_id = ${uid}::uuid
                      AND cm.removed_at IS NULL AND cm.status = 'active') AS member,
           c.pinned_msg_id, c.pin_seq::text AS pin_seq, c.seq_head::text AS seq_head,
           (SELECT ${row_json(sql, sql`false`, sql`now()`)}
              FROM messages r ${row_joins(sql)}
             WHERE r.id = c.pinned_msg_id AND r.deleted_at IS NULL) AS pinned_message,
           EXISTS (SELECT 1 FROM messages t WHERE t.id = ${target}::uuid AND t.chat_id = ${chat_id}::uuid) AS target_in_chat,
           EXISTS (SELECT 1 FROM messages t WHERE t.id = ${target}::uuid AND t.chat_id = ${chat_id}::uuid
                                              AND t.deleted_at IS NULL) AS target_live
      FROM (SELECT 1) one
      LEFT JOIN chats c ON c.id = ${chat_id}::uuid AND c.deleted_at IS NULL`;
  return {
    chat_exists: r?.chat_exists === true,
    chat_type: (r?.chat_type as string | null) ?? null,
    member: r?.member === true,
    pinned_msg_id: (r?.pinned_msg_id as string | null) ?? null,
    pin_seq: Number(r?.pin_seq ?? 0),
    seq_head: num(r?.seq_head),
    pinned_message: (r?.pinned_message as Row | null) ?? null,
    target_in_chat: r?.target_in_chat === true,
    target_live: r?.target_live === true,
  };
}

// ── Delete / react intent state ─────────────────────────────────────────────

export type MsgState = { id: string; seq: number | null; mod_seq: number | null; deleted_at: string | null; sender_id: string | null; hidden: boolean };

/**
 * Current state of `ids` that belong to `chat_id` (ids of other chats are
 * absent), plus whether the caller holds a membership row there — the
 * intents only echo state to callers who may read the chat.
 */
export async function messages_state_sql(
  sql: Sql, uid: string, chat_id: string, ids: string[],
): Promise<{ member: boolean; rows: MsgState[] }> {
  if (ids.length === 0) return { member: false, rows: [] };
  const [res] = await sql<{ rows: MsgState[] | null; member: boolean }[]>`
    SELECT (SELECT json_agg(json_build_object(
              'id', m.id, 'seq', m.seq, 'mod_seq', m.mod_seq, 'deleted_at', m.deleted_at, 'sender_id', m.sender_id,
              'hidden', EXISTS (SELECT 1 FROM message_info mi
                                 WHERE mi.message_id = m.id AND mi.user_id = ${uid}::uuid AND mi.deleted_at IS NOT NULL))
            ORDER BY m.seq)
              FROM messages m
             WHERE m.id = ANY(${sql.array(ids)}::uuid[]) AND m.chat_id = ${chat_id}::uuid) AS rows,
           (c.id IS NOT NULL AND cm.status IS NOT NULL) AS member
      FROM (SELECT 1) one
      LEFT JOIN chats c ON c.id = ${chat_id}::uuid
      ${member_lateral(sql, uid)}`;
  return { member: res?.member === true, rows: res?.rows ?? [] };
}

export type ReactState = {
  member: boolean;   // an ACTIVE member (the only callers react_to_message accepts)
  exists: boolean;
  live: boolean;
  mine: string | null;
  reactions: { user_id: string; reaction: string }[];
};

/** A message's reactions (message_info PK prefix on message_id) and the caller's own. */
export async function react_state_sql(sql: Sql, uid: string, chat_id: string, message_id: string): Promise<ReactState> {
  const [r] = await sql<Record<string, unknown>[]>`
    SELECT EXISTS (SELECT 1 FROM chat_members cm
                    WHERE cm.chat_id = ${chat_id}::uuid AND cm.user_id = ${uid}::uuid
                      AND cm.removed_at IS NULL AND cm.status = 'active') AS member,
           (m.id IS NOT NULL) AS exists, (m.deleted_at IS NULL) AS live,
           (SELECT mi.reaction FROM message_info mi WHERE mi.message_id = m.id AND mi.user_id = ${uid}::uuid) AS mine,
           (SELECT json_agg(json_build_object('user_id', mi.user_id, 'reaction', mi.reaction) ORDER BY mi.user_id)
              FROM message_info mi WHERE mi.message_id = m.id AND mi.reaction IS NOT NULL) AS reactions
      FROM (SELECT 1) one
      LEFT JOIN messages m ON m.id = ${message_id}::uuid AND m.chat_id = ${chat_id}::uuid`;
  return {
    member: r?.member === true,
    exists: r?.exists === true,
    live: r?.live === true,
    mine: (r?.mine as string | null) ?? null,
    reactions: (r?.reactions as ReactState["reactions"] | null) ?? [],
  };
}
