import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { start_receipt_flush_worker, type DirtyReceipt } from "./chat-member.cache";
import { sql } from "drizzle-orm";
import { run_pg_singleton, type Tx } from "@/cluster/jobs";

// Bulk upsert last_delivered_msg_id / last_read_msg_id into chat_members.
// One flush = one DB round-trip via UPDATE ... FROM (VALUES ...).
// `exec` is the batch's fenced transaction when called from the worker.
const flush_receipts_to_db = async (items: DirtyReceipt[], exec?: Tx): Promise<void> => {
  if (items.length === 0) return;

  const rows = items
    .filter((i) => i.receipt.last_delivered_msg_id || i.receipt.last_read_msg_id)
    .map(
      (i) =>
        sql`(${i.user_id}::uuid, ${i.chat_id}::uuid, ${i.receipt.last_delivered_msg_id}::uuid, ${i.receipt.last_read_msg_id}::uuid)`
    );

  if (rows.length === 0) return;

  const values = sql.join(rows, sql`, `);

  await (exec ?? db).execute(sql`
    UPDATE ${chat_member_model} AS cm
    SET last_delivered_msg_id = COALESCE(v.delivered_id, cm.last_delivered_msg_id),
        last_read_msg_id      = COALESCE(v.read_id,      cm.last_read_msg_id)
    FROM (VALUES ${values}) AS v(user_id, chat_id, delivered_id, read_id)
    WHERE cm.user_id = v.user_id
      AND cm.chat_id = v.chat_id
      AND cm.removed_at IS NULL
  `);
};

// SYNC_V2 §13.7 F7: each batch (SPOP 500 → read receipts → UPDATE → commit)
// runs under the 'receipt_flush' advisory lock, so at most one worker is
// ever between the SPOP and the UPDATE — today during every A/B swap, later
// at N>1. What is written is unchanged. R4 deletes this flush entirely.
const start_receipts_flush = (): (() => Promise<void>) =>
  start_receipt_flush_worker<Tx>(flush_receipts_to_db, {
    exclusive: (batch) => run_pg_singleton("receipt_flush", (tx) => batch(tx)),
  });

export { flush_receipts_to_db, start_receipts_flush };
