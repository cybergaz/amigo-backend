// One-off applier for the admin_pin_events table, bypassing drizzle-kit migrate
// (its journal is out of sync with this push-built DB). The SQL is idempotent, so
// this is safe to re-run. bun auto-loads .env, so DB_URL is available.
//
//   bun run scripts/apply-admin-pin-events.ts
import postgres from "postgres";
import { readFileSync } from "node:fs";

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
