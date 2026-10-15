// Sync v2 R1a step (d): number every existing message (SYNC_V2_PROTOCOL.md §3.4).
//
// Two-phase per chat (scripts/lib/sync-v2-backfill.ts): lock-free chunked
// numbering, then one short locked step that publishes chats.seq_head. Newest
// chats first (last_msg_at DESC), so active chats are ready earliest.
//
// SAFE ON A LIVE RDS
//   - Row-throttled: --rows-per-s (default 3000) and --chunk (default 2000) rows
//     per transaction. Each chunk is a short UPDATE of seq/mod_seq only; no
//     index covers those columns yet (20261021b builds them AFTER this), so
//     the updates can be HOT and do not churn indexes.
//   - Every 30s: replication lag from pg_stat_replication; pauses while it is
//     above --max-lag-s (default 10). The adaptive throttle also backs off when
//     a chunk itself gets slow. CloudWatch BurstBalance is not read from here
//     (no AWS SDK for it in this repo): watch it, and create the --pause-file
//     (default /tmp/amigo-sync-v2-backfill.pause) to pause the run at once.
//   - Phase 2 holds the chats row for milliseconds, lock_timeout 2s; a busy
//     chat is requeued and retried at the end.
//   - VACUUM (ANALYZE) messages every 10% of rows (--no-vacuum to skip).
//   - Budget ~2x the messages table's storage before starting (§3.4).
//
// RESUMABLE: kill it at any point and run it again; nothing is ever renumbered.
// --max-rows=N stops cleanly after ~N rows (exit 2, ledger NOT recorded).
// Only one run at a time cluster-wide (advisory lock).
//
// PRECONDITIONS: app_settings.sync_v2_code_deployed (the R1a build is live),
// triggers installed (20261020c), idx_messages_chat_created valid (20261020b).
// END: asserts no NULL seq remains, writes app_settings.sync_v2_backfill, and
// prints the follow-ups: 20261021b, then REINDEX CONCURRENTLY off-peak.
import { existsSync } from "node:fs";
import { skipIfApplied, recordApplied } from "../lib/migration";
import {
  MARKERS, flag, index_state, num_opt, open_sql, opt, replica_lag_s, require_marker,
  set_marker, sleep, trigger_comment, is_retryable,
} from "../lib/sync-v2";
import { number_stragglers, phase1, phase2 } from "../lib/sync-v2-backfill";

await skipIfApplied(import.meta.path);

const ROWS_PER_S = num_opt("rows-per-s", 3000);
const CHUNK = num_opt("chunk", 2000);
const MAX_LAG_S = num_opt("max-lag-s", 10);
const MAX_ROWS = num_opt("max-rows", Number.POSITIVE_INFINITY);
const PAUSE_FILE = opt("pause-file") ?? process.env.SYNC_V2_PAUSE_FILE ?? "/tmp/amigo-sync-v2-backfill.pause";
const VACUUM = !flag("no-vacuum");
const LOCK_KEY = "amigo:sync_v2_backfill";

class StopRequested extends Error {}

const sql = open_sql(2);
let exit_code = 1;
let done_rows = 0;
let last_report = Date.now();
let last_lag_check = 0;
let window_start = Date.now();
let window_rows = 0;
let slow_factor = 1;

// Called after every committed chunk: pause, lag guard, throttle, progress.
async function after_chunk(rows: number, chunk_ms: number) {
  done_rows += rows;
  window_rows += rows;
  // A chunk much slower than its size warrants means the DB is struggling:
  // slow down further (back to normal after fast chunks).
  slow_factor = chunk_ms > 2000 ? Math.min(slow_factor * 2, 16) : Math.max(1, slow_factor / 2);
  while (existsSync(PAUSE_FILE)) {
    console.log(`[SEQ] backfill_paused pause_file=${PAUSE_FILE}`);
    await sleep(5000);
  }
  if (Date.now() - last_lag_check > 30_000) {
    last_lag_check = Date.now();
    for (;;) {
      const lag = await replica_lag_s(sql);
      if (lag <= MAX_LAG_S) break;
      console.log(`[SEQ] backfill_paused lag=${lag.toFixed(1)}s > ${MAX_LAG_S}s`);
      await sleep(10_000);
    }
  }
  // Rows/s budget over a sliding window.
  const target_ms = (window_rows / ROWS_PER_S) * 1000 * slow_factor;
  const elapsed = Date.now() - window_start;
  if (target_ms > elapsed) await sleep(target_ms - elapsed);
  if (Date.now() - window_start > 10_000) { window_start = Date.now(); window_rows = 0; }
  if (done_rows >= MAX_ROWS) throw new StopRequested(`--max-rows=${MAX_ROWS} reached`);
}

