import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { INSTANCE_ID, REDIS_NS } from '@/cluster/identity';

// =============================================================================
// Postgres client (SYNC_V2 §3.15 / §13.11)
// =============================================================================
// The client is built explicitly instead of drizzle(url) so the pool is
// bounded and tuned on purpose. drizzle(url) used postgres-js defaults:
// max 10, no idle timeout, 30 s connect timeout — PG_POOL_MAX defaults to 10
// so the pool size is unchanged unless someone sets it.
//
// Importing this module never exits the process any more. A failed first
// SELECT 1 used to process.exit(1), so an RDS blip during a restart became a
// crash loop. server.ts boot() calls wait_for_db() and retries instead.

if (!process.env.DB_URL) {
  throw new Error("DATABASE_URL is not defined in environment variables");
}
const DB_URL = process.env.DB_URL;

// Transaction-mode poolers (dev's Neon "-pooler", PgBouncer) cannot keep
// prepared statements across transactions and reject unknown startup
// parameters such as lock_timeout. Prod is direct RDS (V17).
const IS_POOLER = /pooler|pgbouncer/i.test(DB_URL);

const int_env = (name: string, fallback: number, min: number, max: number): number => {
  const raw = parseInt(process.env[name] || "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
};

const PG_POOL_MAX = int_env("PG_POOL_MAX", 10, 1, 100);
// A statement waiting more than this for a row/table lock fails instead of
// pinning a pool connection (a blocked send then fails into the client's GC
// retry). 0 disables. statement_timeout stays unset (spec decision).
const PG_LOCK_TIMEOUT_MS = int_env("PG_LOCK_TIMEOUT_MS", 5000, 0, 600_000);

const connection: Record<string, string | number> = {
  // Lets pg_stat_activity be grouped per worker (§13.15).
  application_name: `amigo-${REDIS_NS}-${INSTANCE_ID}`,
};
if (PG_LOCK_TIMEOUT_MS > 0 && !IS_POOLER) {
  connection.lock_timeout = PG_LOCK_TIMEOUT_MS;
}

const pg_client = postgres(DB_URL, {
  max: PG_POOL_MAX,
  idle_timeout: 30,
  max_lifetime: 1800,
  connect_timeout: 10,
  prepare: !IS_POOLER,
  connection,
});

const db = drizzle(pg_client);

// One SELECT 1 bounded by `ms`. Used by readyz and the startup retry.
const db_ping = async (ms = 1000): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pg_client`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`SELECT 1 exceeded ${ms}ms`)), ms);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const DB_RETRY_BACKOFF_MS = [500, 1000, 2000, 5000];

// Retry SELECT 1 with backoff 0.5 → 1 → 2 → 5 s (capped) until it works or
// `should_stop()` says the process is shutting down. Never exits the process.
const wait_for_db = async (should_stop: () => boolean = () => false): Promise<boolean> => {
  for (let attempt = 0; !should_stop(); attempt++) {
    try {
      await pg_client`SELECT 1`;
      console.log(
        `🛢️  DB -> Connected (pool max ${PG_POOL_MAX}, prepare ${!IS_POOLER}, lock_timeout ${connection.lock_timeout ?? "off"})`,
      );
      return true;
    } catch (err: any) {
      const wait = DB_RETRY_BACKOFF_MS[Math.min(attempt, DB_RETRY_BACKOFF_MS.length - 1)];
      console.error(`🛢️  DB -> Connection failed (attempt ${attempt + 1}), retrying in ${wait}ms:`, err?.message ?? err);
      await Bun.sleep(wait);
    }
  }
  return false;
};

// Drain: let in-flight queries finish (≤ timeout_s), then close sockets.
const close_db = async (timeout_s = 3): Promise<void> => {
  try {
    await pg_client.end({ timeout: timeout_s });
  } catch (err) {
    console.error("🛢️  DB -> close failed:", err);
  }
};

export default db;
export { pg_client, db_ping, wait_for_db, close_db, PG_POOL_MAX };
