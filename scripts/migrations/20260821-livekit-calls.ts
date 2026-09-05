
// One-off applier for the livekit_calls table, bypassing drizzle-kit migrate
// (its journal is out of sync with this push-built DB). The SQL is idempotent,
// so this is safe to re-run. bun auto-loads .env, so DB_URL is available.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const sql = postgres(url);
let succeeded = false;
try {
  const ddl = readFileSync("drizzle/manual_add_livekit_calls.sql", "utf8");
  await sql.unsafe(ddl);

  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM information_schema.columns
    WHERE table_name = 'livekit_calls'
  `;
  console.log(`✅ livekit_calls applied — ${count} columns (idempotent — safe to re-run).`);
  succeeded = true;
} catch (e) {
  console.error("❌ Failed to apply livekit_calls:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run scripts/migrate.ts
// status` on any box answers what that box still owes.
if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
