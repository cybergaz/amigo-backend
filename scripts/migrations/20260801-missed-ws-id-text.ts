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
import postgres from "postgres";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

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

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run scripts/migrate.ts
// status` on any box answers what that box still owes.
if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
