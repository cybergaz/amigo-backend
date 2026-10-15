import { defineConfig } from "drizzle-kit";
import "dotenv/config";

if (!process.env.DB_URL) {
  throw new Error("DB_URL is not set in .env");
}

// RULE (Sync v2, SYNC_V2_PROTOCOL.md §3.1):
//   1. Never run db:push / db:genpush on an environment until
//      scripts/migrations/20261021b-sync-v2-indexes-post.ts is applied there
//      (app_settings.sync_v2_indexes_post = 1). The models declare the sync
//      v2 columns and indexes, but those are built by the ledger scripts —
//      CONCURRENTLY, after the backfill — and the clock lives in triggers
//      drizzle does not know about. A push before then would build the
//      indexes with a blocking CREATE INDEX on the live messages table, and
//      set chats.seq_head DEFAULT 0 before the triggers exist.
//   2. Even after it, push is not a safe tool on a database with traffic.
//      The sync v2 indexes are declared so that drizzle-kit 0.31 sees no
//      difference (INCLUDE columns appear as trailing key columns to its
//      introspection), but it still re-creates some pre-existing indexes
//      (e.g. the `desc` ones on chats / messages) with DROP + a blocking
//      CREATE INDEX. Read every statement push prints; never confirm a
//      DROP/CREATE INDEX on messages / chats / chat_members — write a ledger
//      script with CREATE INDEX CONCURRENTLY instead.
// Check with: bun run script:migrate status.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/models/**/*.ts",
  dbCredentials: {
    url: process.env.DB_URL!,
  },
});
