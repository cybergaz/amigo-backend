// One-off applier for the admin_pin_events table, bypassing drizzle-kit migrate
// (its journal is out of sync with this push-built DB). The SQL is idempotent, so
// this is safe to re-run. bun auto-loads .env, so DB_URL is available.
//
//   bun run scripts/migrate.ts up 20260728-admin-pin-events
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const sql = postgres(url);
try {
  const ddl = readFileSync("drizzle/manual_add_admin_pin_events.sql", "utf8");
  await sql.unsafe(ddl);
  console.log("✅ admin_pin_events applied (idempotent — safe to re-run).");
} catch (e) {
  console.error("❌ Failed to apply admin_pin_events:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run scripts/migrate.ts
// status` on any box answers what that box still owes.
if (process.exitCode !== 1) await recordApplied(import.meta.path);
process.exit(process.exitCode === 1 ? 1 : 0);
