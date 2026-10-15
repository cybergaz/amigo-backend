// Sync v2 R1a step (a, second half): the pre-backfill index
// (SYNC_V2_PROTOCOL.md §3.1).
//
//   idx_messages_chat_created ON messages(chat_id, created_at, id)   -- full, no predicate
//
// WHY: the only chat_id index on messages today is the partial
// idx_messages_chat_id_sent_at_undeleted (deleted rows excluded). Every
// per-chat backfill pass and every joined/cleared floor lookup covers ALL rows,
// deleted included, so without this index each one is a table scan.
//
// Built CONCURRENTLY (no write lock on messages), outside any transaction,
// then checked for validity: an INVALID leftover is dropped and rebuilt, and
// the script fails loudly if it is still invalid. Re-runnable.
import { skipIfApplied, recordApplied } from "../lib/migration";
import { column_exists, create_index_concurrently, open_sql } from "../lib/sync-v2";

await skipIfApplied(import.meta.path);

const sql = open_sql(1);
let succeeded = false;
try {
  if (!(await column_exists(sql, "messages", "seq"))) {
    throw new Error("precondition failed: run 20261020a-sync-v2-columns first");
  }
  await create_index_concurrently(
    sql,
    "idx_messages_chat_created",
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_chat_created ON messages (chat_id, created_at, id)`,
  );
  console.log("✅ sync v2 pre-backfill index ready.");
  succeeded = true;
} catch (e) {
  console.error("❌ sync v2 pre-backfill index failed:", e);
} finally {
  await sql.end();
}

if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
