// Sync v2 R1a step (e): indexes that need numbered rows (SYNC_V2_PROTOCOL.md §3.1).
//
// Built AFTER the backfill so its full-table rewrite did not have to maintain
// them. All CONCURRENTLY (no write lock), outside any transaction, each
// followed by the validity check (INVALID → drop, rebuild once, else fail).
//
//   uniq_messages_chat_seq   UNIQUE (chat_id, seq) WHERE seq IS NOT NULL   — INV-ORDER-1, seq cursors
//   idx_messages_chat_modchg (chat_id, mod_seq) WHERE mod_seq <> seq        — delta's changed rows only
//   idx_messages_unread      (chat_id, seq) INCLUDE (sender_id, type, expires_at, created_at)
//                            WHERE deleted_at IS NULL AND seq IS NOT NULL   — index-only derived unread
//   idx_chat_members_wm      chat_members (chat_id) WHERE status = 'active'  — mins / receipts
//
// idx_chat_members_wm deliberately carries NO watermark columns (the spec's
// first draft had INCLUDE (user_id, read_seq, delivered_seq, joined_seq)):
// apply_receipts rewrites read_seq / delivered_seq on every read ack and
// delivered flush, and an indexed column makes every one of those a non-HOT
// update — a new entry in all six chat_members indexes per receipt, on RDS
// write I/O (measured on PGlite: 0 of 40k receipt updates HOT with the
// INCLUDE, 39.8k without). amigo_refresh_min_wm runs rarely and can fetch
// the member rows from the heap. An index built with the old INCLUDE shape is
// dropped and rebuilt here.
//
// Queries must repeat these predicates exactly (e.g. `mod_seq <> seq`) for the
// planner to use the partial indexes.
//
// PRECONDITION: no duplicate (chat_id, seq) — checked first, because a
// duplicate makes the UNIQUE build fail and leave an INVALID index. Also
// requires the backfill marker (pass --skip-precondition=sync_v2_backfill to
// build them on a DB that is still backfilling; only the unique index is
// then at risk, and the duplicate check runs anyway).
//
// Writes app_settings.sync_v2_indexes_post = 1. db:push still is NOT a safe
// tool on a live database (drizzle.config.ts): drizzle-kit 0.31 also
// re-creates some pre-existing indexes with a blocking CREATE INDEX. These
// four are declared in the models so push leaves them alone, but always read
// the statements push prints and never confirm a DROP/CREATE INDEX on
// messages / chats / chat_members — write a CONCURRENTLY ledger script.
import { skipIfApplied, recordApplied } from "../lib/migration";
import { MARKERS, create_index_concurrently, open_sql, require_marker, set_marker } from "../lib/sync-v2";

await skipIfApplied(import.meta.path);

const INDEXES: [string, string][] = [
  ["uniq_messages_chat_seq",
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_messages_chat_seq ON messages (chat_id, seq) WHERE seq IS NOT NULL`],
  ["idx_messages_chat_modchg",
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_chat_modchg ON messages (chat_id, mod_seq) WHERE mod_seq <> seq`],
  ["idx_messages_unread",
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_unread ON messages (chat_id, seq)
       INCLUDE (sender_id, type, expires_at, created_at) WHERE deleted_at IS NULL AND seq IS NOT NULL`],
  ["idx_chat_members_wm",
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_members_wm ON chat_members (chat_id) WHERE status = 'active'`],
];

// Older shapes to replace (see the idx_chat_members_wm note above).
const OUTDATED: Record<string, (def: string) => boolean> = {
  idx_chat_members_wm: (def) => /\bINCLUDE\b/i.test(def),
};

const sql = open_sql(1);
let succeeded = false;
try {
  await require_marker(sql, MARKERS.backfill, "run 20261021-sync-v2-seq-backfill to completion first");

  const dups = await sql<{ chat_id: string; seq: string; n: number }[]>`
    SELECT chat_id, seq::text AS seq, count(*)::int AS n FROM messages
     WHERE seq IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 20`;
  if (dups.length > 0) {
    for (const d of dups) console.error(`  duplicate seq: chat=${d.chat_id} seq=${d.seq} rows=${d.n}`);
    throw new Error(`precondition failed: ${dups.length}+ duplicate (chat_id, seq) pairs — investigate before indexing`);
  }

  for (const [name, ddl] of INDEXES) await create_index_concurrently(sql, name, ddl, OUTDATED[name]);

  await set_marker(sql, MARKERS.indexes_post, 1);
  console.log(`✅ sync v2 post-backfill indexes ready. Marker ${MARKERS.indexes_post}=1. Still never db:push on a live DB without reading its statements (drizzle.config.ts).`);
  succeeded = true;
} catch (e) {
  console.error("❌ sync v2 post-backfill indexes failed:", e);
} finally {
  await sql.end();
}

if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
