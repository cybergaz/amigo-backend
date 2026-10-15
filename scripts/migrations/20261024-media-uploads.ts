// M track: chunked resumable uploads (SYNC_V2_PROTOCOL.md §14.11, §14.17
// "ledger scripts media_uploads"). Purely additive.
//
// INDEPENDENT OF THE SYNC V2 LEDGER ORDER: it needs no sync v2 column,
// trigger or marker, and nothing in 20261020a…20261023 needs it. It can run
// before, between or after them.
//
// SAFE ON A LIVE RDS: a NEW, empty table; its two partial indexes are built
// on an empty table, so a plain CREATE INDEX costs nothing. Each statement
// runs with lock_timeout + retry (scripts/lib/sync-v2.ts ddl).
//
// SAFE FOR OLD BUILDS: nothing before this build names the table. The new
// build serves /api/media/upload/{init,:id,…} only when
// app_settings.sync_v2_chunked_upload is on AND the marker this script
// writes (sync_v2_media_uploads = 1) is set; until then those endpoints
// answer 404 and the app keeps the single-request upload route (unchanged).
//
// Matches src/models/media-upload.model.ts (drizzle's default names), so a
// later db:push sees no drift. Re-runnable: IF NOT EXISTS everywhere.
import { skipIfApplied, recordApplied } from "../lib/migration";
import { ddl, open_sql, set_marker, MARKERS } from "../lib/sync-v2";

await skipIfApplied(import.meta.path);

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS media_uploads (
     id uuid PRIMARY KEY NOT NULL,
     user_id uuid NOT NULL,
     key text NOT NULL,
     mime text NOT NULL,
     category text NOT NULL,
     file_name text,
     size bigint NOT NULL,
     chunk_size integer NOT NULL,
     sha256 text,
     s3_upload_id text NOT NULL,
     received_bytes bigint NOT NULL DEFAULT 0,
     assembled_bytes bigint NOT NULL DEFAULT 0,
     parts jsonb NOT NULL DEFAULT '[]'::jsonb,
     chunks jsonb NOT NULL DEFAULT '[]'::jsonb,
     state text NOT NULL DEFAULT 'open',
     url text,
     thumb_key text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     completed_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS idx_media_uploads_user_open ON media_uploads USING btree (user_id) WHERE state = 'open'`,
  `CREATE INDEX IF NOT EXISTS idx_media_uploads_expires_open ON media_uploads USING btree (expires_at) WHERE state = 'open'`,
];

const sql = open_sql(1);
let succeeded = false;
try {
  for (const s of STATEMENTS) await ddl(sql, s);
  await set_marker(sql, MARKERS.media_uploads, 1);
  console.log(`✅ media_uploads applied (idempotent — safe to re-run). Marker ${MARKERS.media_uploads}=1.`);
  succeeded = true;
} catch (e) {
  console.error("❌ media_uploads failed:", e);
} finally {
  await sql.end();
}

if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
