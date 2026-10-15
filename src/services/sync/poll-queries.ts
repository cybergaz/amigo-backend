// =============================================================================
// Poll v2 SQL: ONE statement per computation (SYNC_V2_PROTOCOL.md §3.11,
// §3.9 batched LATERAL deltas)
// =============================================================================
// Everything a poll v2 response needs from Postgres comes from one statement
// (one RDS round trip, one READ COMMITTED snapshot, so heads, deltas and the
// pending DB tier agree with each other):
//
//   ln/lh/et  the heads etag over ALL the user's live memberships, computed
//             in SQL with read-core heads_etag's exact line format
//             (read-queries etag_line), plus a 16-hex hash per chat. Cheap:
//             one index range on (user_id, chat_id), no counts.
//   h         full HeadRows (unread, stub) only for the chats that CHANGED:
//               start: every chat when the client's etag differs (full
//                      heads), none when it matches;
//               wake:  the chats whose line hash differs from the view taken
//                      at the request start (partial heads), plus `gone` —
//                      memberships that left the set.
//             The start view is exactly the client's heads (its etag
//             matched), so view − gone + changed = the current heads: a
//             partial answer can never hide a change, whatever the nudge
//             named (§3.11 step 6 sent rows "for the nudged chats only",
//             which loses changes no nudge announced).
//   v/dl…dj   inline deltas for watched chats whose head moved past `since`
//             (≤ TAIL_GAP behind; a chat further behind gets an entry with
//             no rows and tail_needed, as §3.9 auto would switch to tail):
//             per chat the delta_sql 'delta' union (unchanged rows by seq on
//             uniq_messages_chat_seq ∪ changed rows by mod_seq on
//             idx_messages_chat_modchg) with LIMIT 51, then ≤ 300 rows over
//             the response in watch order; row JSON / joins only for kept rows.
//   pd        the pending DB tier (missed_ws_messages, ≤ 500 oldest) on
//             idx_missedwsmessages_user_id.
//
// postgres-js client agnostic (pg_client, a transaction, the PGlite harness).
// =============================================================================
import type postgres from "postgres";
import {
  etag_line,
  head_rows,
  member_lateral,
  row_cols,
  row_joins,
  row_json,
  visible,
  type HeadRow,
} from "./read-queries";
import { SHELL_SYSTEM_WINDOW, TAIL_GAP } from "./read-core";
import {
  POLL_DELTA_PER_CHAT,
  POLL_DELTA_TOTAL,
  POLL_PENDING_DB_READ,
  view_from_json,
  type HeadsView,
  type PendingEntryLike,
  type PollDeltaRaw,
  type PollWatch,
} from "./poll-core";

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

export type PollStateParams = {
  // start: rows for every chat iff this differs from the current etag
  client_etag: string | null;
  // wake: diff against this view instead (client_etag is then ignored)
  known: HeadsView | null;
  // return the per-chat hashes (the view a parked request keeps)
  want_view: boolean;
  // HeadRow.last_message for rows with activity_at > this (null: no stubs)
  stubs_after: number | null;
  watch: PollWatch[];
};

export type PollStateRaw = {
  etag: string;
  chats: HeadRow[];
  gone: string[];
  view: HeadsView | null;
  deltas: PollDeltaRaw[];
  pending_db: PendingEntryLike[];
  server_time: string;
  resp_ver: number;
};

