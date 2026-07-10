/**
 * Restore chats.last_msg_id / last_msg_at from the actual latest message.
 *
 * WHY: normal WS sends (store_message_with_retry) only wrote the last-message
 * pointer to Redis chat_meta; the Postgres update was commented out
 * (socket.service.ts step 5). When Valkey started empty, every chat's pointer
 * was gone, so get_chat_list shipped lastMsgId=null and the app hid those DMs
 * (client filter: chats.lastMsgId IS NOT NULL). This backfills the pointer from
 * the messages table so the DM lists reappear on the next sync.
 *
 * Safe: single statement, uses idx_messages_chat_id_sent_at_undeleted, and
 * `IS DISTINCT FROM` skips rows already correct (idempotent, re-runnable).
 * It picks the newest UNDELETED message per chat — matching what chat_meta held
 * (chat_meta is per-chat/global, not per-user), so no behaviour change.
 *
 * Usage:  bun run scripts/backfill-last-msg.ts
 *
 * Equivalent raw SQL (run in psql / Drizzle Studio if you prefer):
 *   UPDATE chats c
 *   SET last_msg_id = m.id,
 *       last_msg_at = COALESCE(m.sent_at, m.created_at, c.last_msg_at)
 *   FROM (
 *     SELECT DISTINCT ON (chat_id) chat_id, id, sent_at, created_at
 *     FROM messages
 *     WHERE deleted_at IS NULL
 *     ORDER BY chat_id, sent_at DESC NULLS LAST, created_at DESC NULLS LAST
 *   ) m
 *   WHERE c.id = m.chat_id
 *     AND c.deleted_at IS NULL
 *     AND c.last_msg_id IS DISTINCT FROM m.id;
 */

import db from "@/config/db";
import { sql } from "drizzle-orm";

async function main(): Promise<void> {
  console.log("[backfill] Restoring chats.last_msg_id from latest messages...");

  const res: unknown = await db.execute(sql`
    UPDATE chats c
    SET last_msg_id = m.id,
        last_msg_at = COALESCE(m.sent_at, m.created_at, c.last_msg_at)
    FROM (
      SELECT DISTINCT ON (chat_id) chat_id, id, sent_at, created_at
      FROM messages
      WHERE deleted_at IS NULL
      ORDER BY chat_id, sent_at DESC NULLS LAST, created_at DESC NULLS LAST
    ) m
    WHERE c.id = m.chat_id
      AND c.deleted_at IS NULL
      AND c.last_msg_id IS DISTINCT FROM m.id
    RETURNING c.id
  `);

  // Drivers differ: postgres.js returns an array-like of RETURNING rows.
  const count =
    Array.isArray(res) ? res.length
    : typeof (res as { length?: number })?.length === "number" ? (res as { length: number }).length
    : typeof (res as { count?: number })?.count === "number" ? (res as { count: number }).count
    : (res as { rowCount?: number })?.rowCount ?? 0;

  console.log(`[backfill] Done — updated last_msg_id for ${count} chat(s). DM lists will repopulate on next chat-list sync.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] FAILED (no partial state — single statement):", err);
  process.exit(1);
});
