/**
 * Per-chat watermark initialisation (SYNC_V2_PROTOCOL.md §3.4 "20261022",
 * §3.7), used by scripts/migrations/20261022-sync-v2-watermarks.ts.
 *
 * For every membership of a numbered chat (user_id NOT NULL):
 *   cursor        = max(seq(PG last_read_msg_id), seq(Redis user_receipts[uid][chat].last_read_msg_id))
 *   from_unread   = Redis user_unread[uid][chat] = N present ? (N = 0 ? last_seq
 *                   : seq of the N-th newest non-own, non-system visible message − 1) : (unknown → cursor)
 *   read_seq      = GREATEST(read_seq, joined, cleared, LEAST(max(from_unread, cursor), seq_head))
 *   delivered_seq = GREATEST(delivered_seq, read_seq, LEAST(seq(last_delivered ids), seq_head))
 *   joined_seq    = GREATEST(joined_seq, max seq with created_at <  joined_at)
 *   cleared_seq   = GREATEST(cleared_seq, max seq with created_at <= cleared_at)
 *   left_seq      = non-active rows only, when NULL or below the target: max seq
 *                   with created_at <= left_at when the trigger recorded the
 *                   leave, else the member's last known position (left_target)
 * then amigo_refresh_min_wm(chat).
 *
 * Everything is GREATEST / COALESCE, so it is safe to run while the R1a
 * dual-write apply_receipts is live, and safe to re-run (§3.4: re-run right
 * before the R1b flip).
 */
import type { Sql } from "./sync-v2";

export type RedisMemberState = {
  read_id: string | null;       // user_receipts[uid][chat].last_read_msg_id
  delivered_id: string | null;  // user_receipts[uid][chat].last_delivered_msg_id
  unread: number | null;        // user_unread[uid][chat]; null = field missing = UNKNOWN (never 0)
};

export interface RedisReceiptReader {
  read(chat_id: string, user_ids: string[]): Promise<Map<string, RedisMemberState>>;
}

/** No Redis (dev / tests / --no-redis): every Redis input is unknown. */
export const NO_REDIS: RedisReceiptReader = {
  async read() { return new Map(); },
};

/** ioredis-backed reader: two HGETs per member in one pipeline. Read-only. */
export function ioredis_reader(redis: { pipeline(): any }): RedisReceiptReader {
  return {
    async read(chat_id, user_ids) {
      const out = new Map<string, RedisMemberState>();
      if (user_ids.length === 0) return out;
      const pipe = redis.pipeline();
      for (const uid of user_ids) {
        pipe.hget(`user_receipts:${uid}`, chat_id);
        pipe.hget(`user_unread:${uid}`, chat_id);
      }
      const res: [Error | null, string | null][] = await pipe.exec();
      user_ids.forEach((uid, i) => {
        const [e1, raw] = res[2 * i] ?? [null, null];
        const [e2, unread_raw] = res[2 * i + 1] ?? [null, null];
        let read_id: string | null = null, delivered_id: string | null = null;
        if (!e1 && raw) {
          try {
            const r = JSON.parse(raw);
            read_id = typeof r?.last_read_msg_id === "string" ? r.last_read_msg_id : null;
            delivered_id = typeof r?.last_delivered_msg_id === "string" ? r.last_delivered_msg_id : null;
          } catch { /* unparsable receipt = unknown */ }
        }
        const n = !e2 && unread_raw !== null && unread_raw !== undefined ? Number(unread_raw) : NaN;
        out.set(uid, { read_id, delivered_id, unread: Number.isFinite(n) && n >= 0 ? Math.floor(n) : null });
      });
      return out;
    },
  };
}

type Member = {
  id: string; user_id: string; status: string;
  joined_key: string | null; cleared_key: string | null;   // timestamptz as PG text (µs kept)
  left_key: string | null;                                  // left_at (non-active rows only)
  last_read_msg_id: string | null; last_delivered_msg_id: string | null;
};

