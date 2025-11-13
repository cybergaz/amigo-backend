import { CHAT_TYPE_CONSTS, MESSAGE_STATUS_CONSTS, MESSAGE_TYPE_CONSTS } from "@/types/chat.types";
import { pgTable, serial, bigint, text, varchar, timestamp, boolean, jsonb, integer, bigserial, uniqueIndex, index, } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { CHAT_ROLE_CONST } from "@/types/chat.types";

export const conversation_model = pgTable("conversations", {
  id: bigint({ mode: 'number' }).primaryKey(),
  creater_id: bigint({ mode: 'number' }).references(() => user_model.id, { onDelete: 'cascade' }).notNull(), // creater/owner
  dm_key: varchar({ length: 64 }).unique(),
  type: varchar({ enum: CHAT_TYPE_CONSTS }).notNull(), // "dm", "group", "community_group"
  title: varchar({ length: 255 }),
  metadata: jsonb(), // For community groups, includes time restrictions and community_id
  last_message_at: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  deleted: boolean().default(false).notNull(),
});

export const conversation_member_model = pgTable("conversation_members", {
  id: bigserial({ mode: "number" }).primaryKey(),
  conversation_id: bigint({ mode: 'number' }).references(() => conversation_model.id, { onDelete: 'cascade' }).notNull(),
  user_id: bigint({ mode: 'number' }).references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  role: varchar({ enum: CHAT_ROLE_CONST }),
  unread_count: integer().default(0),
  joined_at: timestamp({ withTimezone: true }).defaultNow(),
  removed_at: timestamp({ withTimezone: true }),
  deleted: boolean().default(false).notNull(),
  // // per-member settings
  // settings: jsonb("settings"),
  last_read_message_id: bigint({ mode: 'number' }),
  last_delivered_message_id: bigint({ mode: 'number' }),
});

export const message_model = pgTable("messages", {
  id: bigserial({ mode: "number" }).primaryKey(),
  conversation_id: bigint({ mode: 'number' }).references(() => conversation_model.id, { onDelete: 'cascade' }),
  sender_id: bigint({ mode: 'number' }).references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  // message types: text, system, attachment, reaction
  type: varchar({ enum: MESSAGE_TYPE_CONSTS }).default("text").notNull(),
  body: text(),                      // text content (nullable if attachment only)
  attachments: jsonb(),              // [{url, mime, size, key, thumbnail}]
  metadata: jsonb(),                 // reply_to, edits, mentions, etc.
  edited_at: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  status: varchar({ enum: MESSAGE_STATUS_CONSTS }).default("sent").notNull(), // sent, delivered, read
  deleted: boolean().default(false).notNull(),
  // origin conversation id
  forwarded_from: bigint({ mode: 'number' }).references(() => conversation_model.id, { onDelete: 'cascade' }),
  // destination conversation ids 
  forwarded_to: bigint({ mode: 'number' }).array()
});

export const message_status_model = pgTable("message_status", {
  id: bigserial({ mode: "number" }).primaryKey(),
  message_id: bigint({ mode: "number" }).references(() => message_model.id, { onDelete: "cascade" }).notNull(),
  user_id: bigint({ mode: "number" }).references(() => user_model.id, { onDelete: "cascade" }).notNull(),
  delivered_at: timestamp({ withTimezone: true }),  // when message delivered to this user
  read_at: timestamp({ withTimezone: true }),       // when user read it
  // optional optimization fields
  // helps avoid multiple entries if re-delivered
  updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
},
  (table) => [uniqueIndex("unique_user_message").on(table.message_id, table.user_id),]
);
