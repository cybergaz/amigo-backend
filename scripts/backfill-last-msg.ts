/**
 * Restore the last-message pointer after starting fresh on an empty Valkey.
 *
 * WHY: normal WS sends (store_message_with_retry) only wrote the last message
 * to Redis chat_meta; the Postgres update was commented out (socket.service.ts
 * step 5). When Valkey started empty, every chat lost BOTH:
 *   1. chats.last_msg_id in Postgres  → get_chat_list ships lastMsgId=null →
 *      the app hides the DM (client filter: chats.lastMsgId IS NOT NULL)
 *   2. chat_meta:{chat_id} in Redis   → no last-message PREVIEW (body/sender)
 *
 * This script fixes both, from the messages table:
 *   Pass 1 — UPDATE chats.last_msg_id / last_msg_at   (makes the DM visible)
 *   Pass 2 — warm chat_meta in Valkey via update_chat_meta (restores preview)
 *
 * It picks the newest UNDELETED message per chat — matching what chat_meta held
 * (chat_meta is per-chat/global, not per-user). Uses update_chat_meta so the
 * hash format is byte-identical to what get_chat_metas reads.
 *
 * Safe/idempotent: Pass 1 is one statement with `IS DISTINCT FROM` (skips
 * already-correct rows); Pass 2 just re-sets the same fields. Re-runnable.
 * Writes chat_meta to whatever REDIS_URL points at — run it with REDIS_URL set
 * to the NEW Valkey so the new cache gets warmed.
 *
 * Usage:  bun run backfill:lastmsg
 */

import db from "@/config/db";
import { update_chat_meta } from "@/cache-management/chat-meta.cache";
import type { MessageType } from "@/types/chat.types";
import { sql } from "drizzle-orm";

// drizzle's db.execute returns the postgres.js RowList (array) for SELECT/RETURNING,
// but normalize defensively in case the driver wraps it in { rows }.
const as_rows = (res: unknown): any[] =>
  Array.isArray(res) ? res : ((res as { rows?: any[] })?.rows ?? []);

const to_iso = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.length > 0) return new Date(v).toISOString();
  return new Date().toISOString();
};

async function main(): Promise<void> {
  // ── Pass 1: Postgres pointer ────────────────────────────────────────────
  const updated = as_rows(
    await db.execute(sql`
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
    `),
  );
  console.log(`[backfill] Postgres: set last_msg_id on ${updated.length} chat(s).`);

  // ── Pass 2: warm Valkey chat_meta with the same latest messages ─────────
  const rows = as_rows(
    await db.execute(sql`
      SELECT DISTINCT ON (m.chat_id)
        m.chat_id, m.id, m.body, m.type, m.sender_id, m.sent_at, m.attachments
      FROM messages m
      JOIN chats c ON c.id = m.chat_id AND c.deleted_at IS NULL
      WHERE m.deleted_at IS NULL
      ORDER BY m.chat_id, m.sent_at DESC NULLS LAST, m.created_at DESC NULLS LAST
    `),
  ) as Array<{
    chat_id: string;
    id: string;
    body: string | null;
    type: string;
    sender_id: string | null;
    sent_at: Date | string | null;
    attachments: unknown;
  }>;

  let warmed = 0;
  const CHUNK = 50; // bounded concurrency so we don't open 1000s of ops at once
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await Promise.all(
      slice.map((r) =>
        update_chat_meta(r.chat_id, {
          id: r.id,
          body: r.body ?? "",
          type: r.type as MessageType,
          sender_id: r.sender_id ?? "",
          sent_at: to_iso(r.sent_at),
          attachments: r.attachments ?? null,
        }).then(() => {
          warmed++;
        }),
      ),
    );
    process.stdout.write(`\r[backfill] Valkey chat_meta: warmed ${warmed}/${rows.length}...`);
  }

  console.log(
    `\n[backfill] Done — Postgres pointers: ${updated.length}, Valkey chat_meta warmed: ${warmed}. ` +
      `DM lists reappear (with previews) on the next chat-list sync.`,
  );

  // All writes above are already awaited/ACKed, so nothing is buffered.
  // process.exit tears down this script's own connections; it never touches
  // the prod server (that's a separate process with its own client).
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