// Walking N rows back for a huge Redis count costs N index entries; past this
// the count is treated as "everything is unread" (0), and GREATEST with the
// id cursor and floors decides.
const MAX_UNREAD_WALK = 5000;

export type WatermarkChatResult = { status: "done" | "skipped"; members: number };

export async function watermark_chat(sql: Sql, chat_id: string, redis: RedisReceiptReader): Promise<WatermarkChatResult> {
  const [chat] = await sql<{ seq_head: string | null; last_seq: string | null }[]>`
    SELECT seq_head::text AS seq_head, last_seq::text AS last_seq FROM chats WHERE id = ${chat_id}`;
  if (!chat || chat.seq_head === null) return { status: "skipped", members: 0 };
  const head = Number(chat.seq_head);
  const last_seq = chat.last_seq === null ? 0 : Number(chat.last_seq);

  const members = await sql<Member[]>`
    SELECT id, user_id, status, joined_at::text AS joined_key, cleared_at::text AS cleared_key,
           CASE WHEN status <> 'active' THEN left_at::text END AS left_key,
           last_read_msg_id, last_delivered_msg_id
      FROM chat_members WHERE chat_id = ${chat_id} AND user_id IS NOT NULL`;
  if (members.length === 0) {
    await sql`SELECT amigo_refresh_min_wm(${chat_id})`;
    return { status: "done", members: 0 };
  }

  const rs = await redis.read(chat_id, members.map((m) => m.user_id));

  // seq of every cursor id that belongs to THIS chat (foreign ids are ignored).
  const ids = new Set<string>();
  for (const m of members) {
    const r = rs.get(m.user_id);
    for (const v of [m.last_read_msg_id, m.last_delivered_msg_id, r?.read_id, r?.delivered_id]) if (v) ids.add(v);
  }
  const seq_of = new Map<string, number>();
  if (ids.size) {
    const rows = await sql<{ id: string; seq: string }[]>`
      SELECT id, seq::text AS seq FROM messages
       WHERE id = ANY(${sql.array([...ids])}::uuid[]) AND chat_id = ${chat_id} AND seq IS NOT NULL`;
    for (const r of rows) seq_of.set(r.id, Number(r.seq));
  }
  const s = (id: string | null | undefined) => (id ? seq_of.get(id) ?? 0 : 0);

  const floors = await floor_seqs(sql, chat_id, members);

  // Redis unread N > 0 → seq just below the N-th newest non-own, non-system visible message.
  const nth_users = members.filter((m) => {
    const n = rs.get(m.user_id)?.unread;
    return n !== null && n !== undefined && n > 0 && n <= MAX_UNREAD_WALK;
  });
  const nth = new Map<string, number>();
  if (nth_users.length) {
    const rows = await sql<{ id: string; seq: string | null }[]>`
      SELECT u.id, (SELECT m.seq FROM messages m
                     WHERE m.chat_id = ${chat_id} AND m.seq IS NOT NULL AND m.seq <= ${head}
                       AND m.deleted_at IS NULL AND m.type <> 'system'
                       AND m.sender_id IS DISTINCT FROM u.uid
                       AND (m.expires_at IS NULL OR m.expires_at > now())
                     ORDER BY m.seq DESC OFFSET u.n - 1 LIMIT 1)::text AS seq
        FROM unnest(${sql.array(nth_users.map((m) => m.id))}::uuid[],
                    ${sql.array(nth_users.map((m) => m.user_id))}::uuid[],
                    ${sql.array(nth_users.map((m) => String(rs.get(m.user_id)!.unread)))}::int[]) AS u(id, uid, n)`;
    for (const r of rows) nth.set(r.id, r.seq === null ? 0 : Math.max(0, Number(r.seq) - 1));
  }

  const upd = members.map((m) => {
    const r = rs.get(m.user_id);
    const cursor = Math.max(s(m.last_read_msg_id), s(r?.read_id));
    let from_unread = cursor;                                  // missing key = unknown → cursor
    if (r && r.unread !== null) {
      if (r.unread === 0) from_unread = last_seq;
      else if (r.unread > MAX_UNREAD_WALK) from_unread = 0;
      else from_unread = nth.get(m.id) ?? 0;
    }
    const read = Math.min(Math.max(from_unread, cursor), head);
    const delivered = Math.min(Math.max(read, s(m.last_delivered_msg_id), s(r?.delivered_id)), head);
    const joined = m.joined_key ? floors.joined.get(m.joined_key) ?? 0 : 0;
    const cleared = m.cleared_key ? floors.cleared.get(m.cleared_key) ?? 0 : 0;
    // left_target: the spec's "max seq with created_at <= the leave time"
    // when the trigger recorded left_at (every leave since 20261020c — in
    // particular one made before the backfill numbered the chat). Older
    // leaves have no timestamp: the member's last known position (the ids
    // they were delivered or had read) is the closest proxy and errs on
    // showing a shell LESS, never activity from after they left. Id cursors
    // only: the Redis unread count is relative to TODAY's head (a leaver's
    // counter stays 0 → last_seq), so it would stretch the shell to messages
    // sent after the leave.
    const left = Math.min(
      m.left_key
        ? Math.max(joined, floors.cleared.get(m.left_key) ?? 0)
        : Math.max(joined, cursor, s(m.last_delivered_msg_id), s(r?.delivered_id)),
      head,
    );
    return { id: m.id, read, delivered, joined, cleared, left };
  });

  await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    // Columns read_seq … left_seq only: no membership trigger fires (they
    // watch status / removed_at / joined_at / user_id).
    await tx`
      UPDATE chat_members cm SET
        read_seq      = GREATEST(cm.read_seq, x.j, x.cl, LEAST(x.r, ${head}::bigint)),
        delivered_seq = GREATEST(cm.delivered_seq, cm.read_seq, x.j, x.cl, LEAST(x.r, ${head}::bigint), LEAST(x.d, ${head}::bigint)),
        joined_seq    = GREATEST(cm.joined_seq, x.j),
        cleared_seq   = GREATEST(cm.cleared_seq, x.cl),
        -- A trigger-stamped left_seq (leave of a numbered chat = its head
        -- then) is kept. NULL, or below the member's own last known position
        -- (e.g. a 0 stamped by a 20261020c build that floored an unnumbered
        -- chat's leave at 0), is filled / repaired from the proxy.
        left_seq      = CASE WHEN cm.status <> 'active' AND (cm.left_seq IS NULL OR cm.left_seq < x.l)
                             THEN x.l ELSE cm.left_seq END
        FROM unnest(${tx.array(upd.map((u) => u.id))}::uuid[],
                    ${tx.array(upd.map((u) => String(u.read)))}::bigint[],
                    ${tx.array(upd.map((u) => String(u.delivered)))}::bigint[],
                    ${tx.array(upd.map((u) => String(u.joined)))}::bigint[],
                    ${tx.array(upd.map((u) => String(u.cleared)))}::bigint[],
                    ${tx.array(upd.map((u) => String(u.left)))}::bigint[]) AS x(id, r, d, j, cl, l)
       WHERE cm.id = x.id AND cm.chat_id = ${chat_id}`;
    await tx`SELECT amigo_refresh_min_wm(${chat_id})`;
  });
  return { status: "done", members: members.length };
}

