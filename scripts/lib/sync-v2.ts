/**
 * Shared helpers for the Sync v2 ledger scripts (SYNC_V2_PROTOCOL.md §3.1–§3.4,
 * §9 row 2). The scripts themselves live in scripts/migrations/2026102*-sync-v2-*.ts
 * and stay thin; everything that has to behave identically across them (lock
 * timeouts, retry, index validity, markers) lives here so one fix covers all.
 *
 * Every helper takes a postgres-js `Sql` so the same code runs against prod RDS
 * from the ledger runner and against a throwaway database in tests.
 */
import postgres from "postgres";
import { SYNC_V2_KEYS } from "../../src/services/sync/seq-queries";

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
type AnySql = Sql | Tx;

/** Open the script's connection pool against this box's DB_URL. */
export function open_sql(max = 2): Sql {
  const url = process.env.DB_URL;
  if (!url) throw new Error("DB_URL is not set — check the .env on this machine.");
  // prepare:false keeps the scripts usable through a transaction pooler on dev.
  return postgres(url, { max, onnotice: () => {}, prepare: !/pooler|pgbouncer/i.test(url) });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function opt(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

export function num_opt(name: string, fallback: number): number {
  const raw = opt(name) ?? process.env[`SYNC_V2_${name.toUpperCase().replace(/-/g, "_")}`];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Retry for short DDL / lock-taking statements ────────────────────────────
// 55P03 lock_not_available (our lock_timeout fired), 40P01 deadlock,
// 40001 serialization. Anything else is a real error and surfaces at once.
const RETRYABLE = new Set(["55P03", "40P01", "40001"]);
export const is_retryable = (e: unknown) => RETRYABLE.has((e as { code?: string })?.code ?? "");

/**
 * Run `work` in its own transaction with `SET LOCAL lock_timeout`, retrying
 * up to `tries` times with backoff when it could not get its lock.
 *
 * WHY: an ALTER TABLE waiting for its ACCESS EXCLUSIVE lock blocks every
 * query queued behind it on the live table. A short lock_timeout caps that
 * stall at a few seconds; the retry makes "the table was busy" a non-event.
 */
export async function with_lock_retry<T>(
  sql: Sql,
  label: string,
  work: (tx: Tx) => Promise<T>,
  { lock_timeout = "3s", tries = 5 }: { lock_timeout?: string; tries?: number } = {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return (await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${lock_timeout}'`);
        return work(tx);
      })) as T;
    } catch (e) {
      last = e;
      if (!is_retryable(e) || attempt === tries) break;
      const wait = Math.min(500 * 2 ** (attempt - 1), 8000);
      console.warn(`  ⏳ ${label}: ${(e as Error).message} — retry ${attempt}/${tries - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

/** One DDL statement, own transaction, lock_timeout 3s, retry ×5 (§3.1). */
export async function ddl(sql: Sql, statement: string, label = statement.split("\n")[0]!.slice(0, 80)) {
  await with_lock_retry(sql, label, (tx) => tx.unsafe(statement));
  console.log(`  ✔ ${label}`);
}

// ── Indexes ─────────────────────────────────────────────────────────────────

type IndexState = { valid: boolean; ready: boolean; def: string } | null;

export async function index_state(sql: AnySql, name: string): Promise<IndexState> {
  const rows = await sql<{ indisvalid: boolean; indisready: boolean; def: string }[]>`
    SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = ${name} AND n.nspname = current_schema()`;
  const r = rows[0];
  return r ? { valid: r.indisvalid, ready: r.indisready, def: r.def } : null;
}

/**
 * CREATE INDEX CONCURRENTLY with a validity check (§3.1).
 *
 * WHY the check: a CONCURRENTLY build that fails (deadlock, cancel, a
 * duplicate for a UNIQUE index) leaves an INVALID index behind, and
 * `IF NOT EXISTS` then silently keeps it forever — the planner never uses it
 * and a UNIQUE one still enforces nothing for reads. So: drop an invalid one,
 * rebuild, and fail loudly if it is still invalid.
 *
 * Runs outside any transaction (CONCURRENTLY refuses one). lock_timeout is
 * cleared on this session: the build's waits for older transactions are
 * lock waits too, and timing out there would just leave another INVALID index.
 */
export async function create_index_concurrently(
  sql: Sql,
  name: string,
  create_sql: string,
  // A valid index whose definition this returns true for is an older shape
  // of the same name (IF NOT EXISTS would keep it forever): drop + rebuild.
  outdated?: (def: string) => boolean,
): Promise<void> {
  await sql.unsafe(`SET lock_timeout = 0`);
  await sql.unsafe(`SET statement_timeout = 0`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = await index_state(sql, name);
    if (before?.valid && !outdated?.(before.def)) {
      console.log(`  ✔ ${name} already present and valid`);
      return;
    }
    if (before) {
      console.warn(`  ⚠️  ${name} exists but is ${before.valid ? "an outdated definition" : "INVALID"} — dropping and rebuilding`);
      await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    }
    const t0 = Date.now();
    try {
      await sql.unsafe(create_sql);
    } catch (e) {
      console.error(`  ✖ ${name}: ${(e as Error).message}`);
      if (attempt === 2) throw e;
      continue; // loop drops the INVALID leftover and retries once
    }
    const after = await index_state(sql, name);
    if (after?.valid) {
      console.log(`  ✔ ${name} built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
  }
  throw new Error(`${name} is still INVALID after a rebuild — investigate before continuing`);
}

// ── Markers (app_settings) ──────────────────────────────────────────────────
// Ledger scripts refuse to run unless the previous step's marker holds (§9).
// A marker is "on" when its row exists and its value is not null / false / 0 /
// "0" / "off" — so markers written by app code as 1, true or an object all count.

// Canonical key names live with the runtime helpers so app code (which writes
// sync_v2_code_deployed / sync_v2_dualwrite) and the scripts cannot drift.
export const MARKERS = {
  schema: SYNC_V2_KEYS.schema,               // 20261020a: columns exist (value 1)
  triggers: SYNC_V2_KEYS.triggers,           // 20261020c: functions + triggers installed (value 1)
  backfill: SYNC_V2_KEYS.backfill,           // 20261021: every chat numbered ({done, at, rows})
  indexes_post: SYNC_V2_KEYS.indexes_post,   // 20261021b: post-backfill indexes valid (value 1)
  watermarks: SYNC_V2_KEYS.watermarks,       // 20261022: last run ({at, chats, memberships, redis})
  code_deployed: SYNC_V2_KEYS.code_deployed, // written by the R1a build on boot (not by scripts)
  dualwrite: SYNC_V2_KEYS.dualwrite,         // written by the R1a build when apply_receipts dual-writes
  net_beacons: SYNC_V2_KEYS.net_beacons,     // 20261023: net_beacons table exists (value 1)
  media_uploads: SYNC_V2_KEYS.media_uploads, // 20261024: media_uploads table exists (value 1)
} as const;

export async function get_marker(sql: AnySql, key: string): Promise<unknown> {
  const rows = await sql<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = ${key}`;
  return rows.length ? rows[0]!.value : undefined;
}

export function marker_on(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (typeof value === "string" && (value === "" || value === "0" || value.toLowerCase() === "off")) return false;
  return true;
}

export async function set_marker(sql: AnySql, key: string, value: unknown): Promise<void> {
  await sql`
    INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${sql.json(value as any)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** Exit non-zero with a clear message unless `key` is on (or --skip-precondition=key). */
export async function require_marker(sql: AnySql, key: string, why: string): Promise<void> {
  const skip = (opt("skip-precondition") ?? "").split(",");
  if (skip.includes(key)) {
    console.warn(`  ⚠️  precondition ${key} SKIPPED by --skip-precondition`);
    return;
  }
  if (!marker_on(await get_marker(sql, key))) {
    throw new Error(`precondition failed: app_settings.${key} is not set (${why})`);
  }
}

export async function column_exists(sql: AnySql, table: string, column: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}`;
  return rows.length > 0;
}

export async function trigger_comment(sql: AnySql, table: string, name: string): Promise<string | null | undefined> {
  const rows = await sql<{ c: string | null }[]>`
    SELECT obj_description(t.oid, 'pg_trigger') AS c
      FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
     WHERE r.relname = ${table} AND t.tgname = ${name} AND NOT t.tgisinternal`;
  return rows.length ? rows[0]!.c : undefined; // undefined = no such trigger
}

/** Replication lag in seconds from pg_stat_replication (0 when none / not visible). */
export async function replica_lag_s(sql: AnySql): Promise<number> {
  try {
    const rows = await sql<{ lag: number | null }[]>`
      SELECT COALESCE(max(EXTRACT(epoch FROM replay_lag)), 0)::float8 AS lag FROM pg_stat_replication`;
    return Number(rows[0]?.lag ?? 0);
  } catch {
    return 0; // not permitted on this role / not supported: the row throttle still applies
  }
}
