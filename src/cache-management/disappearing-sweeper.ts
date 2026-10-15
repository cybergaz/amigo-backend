import { pg_client } from "@/config/db";
import { broadcast_deletion } from "@/services/chat.services";
import { run_pg_singleton_sql } from "@/cluster/jobs";
import { is_draining } from "@/cluster/lifecycle";
import { count } from "@/utils/counters";
import { group_by_chat_sorted, select_expired_candidates } from "@/services/sync/write-queries";
import { soft_delete_one_chat } from "@/services/sync/bulk-delete";

// ────────────────────────────────────────────────────────────────────────────
// Disappearing-messages sweeper (SYNC_V2_PROTOCOL.md §3.3.1, §13.7 F9).
//
// Every SWEEP_INTERVAL_MS, while there is a backlog:
//   1. Select up to SWEEP_BATCH_SIZE expired, not-yet-deleted rows, oldest
//      expiry first — WITHOUT locking (idx on expires_at; O(expiring now)).
//   2. Group them by chat, chats in id order.
//   3. Per chat, ONE short transaction under the 'disappearing_sweep'
//      singleton lock (cluster-wide single runner, transaction-scoped so it
//      works through a pooler and dies with a wedged worker):
//        amigo.bulk_alloc on → one clock block for the chat → UPDATE … SET
//        deleted_at, mod_seq = block → RETURNING.
//      Expiry is re-checked under the row lock, and RETURNING decides who
//      broadcasts: a row someone else deleted first is not announced twice.
//   4. Hand the returned ids to broadcast_deletion (the SAME helper as a
//      user delete): WS + FCM/pending + the legacy pointer/pin repair on
//      unnumbered chats (numbered chats were repaired by the triggers).
//
// Why per chat and not one multi-chat UPDATE (the old claim): the delete now
// allocates clock values, which holds each chat's row lock until commit. One
// statement over 500 rows of many chats held all their locks at once, in row
// order — blocking every send to those chats for the whole batch and able to
// deadlock with inserts. Per chat, a send waits at most one short statement.
//
// Why polling, not Redis EXPIRE / pg_cron / per-message timers:
//   - Single source of truth (messages table). Redis is a cache, not a
//     scheduler.
//   - Same shape as the other flush workers, so boot/shutdown/error
//     semantics match the rest of the codebase.
// ────────────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30_000;
const SWEEP_BATCH_SIZE = 500;
const JOB = "disappearing_sweep";

type SweepOutcome = { deleted: number; held_elsewhere: boolean };

// One pass over at most SWEEP_BATCH_SIZE candidates. Exported for tests /
// scripts. Never throws for one chat's failure (logged, the next tick retries).
const sweep_once = async (): Promise<SweepOutcome & { candidates: number }> => {
  const candidates = await select_expired_candidates(pg_client, SWEEP_BATCH_SIZE);
  let deleted = 0;
  for (const [chat_id, ids] of group_by_chat_sorted(candidates)) {
    if (stopped || is_draining()) break;
    let rows: { id: string }[] | undefined;
    try {
      const res = await run_pg_singleton_sql(JOB, (tx) =>
        soft_delete_one_chat(chat_id, ids, { expired_only: true, exec: tx }),
      );
      if (res === undefined) {
        // Another worker is sweeping right now; it will get to this chat.
        return { deleted, held_elsewhere: true, candidates: candidates.length };
      }
      rows = res.rows;
    } catch (err) {
      // run_pg_singleton_sql already logged + counted it. The rows stay
      // undeleted and are picked up by the next tick.
      continue;
    }
    if (!rows || rows.length === 0) continue;
    deleted += rows.length;
    try {
      // actor_id = null → sweeper-initiated; broadcast to ALL members.
      await broadcast_deletion(chat_id, rows.map((r) => r.id), null);
    } catch (err) {
      // The rows stay deleted. Recipients that missed the live broadcast
      // pick it up from the pending queue or their next sync.
      console.error(`[SWEEPER] broadcast_deletion failed (chat ${chat_id}):`, err);
    }
  }
  if (deleted > 0) count("SWEEPER", "deleted", deleted);
  return { deleted, held_elsewhere: false, candidates: candidates.length };
};

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let running = false;

const schedule = () => {
  if (stopped) return;
  timer = setTimeout(tick, SWEEP_INTERVAL_MS);
};

const tick = async () => {
  // In-flight guard: if a previous tick is still draining we skip this slot
  // and let it reschedule itself. Same pattern as start_message_flush_worker.
  if (stopped || running) {
    schedule();
    return;
  }
  running = true;
  try {
    while (!stopped && !is_draining()) {
      let outcome: Awaited<ReturnType<typeof sweep_once>>;
      try {
        outcome = await sweep_once();
      } catch (err) {
        console.error("[SWEEPER] candidate select failed:", err);
        break; // Bail this tick — next one will retry.
      }
      // Drain mode: a full batch → go again at once (a setting change can
      // leave a large backlog), unless another worker holds the job.
      if (outcome.held_elsewhere || outcome.candidates < SWEEP_BATCH_SIZE) break;
    }
  } finally {
    running = false;
    schedule();
  }
};

const start_disappearing_sweeper = (): (() => Promise<void>) => {
  if (stopped) stopped = false;
  schedule();
  console.log(`[SWEEPER] Disappearing-messages sweeper started (every ${SWEEP_INTERVAL_MS}ms, batch ${SWEEP_BATCH_SIZE})`);
  // Resolves once a sweep already in flight has finished, so the drain does
  // not close the PG pool mid-sweep.
  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while (running) await Bun.sleep(25);
  };
};

export { start_disappearing_sweeper, sweep_once };
