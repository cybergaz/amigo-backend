// =============================================================================
// media_uploads SQL: the PG UploadLedger (SYNC_V2_PROTOCOL.md §14.11)
// =============================================================================
// Raw postgres-js, so the PGlite harness runs exactly these statements.
// Written for BOTH the app's drizzle-patched pg_client and a plain client
// (see services/sync/write-queries.ts): JSON goes in as text with an explicit
// ::text::jsonb cast and comes back as ::text (parsed here); timestamps come
// back as epoch milliseconds (float8), never as Date / server text; sizes are
// bigint in the table and float8 on the way out (≤ 95 MiB, exact).
//
// The row lock is the only serialisation point for chunk writes: advance()
// is "UPDATE … WHERE received_bytes = $offset". Two racing retries of one
// chunk both reach it; the second waits for the first's commit, re-checks
// the WHERE on the new row version (READ COMMITTED), matches nothing and
// returns null → 409 {offset}. Part assembly, complete and every
// open → aborted transition (abort, GC, the cap's eviction) hold the
// cluster-wide advisory lock 'upload:'+id (run_pg_singleton_sql, injected)
// instead; assembly takes the row lock only in its final UPDATE.
// =============================================================================
import type postgres from "postgres";
import type {
  InsertResult,
  LockedLedger,
  NewUpload,
  PartRef,
  StagedChunk,
  UploadLedger,
  UploadRow,
  UploadState,
} from "./chunked-upload-core";

type AnySql = postgres.Sql<{}> | postgres.TransactionSql<{}>;

// pg_advisory_xact_lock(int4, int4) namespace for the per-user init lock:
// ASCII "UPLD". Distinct from jobs.ts LOCK_NS_JOBS "JOBS" (which the
// per-upload 'upload:'+id lock uses through run_pg_singleton_sql) and the
// broadcast namespaces "BCST" / "BCPR".
export const LOCK_NS_UPLOAD_USER = 0x55504c44;

/** Runs fn in one transaction holding the advisory lock `name`; undefined when held elsewhere. */
export type RunLocked = <T>(name: string, fn: (tx: postgres.TransactionSql<{}>) => Promise<T>) => Promise<T | undefined>;

export const upload_lock_name = (id: string) => `upload:${id}`;

/**
 * Unlocked cap pre-check for init (before CreateMultipartUpload): room when
 * under the cap, or when the least recently active open upload is evictable.
 */
export const has_room_sql = async (
  sql: AnySql, user_id: string, opts: { max_open: number; evict_idle_s: number },
): Promise<boolean> => {
  const rows = await sql<{ n: number; idle_s: number | null }[]>`
    SELECT count(*)::int AS n, extract(epoch FROM now() - min(updated_at))::float8 AS idle_s
      FROM media_uploads
     WHERE user_id = ${user_id}::uuid AND state = 'open' AND expires_at > now()`;
  const r = rows[0];
  return !r || Number(r.n) < opts.max_open || Number(r.idle_s ?? 0) >= opts.evict_idle_s;
};

export const touch_upload_sql = async (sql: AnySql, id: string): Promise<void> => {
  await sql`UPDATE media_uploads SET updated_at = now() WHERE id = ${id}::uuid AND state = 'open'`;
};

const COLS = `id::text AS id, user_id::text AS user_id, key, mime, category, file_name,
  size::float8 AS size, chunk_size, sha256, s3_upload_id,
  received_bytes::float8 AS received_bytes, assembled_bytes::float8 AS assembled_bytes,
  parts::text AS parts, chunks::text AS chunks, state, url, thumb_key,
  (extract(epoch FROM created_at) * 1000)::float8 AS created_ms,
  (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms,
  (extract(epoch FROM expires_at) * 1000)::float8 AS expires_ms,
  (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms`;

type RawRow = Omit<UploadRow, "parts" | "chunks" | "state"> & { parts: string; chunks: string; state: string };

const parse_json_array = <T>(v: unknown): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (typeof v !== "string") return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? (x as T[]) : [];
  } catch {
    return [];
  }
};

const to_row = (r: RawRow): UploadRow => ({
  id: r.id,
  user_id: r.user_id,
  key: r.key,
  mime: r.mime,
  category: r.category,
  file_name: r.file_name ?? null,
  size: Number(r.size),
  chunk_size: Number(r.chunk_size),
  sha256: r.sha256 ?? null,
  s3_upload_id: r.s3_upload_id,
  received_bytes: Number(r.received_bytes),
  assembled_bytes: Number(r.assembled_bytes),
  parts: parse_json_array<PartRef>(r.parts).map((p) => ({ n: Number(p.n), etag: String(p.etag), size: Number(p.size) })),
  chunks: parse_json_array<StagedChunk>(r.chunks).map((c) => ({ o: Number(c.o), l: Number(c.l), s: String(c.s) })),
  state: r.state as UploadState,
  url: r.url ?? null,
  thumb_key: r.thumb_key ?? null,
  created_ms: Number(r.created_ms),
  updated_ms: Number(r.updated_ms),
  expires_ms: Number(r.expires_ms),
  now_ms: Number(r.now_ms),
});