/**
 * max seq with created_at < joined_at (strict: the legacy floor shows
 * created_at >= joined_at, and a DM's first message shares its creation
 * timestamp with the memberships) and max seq with created_at <= cleared_at
 * (legacy shows created_at > cleared_at). Thresholds travel as PG text, not JS
 * Dates, because a Date drops the microseconds and a clear would then let
 * through rows from the same millisecond. Cheap cases (before the chat's first
 * row / after its last) are answered from two index probes; the rest in ONE
 * ordered pass that merges the thresholds into the chat's rows as sentinels.
 */
async function floor_seqs(sql: Sql, chat_id: string, members: Member[]) {
  const joined = new Map<string, number>();
  const cleared = new Map<string, number>();
  const j_ths = [...new Set(members.map((m) => m.joined_key).filter((k): k is string => !!k))];
  // left_at thresholds share the cleared (<=) semantics and map.
  const c_ths = [...new Set(members.flatMap((m) => [m.cleared_key, m.left_key]).filter((k): k is string => !!k))];
  if (!j_ths.length && !c_ths.length) return { joined, cleared };

  // kind 0 = joined (strict <), kind 2 = cleared (<=). v NULL = needs the pass.
  const cls = await sql<{ kind: number; key: string; v: string | null }[]>`
    WITH b AS (
      SELECT (SELECT created_at FROM messages WHERE chat_id = ${chat_id} AND created_at IS NOT NULL ORDER BY created_at ASC LIMIT 1) AS lo,
             (SELECT created_at FROM messages WHERE chat_id = ${chat_id} AND created_at IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS hi,
             (SELECT max(seq) FROM messages WHERE chat_id = ${chat_id}) AS top),
    k AS (SELECT 0 AS kind, t FROM unnest(${sql.array(j_ths)}::timestamptz[]) t
          UNION ALL SELECT 2, t FROM unnest(${sql.array(c_ths)}::timestamptz[]) t)
    SELECT k.kind, k.t::text AS key, (CASE
             WHEN b.lo IS NULL THEN 0
             WHEN k.kind = 0 AND k.t <= b.lo THEN 0
             WHEN k.kind = 0 AND k.t >  b.hi THEN COALESCE(b.top, 0)
             WHEN k.kind = 2 AND k.t <  b.lo THEN 0
             WHEN k.kind = 2 AND k.t >= b.hi THEN COALESCE(b.top, 0)
           END)::text AS v
      FROM k CROSS JOIN b`;
  const pending_lt: string[] = [];
  const pending_le: string[] = [];
  for (const r of cls) {
    if (r.v !== null) (r.kind === 0 ? joined : cleared).set(r.key, Number(r.v));
    else (r.kind === 0 ? pending_lt : pending_le).push(r.key);
  }
  if (pending_lt.length || pending_le.length) {
    // kind 0 sorts before rows at an equal timestamp (strict <), kind 2 after (<=).
    const rows = await sql<{ kind: number; key: string; mx: string | null }[]>`
      SELECT kind, t::text AS key, mx::text AS mx FROM (
        SELECT kind, t, max(seq) OVER (ORDER BY t, kind ROWS UNBOUNDED PRECEDING) AS mx
          FROM (SELECT 1 AS kind, created_at AS t, seq FROM messages
                 WHERE chat_id = ${chat_id} AND created_at IS NOT NULL
                UNION ALL SELECT 0, th, NULL::bigint FROM unnest(${sql.array(pending_lt)}::timestamptz[]) th
                UNION ALL SELECT 2, th, NULL::bigint FROM unnest(${sql.array(pending_le)}::timestamptz[]) th) u
      ) z WHERE kind <> 1`;
    for (const r of rows) (r.kind === 0 ? joined : cleared).set(r.key, r.mx === null ? 0 : Number(r.mx));
  }
  return { joined, cleared };
}

/**
 * has_hidden = true for every membership with a delete-for-me row (§3.6). One
 * sequential read of message_info, then small batched updates. Monotone
 * (only ever sets true), so it is safe next to the live delete-for-me path.
 */
export async function mark_has_hidden(sql: Sql, batch = 500): Promise<number> {
  const pairs = await sql<{ chat_id: string; user_id: string }[]>`
    SELECT DISTINCT chat_id, user_id FROM message_info WHERE deleted_at IS NOT NULL`;
  let n = 0;
  for (let i = 0; i < pairs.length; i += batch) {
    const part = pairs.slice(i, i + batch);
    const res = await sql`
      UPDATE chat_members cm SET has_hidden = true
        FROM unnest(${sql.array(part.map((p) => p.chat_id))}::uuid[], ${sql.array(part.map((p) => p.user_id))}::uuid[]) AS x(c, u)
       WHERE cm.chat_id = x.c AND cm.user_id = x.u AND NOT cm.has_hidden`;
    n += res.count;
  }
  return n;
}
