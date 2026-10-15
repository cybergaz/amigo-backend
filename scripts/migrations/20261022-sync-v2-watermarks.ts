// Sync v2 R1a step (f): initial per-member watermarks and floors
// (SYNC_V2_PROTOCOL.md §3.4 "20261022", §3.7). Logic: scripts/lib/sync-v2-watermarks.ts.
//
// Reads Redis itself (user_receipts / user_unread, READ-ONLY) so it does not
// depend on `flush:migrate` draining under live traffic. A missing
// user_unread field means UNKNOWN (the id cursor decides), never 0.
// --no-redis runs on PG cursors only (dev / tests); it logs that it did.
//
// SAFE ON A LIVE RDS: one short transaction per chat (lock_timeout 3s,
// requeued on timeout), throttled by --rows-per-s membership rows (default
// 2000). Every write is GREATEST / COALESCE, so it is safe next to the live
// dual-write apply_receipts and safe to re-run: RE-RUN IT IMMEDIATELY BEFORE
// THE R1b FLIP (`bun run script:migrate up 20261022 --force`).
// Resume a stopped run with --from=<chat_id> (chats go in id order).
//
// PRECONDITIONS: app_settings.sync_v2_dualwrite (the R1a build writes PG
// watermarks from every legacy input), app_settings.sync_v2_backfill.
import Redis from "ioredis";
import { skipIfApplied, recordApplied } from "../lib/migration";
import {
  MARKERS, flag, is_retryable, num_opt, opt, open_sql, require_marker, set_marker, sleep,
} from "../lib/sync-v2";
import { NO_REDIS, ioredis_reader, mark_has_hidden, watermark_chat, type RedisReceiptReader } from "../lib/sync-v2-watermarks";

await skipIfApplied(import.meta.path);

const ROWS_PER_S = num_opt("rows-per-s", 2000);
const BATCH = 500;

const sql = open_sql(2);
let redis: Redis | null = null;
let exit_code = 1;
try {
  await require_marker(sql, MARKERS.dualwrite, "deploy the R1a build with dual-write apply_receipts first");
  await require_marker(sql, MARKERS.backfill, "run 20261021-sync-v2-seq-backfill to completion first");

  let reader: RedisReceiptReader = NO_REDIS;
  if (flag("no-redis")) {
    console.warn("  ⚠️  --no-redis: Redis receipts and unread counts are NOT consulted (PG cursors only)");
  } else {
    if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set (or pass --no-redis)");
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
    await redis.connect();
    reader = ioredis_reader(redis);
  }

  const hidden = await mark_has_hidden(sql);
  console.log(`  ✔ has_hidden set on ${hidden} membership(s)`);

  let cursor = opt("from") ?? "00000000-0000-0000-0000-000000000000";
  let chats = 0, members = 0, requeued: string[] = [];
  const t_start = Date.now();
  let window_start = Date.now(), window_rows = 0;

  const one = async (chat_id: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await watermark_chat(sql, chat_id, reader);
        if (r.status === "done") { chats++; members += r.members; window_rows += r.members; }
        return true;
      } catch (e) {
        if (!is_retryable(e) || attempt >= 3) {
          if (is_retryable(e)) return false;
          throw e;
        }
        await sleep(500 * attempt);
      }
    }
  };

  for (;;) {
    const page = await sql<{ id: string }[]>`
      SELECT id FROM chats WHERE id > ${cursor} AND seq_head IS NOT NULL ORDER BY id LIMIT ${BATCH}`;
    if (page.length === 0) break;
    for (const { id } of page) {
      if (!(await one(id))) requeued.push(id);
      const target_ms = (window_rows / ROWS_PER_S) * 1000;
      const elapsed = Date.now() - window_start;
      if (target_ms > elapsed) await sleep(target_ms - elapsed);
      if (Date.now() - window_start > 10_000) { window_start = Date.now(); window_rows = 0; }
    }
    cursor = page[page.length - 1]!.id;
    console.log(`[RCPT] watermarks_progress chats=${chats} members=${members} last_chat=${cursor}`);
  }
  for (const id of requeued.splice(0)) if (!(await one(id))) requeued.push(id);

  if (requeued.length) {
    console.error(`✖ ${requeued.length} chat(s) stayed locked: ${requeued.slice(0, 10).join(", ")} — run again.`);
    exit_code = 2;
  } else {
    await set_marker(sql, MARKERS.watermarks, {
      at: new Date().toISOString(), chats, memberships: members, redis: reader !== NO_REDIS,
    });
    console.log(`✅ watermarks initialised: ${chats} chats, ${members} memberships in ${((Date.now() - t_start) / 1000).toFixed(0)}s. ` +
      `Re-run right before the R1b flip.`);
    exit_code = 0;
  }
} catch (e) {
  console.error("❌ sync v2 watermarks failed:", e);
  exit_code = 1;
} finally {
  await sql.end();
  redis?.disconnect();
}

if (exit_code === 0) await recordApplied(import.meta.path);
process.exit(exit_code);
