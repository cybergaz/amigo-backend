// One-off applier for must_reset_pin (users) + the pin_reset_requests table,
// bypassing drizzle-kit migrate (its journal is out of sync with this push-built
// DB). The SQL is idempotent, so this is safe to re-run. bun auto-loads .env, so
// DB_URL is available.
//
//   bun run scripts/apply-pin-management.ts
//
// On success this script self-archives into scripts/applied-scripts/ (one-time
// script convention).
import postgres from "postgres";
import { readFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

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

// One-time script: move it out of the active scripts dir once it has applied, so
// it can't be re-run by mistake. A failed move is only a warning — the DB work
// already succeeded.
if (applied) {
  try {
    mkdirSync("scripts/applied-scripts", { recursive: true });
    renameSync(import.meta.path, join("scripts", "applied-scripts", basename(import.meta.path)));
    console.log("📦 archived to scripts/applied-scripts/");
  } catch (e) {
    console.warn("⚠️  applied OK but could not self-archive:", e);
  }
}
