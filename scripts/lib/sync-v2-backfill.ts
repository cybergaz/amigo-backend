/**
 * Per-chat seq backfill (SYNC_V2_PROTOCOL.md §3.4), used by
 * scripts/migrations/20261021-sync-v2-seq-backfill.ts. Split out so the two
 * phases can be exercised directly in tests (interruption, resume).
 *
 * Phase 1 (no chat lock): number the chat's existing rows in history order,
 *   COALESCE(sent_at, created_at), created_at, id — in short chunk
 *   transactions. While chats.seq_head IS NULL the triggers allocate nothing,
 *   so this script is the only seq writer for the chat (the runner also holds a
 *   cluster-wide advisory lock so two runs never overlap).
 * Phase 2 (short lock): under the chats row FOR UPDATE, number the rows that
 *   arrived during phase 1, set seq_head / last_seq / last_msg_id / pin_seq,
 *   commit. From that commit on, messages_bi numbers every new row.
 *
 * Resume: phase 1 only writes `seq IS NULL` rows and numbers them after the
 * highest seq already in the chat, so an interrupted run picks up exactly
 * where it stopped and never produces a duplicate.
 */
import type { Sql, Tx } from "./sync-v2";

export type ChatRow = { id: string; seq: number | null; deleted_at: Date | null; expires_at: Date | null };

export type BackfillHooks = {
  /** Called after every committed chunk with the rows it numbered; may sleep (throttle) or throw (stop). */
  after_chunk?: (rows: number) => Promise<void>;
};

export type Phase1Result = {
  t0: Date;
  top: number;            // highest seq in the chat after phase 1
  numbered: number;       // rows numbered by this call
  candidates: string[];   // ids of the newest visible rows (pointer candidates for phase 2)
};

// Rows that arrive while phase 1 runs are numbered in phase 2. A writer that
// began before T0 but committed after phase 1's read has created_at < T0, so
// phase 2 also looks back this far. Writes holding a transaction open longer
// than this are caught by the runner's final straggler sweep.
export const LATE_WINDOW = "1 hour";

const CANDIDATES = 50;

function is_visible(r: ChatRow, now: number): boolean {
  return r.deleted_at === null && (r.expires_at === null || new Date(r.expires_at).getTime() > now);
}

export async function phase1(sql: Sql, chat_id: string, chunk: number, hooks: BackfillHooks = {}): Promise<Phase1Result> {
  const [{ t0 }] = await sql<{ t0: Date }[]>`SELECT now() AS t0`;
  // Served by idx_messages_chat_created (range on chat_id) + an in-memory sort.
  // NULL created_at cannot come from the app (DEFAULT now()) but is included
  // here because phase 2's window cannot see it.
  const rows = await sql<ChatRow[]>`
    SELECT id, seq, deleted_at, expires_at FROM messages
     WHERE chat_id = ${chat_id} AND (created_at < ${t0} OR created_at IS NULL)
     ORDER BY COALESCE(sent_at, created_at) NULLS FIRST, created_at NULLS FIRST, id`;

  let top = 0;
  for (const r of rows) if (r.seq !== null && Number(r.seq) > top) top = Number(r.seq);
  const todo = rows.filter((r) => r.seq === null);
  const assigned = new Map<string, number>();
  todo.forEach((r, i) => assigned.set(r.id, top + i + 1));

  let numbered = 0;
  for (let i = 0; i < todo.length; i += chunk) {
    const part = todo.slice(i, i + chunk);
    const ids = part.map((r) => r.id);
    const ns = part.map((r) => String(assigned.get(r.id)!));
    const res = await sql`
      UPDATE messages m SET seq = x.n, mod_seq = x.n
        FROM unnest(${sql.array(ids)}::uuid[], ${sql.array(ns)}::bigint[]) AS x(id, n)
       WHERE m.id = x.id AND m.chat_id = ${chat_id} AND m.seq IS NULL`;
    numbered += res.count;
    await hooks.after_chunk?.(res.count);
  }
  top += todo.length;

  // Newest visible rows by seq, for phase 2's pointer without a full scan
  // while the chat is locked.
  const now = Date.now();
  const seq_of = (r: ChatRow) => (r.seq !== null ? Number(r.seq) : assigned.get(r.id)!);
  const candidates = rows
    .filter((r) => is_visible(r, now))
    .sort((a, b) => seq_of(b) - seq_of(a))
    .slice(0, CANDIDATES)
    .map((r) => r.id);

  return { t0, top, numbered, candidates };
}

