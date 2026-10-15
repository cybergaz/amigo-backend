// Sync v2 R1a step (a): columns + the receipt-mins side table
// (SYNC_V2_PROTOCOL.md §3.1, §9 row 2). Purely additive.
//
// SAFE ON A LIVE RDS: every ADD COLUMN is metadata-only on PG >= 11 (constant
// defaults are stored in the catalog, no table rewrite). Each statement runs in
// its own transaction with lock_timeout 3s and up to 5 tries, so a busy table
// costs at most a few seconds of queueing, never a long stall.
//
// SAFE FOR OLD BUILDS: the running backend never names these columns; new
// ones are NULL / 0 / false. Old apps see nothing.
//
// NOT HERE, ON PURPOSE: `chats.seq_head DEFAULT 0` ("new chats are born
// numbered"). It is installed by 20261020c together with the triggers. Set
// here, every chat created between this step and the triggers would get
// seq_head = 0 while its messages get no seq — the backfill (which only picks
// seq_head IS NULL) would then skip it and the chat would carry unnumbered rows
// forever.
//
// Re-runnable: IF NOT EXISTS everywhere. Writes the marker
// app_settings.sync_v2_schema = 1, which the code-deploy step and 20261020c
// check. RULE: never db:push / db:genpush on an environment before 20261021b
// (and after it only reading every statement push prints: drizzle.config.ts).
import { skipIfApplied, recordApplied } from "../lib/migration";
import { ddl, open_sql, set_marker, MARKERS } from "../lib/sync-v2";

await skipIfApplied(import.meta.path);

const STATEMENTS = [
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq bigint`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS mod_seq bigint`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta jsonb`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS seq_head bigint`,          // NULL = not backfilled
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_seq bigint`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS pin_seq bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS settings_seq bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE chats ADD COLUMN IF NOT EXISTS roster_seq bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS read_seq bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS delivered_seq bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS joined_seq bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS cleared_seq bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS left_seq bigint`,
  // When the member left 'active' (chat_members_seq trigger). The spec's
  // left_seq = "max seq created at/before the leave" needs it: a leave of a
  // chat the backfill has not numbered yet can only be resolved afterwards.
  `ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS left_at timestamptz`,
  `ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS has_hidden boolean NOT NULL DEFAULT false`, // any delete-for-me in chat
  `ALTER TABLE missed_ws_messages ADD COLUMN IF NOT EXISTS entry_v text`,                       // poll v2 entry version
  // Constraint names follow drizzle's defaults so drizzle-kit sees no drift
  // against chat_receipt_mins_model (src/models/chat.model.ts).
  `CREATE TABLE IF NOT EXISTS chat_receipt_mins (
     chat_id uuid PRIMARY KEY NOT NULL,
     r_min1 bigint NOT NULL DEFAULT 0, r_min1_user uuid, r_min2 bigint,
     d_min1 bigint NOT NULL DEFAULT 0, d_min1_user uuid, d_min2 bigint,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT chat_receipt_mins_chat_id_chats_id_fk
       FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE ON UPDATE NO ACTION)`,
];

const sql = open_sql(1);
let succeeded = false;
try {
  for (const s of STATEMENTS) await ddl(sql, s);
  await set_marker(sql, MARKERS.schema, 1);
  console.log(`✅ sync v2 columns applied (idempotent — safe to re-run). Marker ${MARKERS.schema}=1.`);
  succeeded = true;
} catch (e) {
  console.error("❌ sync v2 columns failed:", e);
} finally {
  await sql.end();
}

if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
