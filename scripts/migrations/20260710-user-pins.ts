// One-off applier for the user PIN columns (password_pin_hash, admin_pin_hash),
// bypassing drizzle-kit migrate (whose __drizzle_migrations journal is out of sync
// with this push-built DB, so `migrate` tries to re-CREATE existing tables and fails).
//
// The SQL is idempotent (ADD COLUMN IF NOT EXISTS), so this is safe to re-run.
// bun auto-loads .env, so DB_URL is available.
//
//   bun run scripts/migrate.ts up 20260710-user-pins
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const sql = postgres(url);
try {
  const ddl = readFileSync("drizzle/manual_add_user_pins.sql", "utf8");
  await sql.unsafe(ddl); // multi-statement, no params → simple-query protocol
  console.log("✅ user PIN columns applied (idempotent — safe to re-run).");
} catch (e) {
  console.error("❌ Failed to apply user PIN columns:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run scripts/migrate.ts
// status` on any box answers what that box still owes.
if (process.exitCode !== 1) await recordApplied(import.meta.path);
process.exit(process.exitCode === 1 ? 1 : 0);