export type Phase2Result = { status: "done" | "skipped"; head?: number; late?: number };

/**
 * Lock the chat, number late rows, publish seq_head. Throws 55P03 on lock
 * timeout (the runner requeues the chat).
 *
 * FOR UPDATE, not the FOR NO KEY UPDATE the spec sketches: an inserting
 * transaction holds FOR KEY SHARE on the chat (its FK check, and messages_bi's
 * settle step) until it commits. FOR UPDATE waits for those, so every row
 * written before this point is committed and gets numbered here; inserts that
 * start meanwhile wait (≤ the lock time) and then see seq_head.
 */
export async function phase2(sql: Sql, chat_id: string, p1: Phase1Result, lock_timeout = "2s"): Promise<Phase2Result> {
  return (await sql.begin(async (tx: Tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${lock_timeout}'`);
    const [chat] = await tx<{ seq_head: number | null }[]>`
      SELECT seq_head FROM chats WHERE id = ${chat_id} FOR UPDATE`;
    if (!chat || chat.seq_head !== null) return { status: "skipped" } as Phase2Result;

    // Late rows: inside the look-back window and still unnumbered.
    const late = await tx<{ id: string; n: string }[]>`
      UPDATE messages m SET seq = x.n, mod_seq = x.n
        FROM (SELECT id, ${p1.top}::bigint + row_number() OVER (ORDER BY created_at, id) AS n
                FROM messages
               WHERE chat_id = ${chat_id} AND seq IS NULL
                 AND created_at >= ${p1.t0}::timestamptz - ${LATE_WINDOW}::interval) x
       WHERE m.id = x.id
      RETURNING m.id, x.n::text AS n`;
    const head = p1.top + late.length;

    const cand = [...p1.candidates, ...late.map((r) => r.id)];
    let [last] = cand.length
      ? await tx<{ seq: string; id: string }[]>`
          SELECT seq::text AS seq, id FROM messages
           WHERE id = ANY(${tx.array(cand)}::uuid[]) AND chat_id = ${chat_id}
             AND deleted_at IS NULL AND seq IS NOT NULL AND (expires_at IS NULL OR expires_at > now())
           ORDER BY messages.seq DESC LIMIT 1`  // qualified: a bare "seq" would sort the ::text alias
      : [];
    if (!last && p1.candidates.length >= CANDIDATES) {
      // Every candidate died during phase 1: fall back to the full scan.
      [last] = await tx<{ seq: string; id: string }[]>`
        SELECT seq::text AS seq, id FROM messages
         WHERE chat_id = ${chat_id} AND deleted_at IS NULL AND seq IS NOT NULL
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY messages.seq DESC LIMIT 1`;
    }

    // last_msg_at is left alone: the chat keeps its place in the list. This
    // also repairs any historical last_msg_id drift.
    await tx`
      UPDATE chats SET seq_head = ${head},
             last_seq = ${last ? Number(last.seq) : null},
             last_msg_id = ${last ? last.id : null},
             pin_seq = CASE WHEN pinned_msg_id IS NOT NULL THEN ${head} ELSE pin_seq END
       WHERE id = ${chat_id}`;
    return { status: "done", head, late: late.length } as Phase2Result;
  })) as Phase2Result;
}

/**
 * Rows still unnumbered inside an already numbered chat (a writer that held a
 * transaction open past LATE_WINDOW). They get a fresh value at the head —
 * out of history order, but numbered, so seq coverage stays complete.
 */
export async function number_stragglers(sql: Sql, limit = 1000): Promise<number> {
  const rows = await sql<{ id: string; chat_id: string }[]>`
    SELECT m.id, m.chat_id FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.seq IS NULL AND c.seq_head IS NOT NULL
     ORDER BY m.chat_id LIMIT ${limit}`;
  let n = 0;
  for (const r of rows) {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '2s'`;
      const res = await tx`
        UPDATE messages SET (seq, mod_seq) = (SELECT v, v FROM amigo_alloc(${r.chat_id}, 1, NULL) v)
         WHERE id = ${r.id} AND seq IS NULL`;
      n += res.count;
    });
  }
  return n;
}