export const get_upload_sql = async (sql: AnySql, id: string): Promise<UploadRow | null> => {
  const rows = await sql.unsafe<RawRow[]>(`SELECT ${COLS} FROM media_uploads WHERE id = $1::uuid`, [id]);
  return rows[0] ? to_row(rows[0]) : null;
};

/**
 * Insert under the per-user cap, in one transaction serialised per user by
 * an advisory lock (two inits racing for the last slot cannot both win).
 * At the cap the least recently active open upload is evicted (state →
 * aborted, returned so the caller cleans S3) if it has been idle for
 * `evict_idle_s`; otherwise nothing is written.
 */
export const insert_upload_sql = async (
  sql: postgres.Sql<{}>,
  row: NewUpload,
  opts: { max_open: number; evict_idle_s: number; idle_s: number; hard_s: number },
  upload_lock_ns: number,
): Promise<InsertResult> => {
  return (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_NS_UPLOAD_USER}::int, hashtext(${row.user_id}::text))`;
    const open = await tx<{ id: string; idle_s: number }[]>`
      SELECT id::text AS id, extract(epoch FROM now() - updated_at)::float8 AS idle_s
        FROM media_uploads
       WHERE user_id = ${row.user_id}::uuid AND state = 'open' AND expires_at > now()
       ORDER BY updated_at ASC`;
    let evicted: UploadRow | null = null;
    if (open.length >= opts.max_open) {
      const victim = open[0]!;
      if (Number(victim.idle_s) < opts.evict_idle_s) return { ok: false } as const;
      // The victim's per-upload lock (the run_pg_singleton_sql key: same
      // namespace, hashtext of the same name), held to commit: a complete
      // holding it may be between CompleteMultipartUpload and its row write,
      // and aborting under it would orphan the finished object. Busy → refuse.
      const [lk] = await tx<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${upload_lock_ns}::int, hashtext(${upload_lock_name(victim.id)}::text)) AS ok`;
      if (lk?.ok !== true) return { ok: false } as const;
      const gone = await tx.unsafe<RawRow[]>(`
        UPDATE media_uploads SET state = 'aborted', updated_at = now()
         WHERE id = $1::uuid AND state = 'open'
        RETURNING ${COLS}`, [victim.id]);
      evicted = gone[0] ? to_row(gone[0]) : null;
    }
    await tx`
      INSERT INTO media_uploads (id, user_id, key, mime, category, file_name, size, chunk_size, sha256,
                                 s3_upload_id, expires_at)
      VALUES (${row.id}::uuid, ${row.user_id}::uuid, ${row.key}, ${row.mime}, ${row.category}, ${row.file_name},
              ${row.size}::bigint, ${row.chunk_size}::int, ${row.sha256}, ${row.s3_upload_id},
              now() + make_interval(secs => LEAST(${opts.idle_s}::int, ${opts.hard_s}::int)))`;
    return { ok: true, evicted } as const;
  })) as InsertResult;
};

/**
 * The chunk CAS. Advances only from exactly `offset`, only while open and
 * unexpired, never past `size`; appends the staged chunk and slides the
 * idle expiry (capped at created_at + hard_s). null = no row matched.
 */
export const advance_upload_sql = async (
  sql: AnySql,
  a: { id: string; user_id: string; offset: number; len: number; nonce: string; idle_s: number; hard_s: number },
): Promise<{ received_bytes: number; assembled_bytes: number } | null> => {
  const chunk = JSON.stringify([{ o: a.offset, l: a.len, s: a.nonce }]);
  const rows = await sql<{ received_bytes: number; assembled_bytes: number }[]>`
    UPDATE media_uploads
       SET received_bytes = received_bytes + ${a.len}::bigint,
           chunks = chunks || ${chunk}::text::jsonb,
           updated_at = now(),
           expires_at = LEAST(created_at + make_interval(secs => ${a.hard_s}::int),
                              now() + make_interval(secs => ${a.idle_s}::int))
     WHERE id = ${a.id}::uuid AND user_id = ${a.user_id}::uuid AND state = 'open'
       AND received_bytes = ${a.offset}::bigint
       AND received_bytes + ${a.len}::bigint <= size
       AND expires_at > now()
    RETURNING received_bytes::float8 AS received_bytes, assembled_bytes::float8 AS assembled_bytes`;
  const r = rows[0];
  return r ? { received_bytes: Number(r.received_bytes), assembled_bytes: Number(r.assembled_bytes) } : null;
};

/**
 * Record one assembled part. CAS on assembled_bytes AND the part count, so
 * a stale assembler can never append a duplicate part number. The SET
 * expressions read the row version being updated, so chunks appended by a
 * concurrent advance() are kept (only those below the new boundary drop).
 */
