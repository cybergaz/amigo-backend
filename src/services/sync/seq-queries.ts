// =============================================================================
// Sync v2 read-side SQL over the per-chat clock (SYNC_V2_PROTOCOL.md §3.2,
// §3.6, §3.12). Shared by scripts/sync-v2-verify.ts now and by the R1b
// surfaces (get_chat_list derived unread, heads, per-viewer ticks) later, so
// the verify script checks the exact statements production will run.
//
// Every helper takes a postgres-js client (`pg_client` from @/config/db, a
// transaction, or a script's own connection) and imports nothing with side
// effects, so scripts can use it without booting the app's pool.
//
// The clock itself (seq, mod_seq, seq_head, pins, floors, receipt mins) is
// maintained by the triggers in scripts/migrations/20261020c-sync-v2-triggers.ts.
// =============================================================================
import type postgres from "postgres";

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

// app_settings keys for Sync v2. Ledger scripts gate on the markers (§9);
// the flags are read by app code through app-settings.service.
export const SYNC_V2_KEYS = {
  // flags
  mode: "sync_v2",                          // 'off' | 'shadow' | 'on'
  system_rows: "sync_v2_system_rows",       // persist conversation actions as system rows
  delivered_staging: "sync_v2_delivered_staging",
  proto_lease: "sync_v2_proto_lease",       // honour the proto:{uid} lease (§3.13; plumbing until R1b)
  server_expiry: "sync_v2_server_expiry",   // expires_at from server time (§3.10); implied by mode 'on'
  rollout_pct: "sync_v2_rollout_pct",       // 0..100, users served syncProto 2 + /chat/sync/* (§5.14); default 0
  ack_fallback: "sync_v2_ack_fallback",     // FCM push for message:new a foreground WS recipient did not ack (F / R1b); default off
  net_telemetry: "sync_v2_net_telemetry",   // §14.13 FCM health + §14.14 beacon intake/flusher; default off
  chunked_upload: "sync_v2_chunked_upload", // §14.11 /api/media/upload/{init,:id,…} (M track); default off
  inline_thumbs: "sync_v2_inline_thumbs",   // §14.7 item 5 relay of attachments[i].thumb (M track); default off = dropped at ingress
  // markers (presence = done)
  schema: "sync_v2_schema",                 // 20261020a
  triggers: "sync_v2_triggers",             // 20261020c
  backfill: "sync_v2_backfill",             // 20261021
  indexes_post: "sync_v2_indexes_post",     // 20261021b (db:push no longer touches sync v2 objects; see drizzle.config.ts)
  watermarks: "sync_v2_watermarks",         // 20261022 (last run)
  code_deployed: "sync_v2_code_deployed",   // written by the R1a build on boot
  dualwrite: "sync_v2_dualwrite",           // written by the R1a build (apply_receipts dual-writes)
  net_beacons: "sync_v2_net_beacons",       // 20261023 (net_beacons table exists)
  media_uploads: "sync_v2_media_uploads",   // 20261024 (media_uploads table exists; independent of the sync v2 ledger order)
} as const;

/** Unread is capped at this in derived counts; v2 clients render "99+" (§3.6). */
export const UNREAD_CAP = 100;

// numbered = the chat has a clock (seq_head NOT NULL); unread is always 0 for
// one that has not been backfilled, so comparisons must skip those.
export type DerivedUnreadRow = { chat_id: string; unread: number; numbered: boolean };

/**
 * Derived unread per chat for one user (§3.6). F = GREATEST(read_seq,
 * joined_seq, cleared_seq). Fully read chats cost O(1); the rest count at most
 * UNREAD_CAP rows on idx_messages_unread. `legacy` adds the created_at floors
 * the legacy history endpoints apply, so old clients never see a count for
 * rows their history hides. Chats not yet numbered (last_seq NULL) count 0.
 * Only unremoved memberships are returned (hidden DMs / removed groups are
 * absent, not 0).
 */
export async function derived_unread(
  sql: Sql, user_id: string, opts: { chat_ids?: string[]; legacy?: boolean } = {},
): Promise<DerivedUnreadRow[]> {
  const legacy = opts.legacy === true;
  const chats = opts.chat_ids ?? null;
  const rows = await sql<{ chat_id: string; unread: number; numbered: boolean }[]>`
    SELECT cm.chat_id, (c.seq_head IS NOT NULL) AS numbered,
      (CASE WHEN cm.status <> 'active' OR cm.removed_at IS NOT NULL OR c.last_seq IS NULL
                 OR GREATEST(cm.read_seq, cm.joined_seq, cm.cleared_seq) >= c.last_seq THEN 0
       ELSE (SELECT count(*) FROM (SELECT 1 FROM messages m
              WHERE m.chat_id = cm.chat_id
                AND m.seq > GREATEST(cm.read_seq, cm.joined_seq, cm.cleared_seq) AND m.seq <= c.seq_head
                AND m.deleted_at IS NULL AND m.seq IS NOT NULL AND m.type <> 'system'
                AND m.sender_id IS DISTINCT FROM cm.user_id
                AND (m.expires_at IS NULL OR m.expires_at > now())
                AND (${legacy}::boolean = false
                     OR ((cm.joined_at IS NULL OR m.created_at >= cm.joined_at)
                         AND (cm.cleared_at IS NULL OR m.created_at > cm.cleared_at)))
                AND (NOT cm.has_hidden OR NOT EXISTS (
                      SELECT 1 FROM message_info mi
                       WHERE mi.message_id = m.id AND mi.user_id = cm.user_id AND mi.deleted_at IS NOT NULL))
              LIMIT ${UNREAD_CAP}) x) END)::int AS unread
      FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
     WHERE cm.user_id = ${user_id}
       -- Repeats the partial-index predicate (every chat_members index on
       -- user_id / chat_id is WHERE removed_at IS NULL): without it this is
       -- a seq scan of chat_members per call. Removed rows would count 0
       -- anyway (the CASE above), and no caller compares them.
       AND cm.removed_at IS NULL
       AND (${chats === null}::boolean OR cm.chat_id = ANY(${sql.array(chats ?? [])}::uuid[]))`;
  return rows.map((r) => ({ chat_id: r.chat_id, unread: Number(r.unread), numbered: r.numbered === true }));
}

