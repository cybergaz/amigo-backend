// One-off applier for the auth_devices table, bypassing drizzle-kit migrate
// (whose __drizzle_migrations journal is out of sync with this push-built DB, so
// `migrate` tries to re-CREATE existing tables like "calls" and fails).
//
// The SQL is idempotent (CREATE TABLE/INDEX IF NOT EXISTS + guarded FK), so this
// is safe to re-run. bun auto-loads .env, so DB_URL is available.
//
//   bun run scripts/migrate.ts up 20260714-auth-devices
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const sql = postgres(url);
try {
  const ddl = readFileSync("drizzle/manual_add_auth_devices.sql", "utf8");
  await sql.unsafe(ddl); // multi-statement, no params → simple-query protocol
  console.log("✅ auth_devices applied (idempotent — safe to re-run).");
} catch (e) {
  console.error("❌ Failed to apply auth_devices:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run scripts/migrate.ts
// status` on any box answers what that box still owes.
if (process.exitCode !== 1) await recordApplied(import.meta.path);
process.exit(process.exitCode === 1 ? 1 : 0);