export const record_part_sql = async (
  sql: AnySql,
  a: { id: string; old_assembled: number; n_before: number; part: PartRef; new_assembled: number },
): Promise<boolean> => {
  const part = JSON.stringify([{ n: a.part.n, etag: a.part.etag, size: a.part.size }]);
  const rows = await sql`
    UPDATE media_uploads
       SET parts = parts || ${part}::text::jsonb,
           assembled_bytes = ${a.new_assembled}::bigint,
           chunks = COALESCE((SELECT jsonb_agg(c ORDER BY (c->>'o')::bigint)
                                FROM jsonb_array_elements(chunks) AS c
                               WHERE (c->>'o')::bigint >= ${a.new_assembled}::bigint), '[]'::jsonb)
     WHERE id = ${a.id}::uuid AND state = 'open'
       AND assembled_bytes = ${a.old_assembled}::bigint
       AND jsonb_array_length(parts) = ${a.n_before}::int
    RETURNING 1 AS ok`;
  return rows.length === 1;
};

export const mark_complete_sql = async (
  sql: AnySql, a: { id: string; url: string; thumb_key: string | null },
): Promise<boolean> => {
  const rows = await sql`
    UPDATE media_uploads
       SET state = 'complete', url = ${a.url}, thumb_key = ${a.thumb_key}, chunks = '[]'::jsonb,
           completed_at = now(), updated_at = now()
     WHERE id = ${a.id}::uuid AND state = 'open' AND assembled_bytes = size AND received_bytes = size
    RETURNING 1 AS ok`;
  return rows.length === 1;
};

/** open → aborted. user_id null = the GC (any owner). Returns the row as it was. */
export const mark_aborted_sql = async (sql: AnySql, id: string, user_id: string | null): Promise<UploadRow | null> => {
  // RETURNING sees the new values; state/updated_at are the only columns
  // changed, and the caller needs key / s3_upload_id / chunks for cleanup.
  const rows = await sql.unsafe<RawRow[]>(`
    UPDATE media_uploads SET state = 'aborted', updated_at = now()
     WHERE id = $1::uuid AND state = 'open' AND ($2::uuid IS NULL OR user_id = $2::uuid)
    RETURNING ${COLS}`, [id, user_id]);
  return rows[0] ? to_row(rows[0]) : null;
};

/** Open uploads past expires_at, oldest first (idx_media_uploads_expires_open). */
export const list_expired_sql = async (sql: AnySql, limit: number): Promise<UploadRow[]> => {
  const rows = await sql.unsafe<RawRow[]>(`
    SELECT ${COLS} FROM media_uploads
     WHERE state = 'open' AND expires_at <= now()
     ORDER BY expires_at
     LIMIT $1::int`, [limit]);
  return rows.map(to_row);
};

/** Delete ≤ limit complete / aborted rows idle for older_than_s. */
export const purge_terminal_sql = async (sql: AnySql, older_than_s: number, limit: number): Promise<number> => {
  const rows = await sql<{ n: number }[]>`
    WITH del AS (
      DELETE FROM media_uploads
       WHERE id IN (SELECT id FROM media_uploads
                     WHERE state <> 'open' AND updated_at < now() - make_interval(secs => ${older_than_s}::int)
                     LIMIT ${limit}::int)
      RETURNING 1)
    SELECT count(*)::int AS n FROM del`;
  return Number(rows[0]?.n ?? 0);
};

export const count_open_sql = async (sql: AnySql): Promise<{ open: number; expired_open: number }> => {
  const rows = await sql<{ open: number; expired_open: number }[]>`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE expires_at <= now())::int AS expired_open
      FROM media_uploads WHERE state = 'open'`;
  return { open: Number(rows[0]?.open ?? 0), expired_open: Number(rows[0]?.expired_open ?? 0) };
};

const locked = (tx: AnySql): LockedLedger => ({
  get: (id) => get_upload_sql(tx, id),
  record_part: (a) => record_part_sql(tx, a),
  mark_complete: (a) => mark_complete_sql(tx, a),
  mark_aborted: (id, user_id) => mark_aborted_sql(tx, id, user_id),
});

/**
 * The PG UploadLedger. `run_locked` = jobs.ts run_pg_singleton_sql in
 * production and `upload_lock_ns` its namespace (LOCK_NS_JOBS), which the
 * cap's eviction needs to take the same per-upload lock inside its own
 * transaction.
 */
export const pg_upload_ledger = (sql: postgres.Sql<{}>, run_locked: RunLocked, upload_lock_ns: number): UploadLedger => ({
  insert: (row, opts) => insert_upload_sql(sql, row, opts, upload_lock_ns),
  has_room: (user_id, opts) => has_room_sql(sql, user_id, opts),
  get: (id) => get_upload_sql(sql, id),
  touch: (id) => touch_upload_sql(sql, id),
  advance: (a) => advance_upload_sql(sql, a),
  with_lock: (id, fn) => run_locked(upload_lock_name(id), (tx) => fn(locked(tx))),
  list_expired: (limit) => list_expired_sql(sql, limit),
  purge_terminal: (s, limit) => purge_terminal_sql(sql, s, limit),
});
