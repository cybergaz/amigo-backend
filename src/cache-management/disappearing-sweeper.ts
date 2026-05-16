import db from "@/config/db";
import { sql } from "drizzle-orm";
import { broadcast_deletion } from "@/services/chat.services";

// ────────────────────────────────────────────────────────────────────────────
// Disappearing-messages sweeper.
//
// Periodically:
//   1. Atomically claim up to N expired rows by setting deleted_at — done in a
//      single CTE with FOR UPDATE SKIP LOCKED so multiple app instances can
//      run this worker without coordinating.
//   2. For each affected chat, hand off to broadcast_deletion (the SAME helper
//      that powers user-initiated message:delete). This means recipients see
//      no wire-level difference between "user deleted" and "expiry deleted":
//        - WS broadcast to live members
//        - FCM/missed-ws enqueue for offline + polling members
//        - chats.last_msg_id / pinned_msg_id repoint if affected
//
// Why polling, not Redis EXPIRE / pg_cron / per-message timers:
//   - The DB partial index makes the claim O(expiring-this-tick), not
//     O(all-pending). At rest the worker is essentially free.
//   - Single source of truth (messages table). Redis is a cache, not a
//     scheduler.
//   - Same shape as start_message_flush_worker / start_receipt_flush_worker,
//     so boot/shutdown/error semantics match the rest of the codebase.
// ────────────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30_000;
const SWEEP_BATCH_SIZE = 500;

type ClaimedRow = { id: string; chat_id: string };

// Atomic batch claim. Returns rows that THIS instance is responsible for.
// SKIP LOCKED makes the worker horizontally safe — concurrent invocations
// pick disjoint slices, so we never double-broadcast a delete.
const claim_expired_batch = async (limit: number): Promise<ClaimedRow[]> => {
  const result = await db.execute(sql`
    WITH expired AS (
      SELECT id FROM messages
       WHERE deleted_at IS NULL
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()
       ORDER BY expires_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE messages
       SET deleted_at = NOW()
     WHERE id IN (SELECT id FROM expired)
    RETURNING id, chat_id
  `);
  // node-postgres returns { rows }, bun-pg via drizzle returns the array
  // directly in some adapters. Handle both shapes defensively.
  const rows = (result as any).rows ?? (result as any) ?? [];
  return Array.isArray(rows) ? (rows as ClaimedRow[]) : [];
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
    while (!stopped) {
      let claimed: ClaimedRow[] = [];
      try {
        claimed = await claim_expired_batch(SWEEP_BATCH_SIZE);
      } catch (err) {
        console.error("[SWEEPER] claim_expired_batch failed:", err);
        break; // Bail this tick — next one will retry.
      }
      if (claimed.length === 0) break;

      // Group by chat so each conversation gets one broadcast with all of
      // its expired ids — minimizes WS frame count and FCM fan-outs.
      const by_chat = new Map<string, string[]>();
      for (const row of claimed) {
        let arr = by_chat.get(row.chat_id);
        if (!arr) {
          arr = [];
          by_chat.set(row.chat_id, arr);
        }
        arr.push(row.id);
      }

      for (const [chat_id, ids] of by_chat) {
        try {
          // actor_id = null → sweeper-initiated; broadcast to ALL members.
          await broadcast_deletion(chat_id, ids, null);
        } catch (err) {
          // Already-claimed row stays deleted at the DB level. Recipients
          // that didn't get the live broadcast will pick it up from
          // missed_ws_messages or from a fresh fetch on next sync.
          console.error(`[SWEEPER] broadcast_deletion failed (chat ${chat_id}):`, err);
        }
      }

      // Drain mode: if we got a full batch, immediately go again. Prevents
      // a 30s gap between batches when a setting change has caused a large
      // backlog of expired rows.
      if (claimed.length < SWEEP_BATCH_SIZE) break;
    }
  } finally {
    running = false;
    schedule();
  }
};

const start_disappearing_sweeper = (): (() => void) => {
  if (stopped) stopped = false;
  schedule();
  console.log(`[SWEEPER] Disappearing-messages sweeper started (every ${SWEEP_INTERVAL_MS}ms, batch ${SWEEP_BATCH_SIZE})`);
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
};

export { start_disappearing_sweeper, claim_expired_batch };
