// =============================================================================
// Chunked resumable uploads: production wiring (SYNC_V2_PROTOCOL.md §14.11)
// =============================================================================
// The engine (chunked-upload-core.ts) with the real dependencies:
//   ledger  media_uploads in PG (chunked-upload-pg.ts) on the app's pg_client;
//           the per-upload lock is run_pg_singleton_sql('upload:'+id)
//   store   S3 through s3.service make_s3_upload_store()
// plus the daily GC (run_daily('upload_gc')): aborts open uploads past
// expires_at in batches (S3 AbortMultipartUpload + staging deletes) and
// deletes complete / aborted rows after 7 days. The GC keys on the table's
// marker only, so turning the endpoint flag off still cleans up.
// =============================================================================
import { pg_client } from "@/config/db";
import { LOCK_NS_JOBS, run_daily, run_pg_singleton_sql } from "@/cluster/jobs";
import { is_draining, track } from "@/cluster/lifecycle";
import { sync_v2_flags } from "@/services/app-settings.service";
import { chunked_upload_active } from "@/services/sync/flags-core";
import { make_s3_upload_store } from "@/services/s3.service";
import { make_chunked_upload, Semaphore } from "./chunked-upload-core";
import { count_open_sql, pg_upload_ledger, type RunLocked } from "./chunked-upload-pg";

// Process-wide memory bound: ≤ 32 chunk bodies (≤ 1 MiB each) and ≤ 2 parts
// being assembled (≤ ~6 MiB each) per worker, ~44 MiB worst case — against
// up to 3 × 95 MiB that the single-request route (upload-gate.ts) admits.
// The 2 assembly permits also cover complete's S3 step, so at most 2 of the
// worker's PG_POOL_MAX (10) connections ever wait on S3 inside the
// per-upload lock's transaction.
const CHUNK_PERMITS = 32;
const ASSEMBLY_PERMITS = 2;
const GC_CHECK_MS = 10 * 60_000;

// The per-upload lock: run_pg_singleton_sql('upload:'+id) — the label keeps
// the [JOBS] counter names bounded (one name for every upload, not one each).
const run_upload_locked: RunLocked = (name, fn) => run_pg_singleton_sql(name, fn, { label: "upload_lock" });

export const chunked_upload = make_chunked_upload({
  ledger: pg_upload_ledger(pg_client, run_upload_locked, LOCK_NS_JOBS),
  store: make_s3_upload_store(),
  chunk_sem: new Semaphore(CHUNK_PERMITS),
  assembly_sem: new Semaphore(ASSEMBLY_PERMITS),
  should_stop: is_draining,
});

export const chunked_upload_enabled = (): boolean => chunked_upload_active(sync_v2_flags());

let gc_running: Promise<unknown> | null = null;

/** Boot: the daily upload GC (idle until the 20261024 marker is set). */
export const start_upload_gc = (): (() => Promise<void>) => {
  const timer = setInterval(() => {
    if (gc_running || is_draining() || !sync_v2_flags().markers.media_uploads) return;
    gc_running = track(run_daily("upload_gc", chunked_upload.gc_once)).finally(() => {
      gc_running = null;
    });
  }, GC_CHECK_MS);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    if (gc_running) await gc_running.catch(() => undefined);
  };
};

/** For GET /admin/net-health: switch state, this worker's permits, open uploads. */
export const chunked_upload_stats = async () => {
  const f = sync_v2_flags();
  const open = f.markers.media_uploads ? await count_open_sql(pg_client).catch(() => null) : null;
  return {
    enabled: chunked_upload_active(f),
    flag: f.chunked_upload,
    table: f.markers.media_uploads,
    open,
    ...chunked_upload.stats(),
  };
};
