// One-off applier: add chat_members.cleared_at for the group "Clear chat"
// feature (delete-for-me at chat scope, membership preserved).
//
// A single per-member watermark instead of per-message tombstones: every read
// path (get_conversation_history, get_messages_around, get_chat_list's
// last-message / pinned enrichment) floors on it, the same way they already
// floor on joined_at. Per-message tombstones — what the DM delete-for-me path
// uses — would mean one message_info row per message PER MEMBER, which doesn't
// scale for a 500-member group with tens of thousands of messages.
//
// Idempotent — safe to re-run (ADD COLUMN IF NOT EXISTS).
// Backward-compatible — the column is nullable with no default, so the running
// backend is unaffected and this can be applied BEFORE the new build ships.
import postgres from "postgres";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const sql = postgres(url);
let succeeded = false;
try {
  const existing = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'chat_members' AND column_name = 'cleared_at'
  `;
  if (existing.length > 0) {
    console.log("✅ chat_members.cleared_at already exists — nothing to do.");
  } else {
    await sql.unsafe(`
      ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
    `);
    console.log("✅ chat_members.cleared_at added.");
  }
  succeeded = true;
} catch (e) {
  console.error("❌ Failed to add chat_members.cleared_at:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run scripts/migrate.ts
// status` on any box answers what that box still owes.
if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
