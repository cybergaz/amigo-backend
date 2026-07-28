// One-off applier: migrate missed_ws_messages.id from uuid → text.
//
// The drain-lifecycle change keys pending entries by a deterministic
// correlation id ("{user_id}:{event_type}:{natural_id}") so delivery acks can
// target and delete them. Those keys are not UUIDs, and the uuid-typed id
// column rejected every Tier-3 write/delete with 22P02 ("invalid input syntax
// for type uuid"). Old rows (random UUIDv7 ids) cast losslessly to text and
// keep draining as before.
//
// Idempotent — safe to re-run (no-ops when the column is already text).
// Backward-compatible — old code writes uuid *strings*, which a text column
// accepts, so this can run BEFORE the new backend is deployed.
//
// Two-stage archive: on a successful run the script moves itself one stage
// along scripts/ → scripts/applied-dev/ → scripts/applied-archive/, so after
// the dev run it stays runnable for prod:
//
//   dev:   bun run scripts/apply-missed-ws-id-text.ts
//   prod:  bun run scripts/applied-dev/apply-missed-ws-id-text.ts
import postgres from "postgres";
import { mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const sql = postgres(url);
let succeeded = false;
try {
  const [{ data_type }] = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'missed_ws_messages' AND column_name = 'id'
  `;
  if (data_type === "text") {
    console.log("✅ missed_ws_messages.id is already text — nothing to do.");
  } else {
    await sql.unsafe(`
      ALTER TABLE missed_ws_messages ALTER COLUMN id DROP DEFAULT;
      ALTER TABLE missed_ws_messages ALTER COLUMN id TYPE text USING id::text;
    `);
    console.log("✅ missed_ws_messages.id migrated uuid → text.");
  }
  succeeded = true;
} catch (e) {
  console.error("❌ Failed to migrate missed_ws_messages.id:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Self-archive one stage along on success. The stage is inferred from where
// this file lives, so the same script runs unchanged on dev and prod:
//   scripts/            → applied-dev/     (dev run done, prod pending)
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
