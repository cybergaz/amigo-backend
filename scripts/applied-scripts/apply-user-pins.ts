// One-off applier for the user PIN columns (password_pin_hash, admin_pin_hash),
// bypassing drizzle-kit migrate (whose __drizzle_migrations journal is out of sync
// with this push-built DB, so `migrate` tries to re-CREATE existing tables and fails).
//
// The SQL is idempotent (ADD COLUMN IF NOT EXISTS), so this is safe to re-run.
// bun auto-loads .env, so DB_URL is available.
//
//   bun run scripts/apply-user-pins.ts
import postgres from "postgres";
import { readFileSync } from "node:fs";

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
