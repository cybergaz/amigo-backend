// One-off applier: broadcast lists (WhatsApp-style) — see BROADCAST_LISTS.md.
//
// A broadcast list IS a chat row (chats.type = 'broadcast'; the column is a
// plain varchar, so no change there) whose only chat_members row is the owner.
// The recipients and the per-recipient message copies get two new tables:
//
//   broadcast_recipients      (list_id, user_id)            — who is on a list
//   broadcast_message_copies  (broadcast_msg_id, recipient) — which DM + which
//                             copy id each broadcast message landed as
//
// Purely additive: two new tables + indexes, nothing existing is altered. Safe
// to apply BEFORE the new backend build ships (the running build never touches
// these tables), and the new build must not ship before it.
//
// Idempotent — CREATE TABLE / INDEX IF NOT EXISTS, all in one transaction.
// Constraint names follow drizzle's defaults (as manual_add_livekit_calls.sql
// does) so `drizzle-kit push` sees no drift against src/models/broadcast.model.ts.
import postgres from "postgres";
import { skipIfApplied, recordApplied } from "../lib/migration";

// Already run against this environment's DB? Nothing to do. (--force overrides.)
await skipIfApplied(import.meta.path);

const url = process.env.DB_URL;
if (!url) throw new Error("DB_URL is not set — check your .env");

const DDL = `
CREATE TABLE IF NOT EXISTS "broadcast_recipients" (
  "list_id"  uuid NOT NULL,
  "user_id"  uuid NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "broadcast_recipients_list_id_user_id_pk" PRIMARY KEY ("list_id", "user_id"),
  CONSTRAINT "broadcast_recipients_list_id_chats_id_fk"
    FOREIGN KEY ("list_id") REFERENCES "public"."chats"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "broadcast_recipients_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Backs the ON DELETE CASCADE from users (small table, cheap index).
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipients_user_id"
  ON "broadcast_recipients" USING btree ("user_id");

-- One row per (broadcast message, recipient): which DM + which copy id.
CREATE TABLE IF NOT EXISTS "broadcast_message_copies" (
  "broadcast_msg_id" uuid NOT NULL,
  "recipient_id"     uuid NOT NULL,
  "chat_id"          uuid NOT NULL,
  "message_id"       uuid NOT NULL,
  CONSTRAINT "broadcast_message_copies_broadcast_msg_id_recipient_id_pk"
    PRIMARY KEY ("broadcast_msg_id", "recipient_id"),
  CONSTRAINT "broadcast_message_copies_broadcast_msg_id_messages_id_fk"
    FOREIGN KEY ("broadcast_msg_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "broadcast_message_copies_recipient_id_users_id_fk"
    FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "broadcast_message_copies_chat_id_chats_id_fk"
    FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "broadcast_message_copies_message_id_messages_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_bmc_message_id"
  ON "broadcast_message_copies" USING btree ("message_id");
`;

const sql = postgres(url);
let succeeded = false;
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(DDL);
  });

  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('broadcast_recipients', 'broadcast_message_copies')
  `;
  if (tables.length !== 2) {
    throw new Error(`expected 2 broadcast tables, found ${tables.length}`);
  }
  console.log("✅ broadcast_recipients + broadcast_message_copies applied (idempotent — safe to re-run).");
  succeeded = true;
} catch (e) {
  console.error("❌ Failed to apply broadcast-list tables:", e);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// Record the run in THIS database's `script_migrations` ledger — the only place
// applied-vs-pending lives. Nothing on disk moves; `bun run script:migrate
// status` on any box answers what that box still owes.
if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
