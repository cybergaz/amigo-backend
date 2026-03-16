import { CHAT_TYPE_CONSTS, CHAT_ROLE_CONST } from "@/types/chat.types";
import { pgTable, bigint, varchar, timestamp, boolean, jsonb, integer, bigserial } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";

const conversation_model = pgTable("conversations", {
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

const conversation_member_model = pgTable("conversation_members", {
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
  last_read_message_id: bigint({ mode: 'bigint' }),
  last_delivered_message_id: bigint({ mode: 'bigint' }),
});


type DBConversationType = InferSelectModel<typeof conversation_model>;
type DBInsertConversationType = InferInsertModel<typeof conversation_model>;
type DBUpdateConversationType = Partial<DBInsertConversationType>;

type DBConversationMemberType = InferSelectModel<typeof conversation_member_model>;
type DBInsertConversationMemberType = InferInsertModel<typeof conversation_member_model>;
type DBUpdateConversationMemberType = Partial<DBInsertConversationMemberType>;

export {
  conversation_model,
  conversation_member_model,
};
export type {
  DBConversationType,
  DBInsertConversationType,
  DBUpdateConversationType,
  DBConversationMemberType,
  DBInsertConversationMemberType,
  DBUpdateConversationMemberType,
};
