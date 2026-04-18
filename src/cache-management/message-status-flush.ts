import db from "@/config/db";
import { message_info_model } from "@/models/message.model";
import {
  start_message_flush_worker,
  type DirtyMessage,
} from "./message.cache";
import { sql } from "drizzle-orm";

// UPSERT debounced per-message statuses into message_info.
// GREATEST() is NULL-skipping in Postgres, so a partial update (only delivered_at,
// no read_at yet) won't clobber an already-stored read_at on the row.
const flush_message_statuses_to_db = async (items: DirtyMessage[]): Promise<void> => {
  if (items.length === 0) return;

  const rows: Array<{
    message_id: string;
    user_id: string;
    chat_id: string;
    delivered_at: Date | null;
    read_at: Date | null;
  }> = [];

  for (const item of items) {
    if (!item.chat_id) continue; // chat_id sentinel missing — skip rather than violate NOT NULL
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
