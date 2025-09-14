import { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS } from "@/types/chat.types";
import { pgTable, serial, bigint, text, varchar, timestamp, boolean, jsonb, integer, bigserial, } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { CHAT_ROLE_CONST   } from "@/types/user.types";

export const conversation_model = pgTable("conversations", {
  id: bigint({ mode: 'number' }).primaryKey(),
  creater_id: bigint({ mode: 'number' }).references(() => user_model.id,{ onDelete: 'cascade' }).notNull(), // creater/owner
  type: varchar({ enum: CHAT_TYPE_CONSTS }).notNull(), // "dm", "group"
  title: varchar({ length: 255 }),
  metadata: jsonb(),  
  last_message_at: timestamp(),
  created_at: timestamp().defaultNow().notNull(),
});

export const conversation_member_model = pgTable("conversation_members", {
  id: bigserial({ mode: "number" }).primaryKey(),
  conversation_id: bigint({ mode: 'number' }).references(() => conversation_model.id,{ onDelete: 'cascade' }).notNull(),
  user_id: bigint({ mode: 'number' }).references(() => user_model.id,{ onDelete: 'cascade' }).notNull(),
  role: varchar({ enum: CHAT_ROLE_CONST }),
  unread_count: integer().default(0),
  joined_at: timestamp().defaultNow(),
  // // per-member settings
  // settings: jsonb("settings"),
  last_read_message_id: bigint({ mode: 'number' }),
  last_delivered_message_id: bigint({ mode: 'number' }),
});

export const message_model = pgTable("messages", {
  id: bigserial({ mode: "number" }).primaryKey(),
  conversation_id: bigint({ mode: 'number' }).references(() => conversation_model.id,{ onDelete: 'cascade' }).notNull(),
  sender_id: bigint({ mode: 'number' }).references(() => user_model.id,{ onDelete: 'cascade' }).notNull(),
  // message types: text, system, attachment, reaction
  type: varchar({ enum: MESSAGE_TYPE_CONSTS }).default("text").notNull(),
  body: text(),                      // text content (nullable if attachment only)
  attachments: jsonb(),              // [{url, mime, size, key, thumbnail}]
  metadata: jsonb(),                 // reply_to, edits, mentions, etc.
  edited_at: timestamp(),
  created_at: timestamp().defaultNow().notNull(),
  deleted: boolean().default(false).notNull(),
});
