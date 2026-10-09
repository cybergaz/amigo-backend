import { pgTable, timestamp, uuid, index, primaryKey } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { chat_model } from "./chat.model";
import { message_model } from "./message.model";
import { user_model } from "./user.model";

// Broadcast lists (WhatsApp-style). A list IS a chat row (chats.type =
// 'broadcast', owner_id = creater_id = the sender) whose ONLY chat_members row
// is the owner. Recipients live here instead — never in chat_members — so
// nothing chat-scoped (conversation fan-out, chat list, history, presence) can
// ever reach a recipient or reveal the other recipients. See BROADCAST_LISTS.md.
//
// Created by scripts/migrations/20261008-broadcast-lists.ts (constraint names
// below match drizzle's defaults so drizzle-kit push sees no drift).
const broadcast_recipient_model = pgTable("broadcast_recipients", {
  list_id: uuid().references(() => chat_model.id, { onDelete: "cascade" }).notNull(),
  user_id: uuid().references(() => user_model.id, { onDelete: "cascade" }).notNull(),
  added_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.list_id, table.user_id] }),
  // Backs the ON DELETE CASCADE from users (a user deletion would otherwise
  // seq-scan this table). Small table, cheap index.
  index("idx_broadcast_recipients_user_id").on(table.user_id),
]);

// One row per (broadcast message, recipient): which DM the server copied the
// message into and the copy's id there. Written in the same transaction as the
// copies; read by the duplicate re-ack, POST /chat/broadcast/copies and the
// delete-for-everyone cascade.
const broadcast_message_copy_model = pgTable("broadcast_message_copies", {
  broadcast_msg_id: uuid().references(() => message_model.id, { onDelete: "cascade" }).notNull(),
  recipient_id: uuid().references(() => user_model.id, { onDelete: "cascade" }).notNull(),
  // The 1:1 DM between the sender and recipient_id.
  chat_id: uuid().references(() => chat_model.id, { onDelete: "cascade" }).notNull(),
  // The copy (a normal messages row in that DM).
  message_id: uuid().references(() => message_model.id, { onDelete: "cascade" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.broadcast_msg_id, table.recipient_id] }),
  index("idx_bmc_message_id").on(table.message_id),
]);

type DBBroadcastRecipientType = InferSelectModel<typeof broadcast_recipient_model>;
type DBInsertBroadcastRecipientType = InferInsertModel<typeof broadcast_recipient_model>;
type DBBroadcastMessageCopyType = InferSelectModel<typeof broadcast_message_copy_model>;
type DBInsertBroadcastMessageCopyType = InferInsertModel<typeof broadcast_message_copy_model>;

export { broadcast_recipient_model, broadcast_message_copy_model };
export type {
  DBBroadcastRecipientType,
  DBInsertBroadcastRecipientType,
  DBBroadcastMessageCopyType,
  DBInsertBroadcastMessageCopyType,
};
