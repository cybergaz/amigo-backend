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
//
// Two-stage archive: on a successful run the script moves itself one stage
// along scripts/ → scripts/applied-dev/ → scripts/applied-archive/, so after
// the dev run it stays runnable for prod:
//
//   dev:   bun run scripts/apply-chat-cleared-at.ts
//   prod:  bun run scripts/applied-dev/apply-chat-cleared-at.ts
import postgres from "postgres";
import { mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

// Self-archive one stage along on success. The stage is inferred from where
// this file lives, so the same script runs unchanged on dev and prod:
//   scripts/             → applied-dev/      (dev run done, prod pending)
//   scripts/applied-dev/ → applied-archive/  (prod run done, fully applied)
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
