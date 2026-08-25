
// One-off applier for the livekit_calls table, bypassing drizzle-kit migrate
// (its journal is out of sync with this push-built DB). The SQL is idempotent,
// so this is safe to re-run. bun auto-loads .env, so DB_URL is available.
//
// Two-stage archive: on a successful run the script moves itself one stage
// along scripts/ → scripts/applied-dev/ → scripts/applied-archive/, so after
// the dev run it stays runnable for prod:
//
//   dev:   bun run scripts/apply-livekit-calls.ts
//   prod:  bun run scripts/applied-dev/apply-livekit-calls.ts
import postgres from "postgres";
import { readFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

// Self-archive one stage along on success. The stage is inferred from where
// this file lives, so the same script runs unchanged on dev and prod:
//   scripts/             → applied-dev/     (dev run done, prod pending)
//   scripts/applied-dev/ → applied-archive/ (prod run done, fully applied)
if (succeeded) {
  try {
    const self = import.meta.path;
    const dir = dirname(self);
    const target = basename(dir) === "applied-dev"
      ? join(dir, "..", "applied-archive", basename(self))
      : join(dir, "applied-dev", basename(self));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(self, target);
    console.log(`📦 Archived to ${target}`);
  } catch (e) {
    console.warn("⚠️ Could not self-archive (harmless):", e);
  }
}