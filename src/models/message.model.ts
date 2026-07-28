import { MESSAGE_STATUS_CONSTS, MESSAGE_TYPE_CONSTS } from "@/types/chat.types";
import { pgTable, bigint, bigserial, text, varchar, timestamp, boolean, jsonb, uniqueIndex, index, uuid, primaryKey } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { chat_model } from "./chat.model";
import { desc, InferInsertModel, InferSelectModel, isNull } from "drizzle-orm";
import { VITAL_WS_EVENTS_CONST } from "@/types/socket.types";

const message_model = pgTable("messages", {
  id: uuid().primaryKey(),
  chat_id: uuid().references(() => chat_model.id, { onDelete: 'cascade' }).notNull(),
  sender_id: uuid().references(() => user_model.id, { onDelete: 'set null' }),
  type: varchar({ enum: MESSAGE_TYPE_CONSTS }).default("text").notNull(),
  body: text(),                      // text content (nullable if attachment only)
  attachments: jsonb(),              // [{url, mime, size, key, thumbnail}]
  replied_to: uuid(),
  sent_at: timestamp({ withTimezone: true }),
  // Disappearing-messages: null = never expire. Stamped at insert time as
  // sent_at + chats.disappearing_after_sec when the chat has it enabled.
  // The sweeper worker uses idx_messages_expires_at to find rows to delete.
  expires_at: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
  deleted_at: timestamp({ withTimezone: true }),
  // status: varchar({ enum: MESSAGE_STATUS_CONSTS }).default("sent").notNull(), // sent, delivered, read
  // metadata: jsonb(),                 // mentions in future maybe
}, (table) => [
  index("idx_messages_chat_id_sent_at_undeleted").on(table.chat_id, desc(table.sent_at)).where(isNull(table.deleted_at)),
]);

const message_info_model = pgTable("message_info", {
  message_id: uuid().references(() => message_model.id, { onDelete: "cascade" }).notNull(),
  user_id: uuid().references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  chat_id: uuid().references(() => chat_model.id, { onDelete: "cascade" }).notNull(),
  delivered_at: timestamp({ withTimezone: true }),  // when message delivered to this user
  read_at: timestamp({ withTimezone: true }),       // when user read it
  deleted_at: timestamp({ withTimezone: true }),    // when user deleted this message (delete for me)
  reaction: varchar({ length: 50 }),                // emoji the user reacted with (e.g. "👍"), null if no reaction
}, (table) => [
  primaryKey({ columns: [table.message_id, table.user_id] }),
  index("idx_messageinfo_chat_id_user_id").on(table.chat_id, table.user_id),
  index("idx_messageinfo_user_id_chat_id").on(table.user_id, table.chat_id),
]);

const missed_ws_messages_model = pgTable("missed_ws_messages", {
  // TEXT, not uuid: since the drain-lifecycle change this holds the
  // deterministic correlation key `{user_id}:{event_type}:{natural_id}`
  // (see polling.cache correlation_key), which is how the ack path targets
  // and deletes an entry. Column migrated uuid→text by
  // scripts/apply-missed-ws-id-text.ts; ids are always app-supplied.
  id: text().primaryKey(),
  user_id: uuid().references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  event_type: varchar({ enum: VITAL_WS_EVENTS_CONST }).notNull(),  // WS event type e.g. 'message:new', 'conversation:action'
  ws_message: jsonb().notNull(),  // Store the entire message payload that was missed
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_missedwsmessages_user_id").on(table.user_id, table.created_at)
]);

type DBMessageType = InferSelectModel<typeof message_model>;
type DBInsertMessageType = InferInsertModel<typeof message_model>;
type DBUpdateMessageType = Partial<DBInsertMessageType>;

type DBMessageStatusType = InferSelectModel<typeof message_info_model>;
type DBInsertMessageStatusType = InferInsertModel<typeof message_info_model>;
type DBUpdateMessageStatusType = Partial<DBInsertMessageStatusType>;

type DBMissedMessageType = InferSelectModel<typeof missed_ws_messages_model>;
type DBInsertMissedMessageType = InferInsertModel<typeof missed_ws_messages_model>;

export {
  message_model,
  message_info_model,
  missed_ws_messages_model
};
export type {
  DBMessageType,
  DBInsertMessageType,
  DBUpdateMessageType,
  DBMessageStatusType,
  DBInsertMessageStatusType,
  DBUpdateMessageStatusType,
  DBMissedMessageType,
  DBInsertMissedMessageType
};
