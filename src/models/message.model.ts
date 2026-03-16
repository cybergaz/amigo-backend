import { MESSAGE_STATUS_CONSTS, MESSAGE_TYPE_CONSTS } from "@/types/chat.types";
import { pgTable, bigint, bigserial, text, varchar, timestamp, boolean, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { conversation_model } from "./chat.model";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { VITAL_WS_EVENTS_CONST } from "@/types/socket.types";

const message_model = pgTable("messages", {
  id: bigint({ mode: "bigint" }).primaryKey(),
  conversation_id: bigint({ mode: 'number' }).references(() => conversation_model.id, { onDelete: 'cascade' }),
  sender_id: bigint({ mode: 'number' }).references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  type: varchar({ enum: MESSAGE_TYPE_CONSTS }).default("text").notNull(),
  body: text(),                      // text content (nullable if attachment only)
  attachments: jsonb(),              // [{url, mime, size, key, thumbnail}]
  metadata: jsonb(),                 // reply_to, edits, mentions, etc.
  sent_at: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  status: varchar({ enum: MESSAGE_STATUS_CONSTS }).default("sent").notNull(), // sent, delivered, read
  deleted: boolean().default(false).notNull(),
  forwarded_from: bigint({ mode: 'number' }).references(() => conversation_model.id, { onDelete: 'cascade' }),
  forwarded_to: bigint({ mode: 'number' }).array()
});

const message_status_model = pgTable("message_status", {
  id: bigserial({ mode: "number" }).primaryKey(),
  message_id: bigint({ mode: "bigint" }).references(() => message_model.id, { onDelete: "cascade" }).notNull(),
  user_id: bigint({ mode: "number" }).references(() => user_model.id, { onDelete: "cascade" }).notNull(),
  conv_id: bigint({ mode: "number" }).references(() => conversation_model.id, { onDelete: "cascade" }).notNull(),
  delivered_at: timestamp({ withTimezone: true }),  // when message delivered to this user
  read_at: timestamp({ withTimezone: true }),       // when user read it
  deleted_at: timestamp({ withTimezone: true }),    // when user deleted this message (delete for me)
  updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
},
  (table) => [uniqueIndex("unique_user_message").on(table.message_id, table.user_id),]
);

const missed_ws_messages_model = pgTable("missed_ws_messages", {
  id: varchar({ length: 100 }).primaryKey(),
  user_id: bigint({ mode: "number" }).references(() => user_model.id, { onDelete: "cascade" }).notNull(),
  event_type: varchar({ enum: VITAL_WS_EVENTS_CONST }).notNull(),  // WS event type e.g. 'message:new', 'conversation:action'
  ws_message: jsonb().notNull(),  // Store the entire message payload that was missed
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("idx_missed_messages_user_id").on(table.user_id, table.created_at)]);

type DBMessageType = InferSelectModel<typeof message_model>;
type DBInsertMessageType = InferInsertModel<typeof message_model>;
type DBUpdateMessageType = Partial<DBInsertMessageType>;

type DBMessageStatusType = InferSelectModel<typeof message_status_model>;
type DBInsertMessageStatusType = InferInsertModel<typeof message_status_model>;
type DBUpdateMessageStatusType = Partial<DBInsertMessageStatusType>;

type DBMissedMessageType = InferSelectModel<typeof missed_ws_messages_model>;
type DBInsertMissedMessageType = InferInsertModel<typeof missed_ws_messages_model>;

export {
  message_model,
  message_status_model,
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