try {
  // ── Preconditions ──────────────────────────────────────────────────────
  await require_marker(sql, MARKERS.code_deployed, "deploy the R1a build first: it guards the legacy pointer writers");
  await require_marker(sql, MARKERS.triggers, "run 20261020c-sync-v2-triggers first");
  if ((await trigger_comment(sql, "messages", "messages_bi")) === undefined) {
    throw new Error("precondition failed: trigger messages_bi is missing — run 20261020c");
  }
  if (!(await index_state(sql, "idx_messages_chat_created"))?.valid) {
    throw new Error("precondition failed: idx_messages_chat_created missing or INVALID — run 20261020b");
  }

  // ── Single runner (session advisory lock on a reserved connection) ─────
  const lock_conn = await sql.reserve();
  const [{ ok }] = await lock_conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${LOCK_KEY})) AS ok`;
  if (!ok) throw new Error("another sync-v2 backfill holds the lock — refusing to run two at once");

  try {
    const chats = (await sql<{ id: string }[]>`
      SELECT id FROM chats WHERE seq_head IS NULL ORDER BY last_msg_at DESC NULLS LAST, id`).map((r) => r.id);
    const [{ est }] = await sql<{ est: number }[]>`
      SELECT GREATEST(reltuples, 0)::float8 AS est FROM pg_class WHERE relname = 'messages'`;
    const total_est = Math.max(Number(est), 1);
    console.log(`[SEQ] backfill_start chats=${chats.length} est_rows=${Math.round(total_est)} rows_per_s=${ROWS_PER_S} chunk=${CHUNK}`);

    let next_vacuum = 0.1;
    let requeue: string[] = [];
    let chats_done = 0;

    const run_chat = async (chat_id: string): Promise<boolean> => {
      let t = Date.now();
      const p1 = await phase1(sql, chat_id, CHUNK, {
        after_chunk: async (rows) => {
          const ms = Date.now() - t;
          await after_chunk(rows, ms);
          t = Date.now();
        },
      });
      try {
        const p2 = await phase2(sql, chat_id, p1);
        if (p2.status === "done") {
          chats_done++;
          if (p2.late) done_rows += p2.late;
        }
        return true;
      } catch (e) {
        if (is_retryable(e)) {
          console.log(`[SEQ] lock_timeout chat=${chat_id} — requeued`);
          return false;
        }
        throw e;
      }
    };

    for (let pass = 0; pass < 6; pass++) {
      const queue = pass === 0 ? chats : requeue;
      requeue = [];
      if (pass > 0) {
        if (queue.length === 0) break;
        console.log(`[SEQ] backfill_requeue_pass=${pass} chats=${queue.length}`);
        await sleep(2000 * pass);
      }
      for (const chat_id of queue) {
        if (!(await run_chat(chat_id))) requeue.push(chat_id);
        if (Date.now() - last_report > 30_000) {
          const rate = done_rows / ((Date.now() - last_report) / 1000);
          console.log(`[SEQ] backfill_progress rows=${done_rows} chats=${chats_done}/${chats.length} ` +
            `pct=${((done_rows / total_est) * 100).toFixed(1)} rows_per_s~${Math.round(rate)} lag=${(await replica_lag_s(sql)).toFixed(1)}s`);
          last_report = Date.now();
        }
        if (VACUUM && done_rows / total_est >= next_vacuum && next_vacuum < 1) {
          console.log(`[SEQ] backfill_vacuum at ${(next_vacuum * 100).toFixed(0)}%`);
          await sql.unsafe(`VACUUM (ANALYZE) messages`);
          next_vacuum += 0.1;
        }
      }
    }

    if (requeue.length > 0) {
      console.error(`✖ ${requeue.length} chat(s) could not be locked after 6 passes — run again later.`);
      exit_code = 2;
    } else {
      // Straggler sweep + final assertion (one scan of messages).
      const fixed = await number_stragglers(sql, 100_000);
      if (fixed > 0) console.warn(`[SEQ] backfill_stragglers numbered=${fixed}`);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE seq IS NULL`;
      const [{ c }] = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM chats WHERE seq_head IS NULL`;
      if (n > 0 || c > 0) {
        console.error(`✖ incomplete: ${n} message(s) with NULL seq, ${c} chat(s) with NULL seq_head — run again.`);
        exit_code = 2;
      } else {
        await set_marker(sql, MARKERS.backfill, { done: true, at: new Date().toISOString(), rows: done_rows });
        if (VACUUM) await sql.unsafe(`VACUUM (ANALYZE) messages`);
        console.log(`✅ backfill complete: ${done_rows} rows, ${chats_done} chats. Marker ${MARKERS.backfill} set.`);
        // Until uniq_messages_chat_seq exists, deleting a numbered chat's
        // newest message makes the pointer-repair trigger sort the whole chat
        // under its lock (no (chat_id, seq) index): keep that window short.
        console.log(`   NEXT, right away: bun run script:migrate up 20261021b-sync-v2-indexes-post`);
        console.log(`   Next: bun run script:migrate up 20261021b-sync-v2-indexes-post`);
        console.log(`   Then, off-peak: REINDEX INDEX CONCURRENTLY each pre-existing messages index`);
        console.log(`   (SELECT indexrelid::regclass FROM pg_index WHERE indrelid = 'messages'::regclass).`);
        exit_code = 0;
      }
    }
  } finally {
    await lock_conn`SELECT pg_advisory_unlock(hashtext(${LOCK_KEY}))`.catch(() => {});
    lock_conn.release();
  }
} catch (e) {
  if (e instanceof StopRequested) {
    console.log(`⏸  stopped: ${e.message}. ${done_rows} rows numbered this run; run again to resume.`);
    exit_code = 2;
  } else {
    console.error("❌ sync v2 backfill failed:", e);
    exit_code = 1;
  }
} finally {
  await sql.end();
}

if (exit_code === 0) await recordApplied(import.meta.path);
process.exit(exit_code);
