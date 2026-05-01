import db from "@/config/db";
import { message_info_model, message_model } from "@/models/message.model";
import {
  clear_message_statuses,
  start_message_flush_worker,
  type DirtyMessage,
} from "./message.cache";
import { inArray, sql } from "drizzle-orm";

// UPSERT debounced per-message statuses into message_info.
// GREATEST() is NULL-skipping in Postgres, so a partial update (only delivered_at,
// no read_at yet) won't clobber an already-stored read_at on the row.
const flush_message_statuses_to_db = async (items: DirtyMessage[]): Promise<void> => {
  if (items.length === 0) return;

  const candidate_ids: string[] = [];
  const skipped_ids: string[] = [];
  for (const item of items) {
    if (!item.chat_id) {
      skipped_ids.push(item.message_id); // sentinel missing → drop, don't keep poisoning future flushes
      continue;
    }
    candidate_ids.push(item.message_id);
  }

  // Filter to messages that actually exist — clients sometimes ACK message_ids
  // that were never persisted (local-only optimistic IDs, deleted-on-server
  // messages still in client cache, cross-device drift). Without this filter
  // the FK on message_info.message_id makes Postgres reject the whole batch
  // and the worker re-enqueues every row, looping on the same orphans forever.
  let existing: Set<string>;
  if (candidate_ids.length === 0) {
    existing = new Set();
  } else {
    const found = await db
      .select({ id: message_model.id })
      .from(message_model)
      .where(inArray(message_model.id, candidate_ids));
    existing = new Set(found.map((r) => r.id));
  }

  const rows: Array<{
    message_id: string;
    user_id: string;
    chat_id: string;
    delivered_at: Date | null;
    read_at: Date | null;
  }> = [];

  for (const item of items) {
    if (!item.chat_id) continue;
    if (!existing.has(item.message_id)) {
      skipped_ids.push(item.message_id);
      continue;
    }
    for (const [user_id, status] of item.statuses) {
      rows.push({
        message_id: item.message_id,
        user_id,
        chat_id: item.chat_id,
        delivered_at: status.delivered_at ? new Date(status.delivered_at) : null,
        read_at: status.read_at ? new Date(status.read_at) : null,
      });
    }
  }

  if (skipped_ids.length > 0) {
    console.warn(
      `[CACHE] dropping ${skipped_ids.length} orphan ack(s) (no matching message row)`,
    );
    await Promise.all(skipped_ids.map((id) => clear_message_statuses(id)));
  }

  if (rows.length === 0) return;

  await db
    .insert(message_info_model)
    .values(rows)
    .onConflictDoUpdate({
      target: [message_info_model.message_id, message_info_model.user_id],
      set: {
        delivered_at: sql`GREATEST(${message_info_model.delivered_at}, EXCLUDED.delivered_at)`,
        read_at: sql`GREATEST(${message_info_model.read_at}, EXCLUDED.read_at)`,
      },
    });
};

const start_message_status_flush = (): (() => void) =>
  start_message_flush_worker(flush_message_statuses_to_db);

export { flush_message_statuses_to_db, start_message_status_flush };