export async function poll_state_sql(sql: Sql, uid: string, p: PollStateParams): Promise<PollStateRaw> {
  const diff = p.known !== null;
  const kid = diff ? Array.from(p.known!.keys()) : [];
  const kh = diff ? Array.from(p.known!.values()) : [];
  const wid = p.watch.map((w) => w.chat_id);
  const wsince = p.watch.map((w) => w.since);
  const L = POLL_DELTA_PER_CHAT;
  const now = sql`v.now_ts`;
  const [res] = await sql<Record<string, unknown>[]>`
    WITH ln AS MATERIALIZED (
      SELECT cm.chat_id, ${etag_line(sql, uid)} AS line
        FROM chat_members cm
        JOIN chats c ON c.id = cm.chat_id
        -- LATERAL + LIMIT: one PK probe per membership. A plain LEFT JOIN let
        -- the planner hash a seq scan of the whole mins table (harness).
        LEFT JOIN LATERAL (
          SELECT * FROM chat_receipt_mins xm WHERE xm.chat_id = cm.chat_id LIMIT 1
        ) x ON true
       WHERE cm.user_id = ${uid}::uuid AND cm.removed_at IS NULL AND c.deleted_at IS NULL
    ),
    lh AS (SELECT ln.chat_id, left(md5(ln.line), 16) AS lhash FROM ln),
    et AS (
      -- chr(10) = the newline heads_etag joins lines with, spelled without a
      -- string escape (template raw vs cooked handling differs by client).
      SELECT 'h2-' || md5(COALESCE(string_agg(ln.line, chr(10) ORDER BY ln.line COLLATE "C"), '')) AS etag FROM ln
    ),
    kn AS (
      SELECT k.chat_id, k.khash FROM unnest(${sql.array(kid)}::uuid[], ${sql.array(kh)}::text[]) AS k(chat_id, khash)
    ),
    chg AS (
      SELECT lh.chat_id FROM lh LEFT JOIN kn ON kn.chat_id = lh.chat_id
       WHERE CASE WHEN ${diff}::boolean THEN kn.khash IS DISTINCT FROM lh.lhash
                  ELSE ${p.client_etag}::text IS DISTINCT FROM (SELECT et.etag FROM et) END
    ),
    gone AS (
      SELECT kn.chat_id FROM kn WHERE NOT EXISTS (SELECT 1 FROM lh WHERE lh.chat_id = kn.chat_id)
    ),
    h AS (${head_rows(sql, uid, p.stubs_after, sql`
         AND cm.chat_id IN (SELECT chg.chat_id FROM chg)`)}
    ),
    w AS (
      SELECT * FROM unnest(${sql.array(wid)}::uuid[], ${sql.array(wsince)}::bigint[]) WITH ORDINALITY AS w(chat_id, since, ord)
    ),
    v AS MATERIALIZED (
      SELECT w.ord, w.since, c.id, c.type, c.seq_head AS h, c.last_seq, c.pin_seq, c.pinned_msg_id,
             c.settings_seq, c.roster_seq, c.title, c.profile_pic, c.owner_id, c.disappearing_after_sec,
             cm.status, (cm.removed_at IS NOT NULL) AS hidden_chat,
             cm.read_seq, cm.delivered_seq, cm.joined_seq, cm.cleared_seq, cm.left_seq,
             COALESCE(cm.has_hidden, false) AS has_hidden,
             COALESCE(GREATEST(cm.joined_seq, cm.cleared_seq), 0) AS fl,
             (cm.status = 'active') AS full_access,
             CASE WHEN cm.status = 'active' THEN c.seq_head
                  ELSE LEAST(c.seq_head, COALESCE(cm.left_seq, 0) + ${SHELL_SYSTEM_WINDOW}::bigint) END AS hi,
             COALESCE(cm.left_seq, 0) AS lseq,
             -- §3.9 auto → tail: inline deltas would page a far-behind chat
             -- from its oldest rows, 50 per poll; no rows are read for it.
             (c.seq_head - w.since > ${TAIL_GAP}::bigint) AS tail,
             now() AS now_ts
        FROM w
        JOIN chats c ON c.id = w.chat_id
        ${member_lateral(sql, uid)}
       WHERE c.deleted_at IS NULL AND c.seq_head IS NOT NULL AND c.seq_head > w.since
         AND cm.status IN ('active', 'left', 'pending')
    ),
    dl AS (
      SELECT v.ord, x.* FROM v CROSS JOIN LATERAL (
        SELECT * FROM (
          (SELECT ${row_cols(sql)} FROM messages m
            WHERE m.chat_id = v.id
              AND m.seq > GREATEST(v.since, v.fl) AND m.seq <= v.hi
              AND m.mod_seq = m.seq AND ${visible(sql, uid)}
            ORDER BY m.seq LIMIT ${L + 1}::int)
          UNION ALL
          (SELECT ${row_cols(sql)} FROM messages m
            WHERE m.chat_id = v.id
              AND m.mod_seq > v.since AND m.mod_seq <= v.h AND m.mod_seq <> m.seq
              AND ${visible(sql, uid)}
            ORDER BY m.mod_seq LIMIT ${L + 1}::int)
        ) un ORDER BY un.mod_seq LIMIT ${L + 1}::int
      ) x
      WHERE NOT v.tail
    ),
    cnt AS (SELECT dl.ord, count(*) AS fetched FROM dl GROUP BY dl.ord),
    dr AS (SELECT dl.*, row_number() OVER (PARTITION BY dl.ord ORDER BY dl.mod_seq) AS pr FROM dl),
    dg AS (SELECT dr.*, row_number() OVER (ORDER BY dr.ord, dr.mod_seq) AS gr FROM dr WHERE dr.pr <= ${L}::int),
    kept AS (SELECT * FROM dg WHERE dg.gr <= ${POLL_DELTA_TOTAL}::int),
    rj AS (
      SELECT r.ord,
             json_agg(${row_json(sql, sql`hz.hid`, now)} ORDER BY r.mod_seq) AS rows,
             count(*) AS n, max(r.mod_seq) AS last_mod
        FROM kept r
        JOIN v ON v.ord = r.ord
        CROSS JOIN LATERAL (
          SELECT (v.has_hidden AND EXISTS (
                    SELECT 1 FROM message_info mi
                     WHERE mi.message_id = r.id AND mi.user_id = ${uid}::uuid AND mi.deleted_at IS NOT NULL)) AS hid
        ) hz
        ${row_joins(sql)}
       GROUP BY r.ord
    ),
    dj AS (
      SELECT json_agg(json_build_object(
               'chat_id', v.id, 'chat_type', v.type, 'status', v.status, 'hidden', v.hidden_chat,
               'since', v.since, 'seq_head', v.h,
               'last_seq', CASE WHEN v.full_access THEN v.last_seq END,
               'read_seq', v.read_seq, 'delivered_seq', v.delivered_seq, 'joined_seq', v.joined_seq,
               'cleared_seq', v.cleared_seq, 'left_seq', v.left_seq, 'floor_seq', v.fl, 'roster_seq', v.roster_seq,
               -- PD-3: the current pin to every active member, whatever their floors.
               'pin', CASE WHEN v.full_access AND v.pin_seq > v.since THEN json_build_object(
                        'pinned_msg_id', v.pinned_msg_id, 'pin_seq', v.pin_seq,
                        'pinned_message', (SELECT ${row_json(sql, sql`false`, now)}
                                             FROM messages r ${row_joins(sql)}
                                            WHERE r.id = v.pinned_msg_id AND r.deleted_at IS NULL)) END,
               'settings', CASE WHEN v.settings_seq > v.since THEN json_build_object(
                        'settings_seq', v.settings_seq, 'title', v.title, 'profile_pic', v.profile_pic,
                        'owner_id', v.owner_id, 'disappearing_after_sec', v.disappearing_after_sec) END,
               'rows', COALESCE(rj.rows, '[]'::json), 'tail', v.tail,
               'n_kept', COALESCE(rj.n, 0), 'last_mod', rj.last_mod, 'fetched', COALESCE(cnt.fetched, 0))
             ORDER BY v.ord) AS deltas
        FROM v
        LEFT JOIN rj ON rj.ord = v.ord
        LEFT JOIN cnt ON cnt.ord = v.ord
    ),
    pd AS (
      SELECT json_agg(json_build_object(
               'message_id', q.id, 'v', COALESCE(q.entry_v, ''), 'ws_message', q.ws_message,
               'created_at', floor(extract(epoch FROM q.created_at) * 1000)::bigint) ORDER BY q.created_at) AS rows
        FROM (SELECT mw.id, mw.entry_v, mw.ws_message, mw.created_at FROM missed_ws_messages mw
               WHERE mw.user_id = ${uid}::uuid ORDER BY mw.created_at LIMIT ${POLL_PENDING_DB_READ}::int) q
    )
    SELECT (SELECT et.etag FROM et) AS etag,
           (SELECT json_agg(h ORDER BY h.activity_at DESC NULLS LAST, h.chat_id) FROM h) AS chats,
           (SELECT json_agg(gone.chat_id) FROM gone) AS gone,
           CASE WHEN ${p.want_view}::boolean THEN (SELECT json_object_agg(lh.chat_id, lh.lhash) FROM lh) END AS view,
           (SELECT dj.deltas FROM dj) AS deltas,
           (SELECT pd.rows FROM pd) AS pending_db,
           to_json(clock_timestamp()) AS server_time,
           (extract(epoch FROM clock_timestamp()) * 1000000)::bigint::text AS resp_ver`;

  const r = res ?? {};
  const pending_db = ((r.pending_db as Record<string, unknown>[] | null) ?? []).map((row) => ({
    message_id: String(row.message_id),
    v: typeof row.v === "string" ? row.v : "",
    ws_message: row.ws_message as PendingEntryLike["ws_message"],
    created_at: Number(row.created_at) || 0,
  }));
  return {
    etag: String(r.etag ?? ""),
    chats: (r.chats as HeadRow[] | null) ?? [],
    gone: ((r.gone as string[] | null) ?? []).map(String),
    view: r.view === null || r.view === undefined ? null : view_from_json(r.view),
    deltas: (r.deltas as PollDeltaRaw[] | null) ?? [],
    pending_db,
    server_time: String(r.server_time ?? new Date().toISOString()),
    resp_ver: Number(r.resp_ver ?? Date.now() * 1000),
  };
}
