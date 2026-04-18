import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { start_receipt_flush_worker, type DirtyReceipt } from "./chat-member.cache";
import { sql } from "drizzle-orm";

// Bulk upsert last_delivered_msg_id / last_read_msg_id into chat_members.
// One flush = one DB round-trip via UPDATE ... FROM (VALUES ...).
const flush_receipts_to_db = async (items: DirtyReceipt[]): Promise<void> => {
  if (items.length === 0) return;

  const rows = items
    .filter((i) => i.receipt.last_delivered_msg_id || i.receipt.last_read_msg_id)
    .map(
      (i) =>
        sql`(${i.user_id}::uuid, ${i.chat_id}::uuid, ${i.receipt.last_delivered_msg_id}::uuid, ${i.receipt.last_read_msg_id}::uuid)`
    );

  if (rows.length === 0) return;

  const values = sql.join(rows, sql`, `);

  await db.execute(sql`
    UPDATE ${chat_member_model} AS cm
    SET last_delivered_msg_id = COALESCE(v.delivered_id, cm.last_delivered_msg_id),
        last_read_msg_id      = COALESCE(v.read_id,      cm.last_read_msg_id)
    FROM (VALUES ${values}) AS v(user_id, chat_id, delivered_id, read_id)
    WHERE cm.user_id = v.user_id
      AND cm.chat_id = v.chat_id
      AND cm.removed_at IS NULL
  `);
};

const start_receipts_flush = (): (() => void) =>
  start_receipt_flush_worker(flush_receipts_to_db);

export { flush_receipts_to_db, start_receipts_flush };
