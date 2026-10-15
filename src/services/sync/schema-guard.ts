// =============================================================================
// Boot-time schema guard (Sync v2 R1a, §9 row 2 ship order: 20261020a/b →
// code → 20261020c)
// =============================================================================
// The R1a models declare new columns (messages.seq / mod_seq / meta, chats.
// seq_head …, chat_members.read_seq …, missed_ws_messages.entry_v) and the
// chat_receipt_mins table, and drizzle names every model column in a bare
// select() / .returning(). A build started on a database where 20261020a has
// not run would boot, pass readyz and take traffic — then fail every send,
// history read and chat-list read with 42703 "column does not exist", for old
// apps too. So boot checks first, while the previous process (A/B swap, or
// the old build in tmux) still serves.
//
// One information_schema query, derived from the models themselves so the
// list cannot drift from what drizzle will select.
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { pg_client } from "@/config/db";
import { chat_member_model, chat_model, chat_receipt_mins_model } from "@/models/chat.model";
import { message_model, missed_ws_messages_model } from "@/models/message.model";

// The tables R1a changed. Others are left alone: a drift there is not this
// build's doing and was already live before it.
const GUARDED: PgTable[] = [
  message_model,
  chat_model,
  chat_member_model,
  chat_receipt_mins_model,
  missed_ws_messages_model,
];

/** "table.column" for every model column of the guarded tables missing in the DB. */
export const missing_model_columns = async (): Promise<string[]> => {
  const wanted = GUARDED.flatMap((t) => {
    const cfg = getTableConfig(t);
    return cfg.columns.map((c) => `${cfg.name}.${c.name}`);
  });
  const tables = GUARDED.map((t) => getTableConfig(t).name);
  // One text parameter, split in SQL: drizzle patches pg_client's array
  // serializer, and table names never contain a comma.
  const rows = await pg_client<{ k: string }[]>`
    SELECT table_name || '.' || column_name AS k FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY(string_to_array(${tables.join(",")}::text, ','))`;
  const have = new Set(rows.map((r) => r.k));
  return wanted.filter((k) => !have.has(k));
};
