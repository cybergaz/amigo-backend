import { CHAT_TYPE_CONSTS, CHAT_ROLE_CONST } from "@/types/chat.types";
import { pgTable, bigint, varchar, timestamp, boolean, jsonb, integer, bigserial, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { desc, InferInsertModel, InferSelectModel, isNull } from "drizzle-orm";
import { message_model } from "./message.model";

const chat_model = pgTable("chats", {
  id: uuid().primaryKey().defaultRandom(),
  creater_id: uuid().references(() => user_model.id, { onDelete: 'set null' }),
  type: varchar({ enum: CHAT_TYPE_CONSTS }).notNull(), // "dm", "group", "community_group"
  title: varchar({ length: 255 }),
  pinned_msg_id: uuid(),
  last_msg_id: uuid(),
  last_msg_at: timestamp({ withTimezone: true }),
  // Disappearing-messages: null = off. When set, every newly-inserted message
  // in this chat gets expires_at = sent_at + N seconds stamped at insert time.
  disappearing_after_sec: integer(),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  deleted_at: timestamp({ withTimezone: true }),
  // dm_key: varchar({ length: 64 }).unique(),
  // metadata: jsonb(), // For community groups, includes time restrictions and community_id
}, (table) => [
  index("idx_chats_last_message_at").on(desc(table.last_msg_at)).where(isNull(table.deleted_at)),
]
);

const chat_member_model = pgTable("chat_members", {
  id: uuid().primaryKey().defaultRandom(),
  chat_id: uuid().references(() => chat_model.id, { onDelete: 'cascade' }).notNull(),
  user_id: uuid().references(() => user_model.id, { onDelete: 'set null' }),
  role: varchar({ enum: CHAT_ROLE_CONST }),
  last_read_msg_id: uuid(),
  last_delivered_msg_id: uuid(),
  joined_at: timestamp({ withTimezone: true }).defaultNow(),
  removed_at: timestamp({ withTimezone: true }),
  // deleted: boolean().default(false).notNull(), -- use removed_at instead 
  // unread_count: integer().default(0),
}, (table) => [
  uniqueIndex("uniq_chat_members_active").on(table.chat_id, table.user_id).where(isNull(table.removed_at)),
  index("idx_chatmemeber_chat_id_user_id_unremoved").on(table.chat_id, table.user_id).where(isNull(table.removed_at)),
  index("idx_chatmemeber_user_id_chat_id_unremoved").on(table.user_id, table.chat_id).where(isNull(table.removed_at)),
]);


type DBConversationType = InferSelectModel<typeof chat_model>;
type DBInsertConversationType = InferInsertModel<typeof chat_model>;
type DBUpdateConversationType = Partial<DBInsertConversationType>;

type DBConversationMemberType = InferSelectModel<typeof chat_member_model>;
type DBInsertConversationMemberType = InferInsertModel<typeof chat_member_model>;
type DBUpdateConversationMemberType = Partial<DBInsertConversationMemberType>;

export {
  chat_model,
  chat_member_model,
};
export type {
  DBConversationType,
  DBInsertConversationType,
  DBUpdateConversationType,
  DBConversationMemberType,
  DBInsertConversationMemberType,
  DBUpdateConversationMemberType,
};
