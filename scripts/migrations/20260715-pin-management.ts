// One-off applier for must_reset_pin (users) + the pin_reset_requests table,
// bypassing drizzle-kit migrate (its journal is out of sync with this push-built
// DB). The SQL is idempotent, so this is safe to re-run. bun auto-loads .env, so
// DB_URL is available.
//
//   bun run scripts/migrate.ts up 20260715-pin-management
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const sql = postgres(url);
let applied = false;
try {
  const ddl = readFileSync("drizzle/manual_add_pin_management.sql", "utf8");
  await sql.unsafe(ddl);
  console.log("✅ pin-management (must_reset_pin + pin_reset_requests) applied (idempotent — safe to re-run).");
  applied = true;
} catch (e) {
  console.error("❌ Failed to apply pin-management:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run scripts/migrate.ts
// status` on any box answers what that box still owes.
if (applied) await recordApplied(import.meta.path);
process.exit(applied ? 0 : 1);