export type OthersRow = { chat_id: string; others_read_seq: number; others_delivered_seq: number };

/**
 * Per-viewer "others" watermarks from chat_receipt_mins (§3.2):
 *   others_read_seq(me) = CASE WHEN r_min1_user = me THEN COALESCE(r_min2, seq_head) ELSE r_min1 END
 * In a DM that is exactly the peer's value. Broadcast lists have no mins row
 * and are omitted (they use per-copy watermarks, §3.8).
 */
export async function others_watermarks(sql: Sql, user_id: string, chat_ids: string[]): Promise<OthersRow[]> {
  if (chat_ids.length === 0) return [];
  const rows = await sql<{ chat_id: string; r: string; d: string }[]>`
    SELECT c.id AS chat_id,
           (CASE WHEN x.r_min1_user = ${user_id} THEN COALESCE(x.r_min2, c.seq_head, 0) ELSE x.r_min1 END)::text AS r,
           (CASE WHEN x.d_min1_user = ${user_id} THEN COALESCE(x.d_min2, c.seq_head, 0) ELSE x.d_min1 END)::text AS d
      FROM chats c JOIN chat_receipt_mins x ON x.chat_id = c.id
     WHERE c.id = ANY(${sql.array(chat_ids)}::uuid[])`;
  return rows.map((r) => ({ chat_id: r.chat_id, others_read_seq: Number(r.r), others_delivered_seq: Number(r.d) }));
}

/** seq of each id that belongs to `chat_id` (ids from other chats or unnumbered rows are absent). */
export async function seq_of_ids(sql: Sql, chat_id: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await sql<{ id: string; seq: string }[]>`
    SELECT id, seq::text AS seq FROM messages
     WHERE id = ANY(${sql.array(ids)}::uuid[]) AND chat_id = ${chat_id} AND seq IS NOT NULL`;
  for (const r of rows) out.set(r.id, Number(r.seq));
  return out;
}

export type ClearResult = { cleared_seq: number; read_seq: number; cleared_at: Date | null } | null;

/**
 * Clear chat up to a seq (§3.12):
 *   cleared_seq = GREATEST(cleared_seq, LEAST(upto_seq, seq_head))
 *   read_seq    = GREATEST(read_seq, cleared_seq)
 *   cleared_at  = created_at of the newest row at or below cleared_seq (legacy floor)
 * `upto_seq` NULL = the legacy clear without a seq: seq_head at processing.
 * A clear replayed from the outbox hours later therefore never hides or reads
 * anything that arrived after the tap. Returns null when the chat is not
 * numbered or the user has no membership row.
 *
 * Note cleared_at only moves forward and keeps the legacy "created_at >
 * cleared_at" floor consistent with cleared_seq for rows numbered in history order.
 */
export async function apply_clear(sql: Sql, user_id: string, chat_id: string, upto_seq: number | null): Promise<ClearResult> {
  const rows = await sql<{ cleared_seq: string; read_seq: string; cleared_at: Date | null }[]>`
    WITH t AS (
      SELECT LEAST(COALESCE(${upto_seq}::bigint, c.seq_head), c.seq_head) AS upto
        FROM chats c WHERE c.id = ${chat_id} AND c.seq_head IS NOT NULL)
    UPDATE chat_members cm SET
        cleared_seq = GREATEST(cm.cleared_seq, t.upto),
        read_seq    = GREATEST(cm.read_seq, cm.cleared_seq, t.upto),
        delivered_seq = GREATEST(cm.delivered_seq, cm.read_seq, cm.cleared_seq, t.upto),
        cleared_at  = GREATEST(cm.cleared_at, (
                        SELECT m.created_at FROM messages m
                         WHERE m.chat_id = ${chat_id} AND m.seq IS NOT NULL
                           AND m.seq <= GREATEST(cm.cleared_seq, t.upto)
                         ORDER BY m.seq DESC LIMIT 1))
      FROM t
     WHERE cm.chat_id = ${chat_id} AND cm.user_id = ${user_id} AND cm.removed_at IS NULL
    RETURNING cm.cleared_seq::text AS cleared_seq, cm.read_seq::text AS read_seq, cm.cleared_at`;
  const r = rows[0];
  // cleared_at: a Date from a plain postgres-js client, the server's text from
  // the app's drizzle-patched pg_client (its timestamp parsers are pass-through).
  const cleared_at = r?.cleared_at == null ? null
    : r.cleared_at instanceof Date ? r.cleared_at : new Date(String(r.cleared_at));
  return r ? { cleared_seq: Number(r.cleared_seq), read_seq: Number(r.read_seq), cleared_at } : null;
}
