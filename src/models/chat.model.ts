import { CHAT_TYPE_CONSTS, CHAT_ROLE_CONST, CHAT_MEMBER_STATUS_CONST } from "@/types/chat.types";
import { pgTable, bigint, varchar, timestamp, boolean, jsonb, integer, bigserial, uuid, index, uniqueIndex, text } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { and, desc, eq, InferInsertModel, InferSelectModel, isNull, sql } from "drizzle-orm";
import { message_model } from "./message.model";

const chat_model = pgTable("chats", {
  id: uuid().primaryKey().defaultRandom(),
  creater_id: uuid().references(() => user_model.id, { onDelete: 'set null' }),
  // Current group owner. Backfilled from creater_id. creater_id is immutable
  // ("who first made the group"); owner_id is transferable — an owner must hand
  // ownership to another member before they can leave. Null for DMs.
  owner_id: uuid().references(() => user_model.id, { onDelete: 'set null' }),
  type: varchar({ enum: CHAT_TYPE_CONSTS }).notNull(), // "dm", "group", "community_group"
  title: varchar({ length: 255 }),
  // S3 URL of the group avatar. Null for DMs (clients fall back to the peer's
  // users.profile_pic). Mutable by group admins via /chat/group/update-group-profile-image.
  profile_pic: text(),
  pinned_msg_id: uuid(),
  last_msg_id: uuid(),
  last_msg_at: timestamp({ withTimezone: true }),
  // Disappearing-messages: null = off. When set, every newly-inserted message
  // in this chat gets expires_at = sent_at + N seconds stamped at insert time.
  disappearing_after_sec: integer(),
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  deleted_at: timestamp({ withTimezone: true }),
  // ── Sync v2 per-chat clock (SYNC_V2_PROTOCOL.md §2.1, §3.1–§3.2) ─────────
  // Columns: scripts/migrations/20261020a-sync-v2-columns.ts. Triggers and
  // functions that own them: 20261020c-sync-v2-triggers.ts (amigo_alloc,
  // messages_bi, messages_bu_del, messages_au_del, messages_ai_sys,
  // chats_bu_pin). App code never writes these directly.
  // seq_head: the chat clock, +1 per allocation. NULL = not backfilled yet
  // (20261021 numbers the chat, then sets it). The DEFAULT 0 is installed by
  // 20261020c in the same step as the triggers, so a chat born before the
  // triggers exist is never mistaken for a numbered one.
  seq_head: bigint({ mode: "number" }).default(0),
  // Highest visible seq and its id (last_msg_id above), moved in the same
  // UPDATE that allocates the seq; rewound only by a delete of that row.
  last_seq: bigint({ mode: "number" }),
  // Versions taken from the clock: pin (chats_bu_pin), settings / roster
  // (messages_ai_sys on persisted system rows).
  pin_seq: bigint({ mode: "number" }).default(0).notNull(),
  settings_seq: bigint({ mode: "number" }).default(0).notNull(),
  roster_seq: bigint({ mode: "number" }).default(0).notNull(),
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
  // Membership lifecycle. "active" rows (the default) are the only ones that
  // can send/receive/read. "left" (voluntary leave or admin kick) and "pending"
  // (join request awaiting approval) rows are KEPT with removed_at IS NULL so
  // the chat stays in the user's list as a shell. See CHAT_MEMBER_STATUS_CONST.
  status: varchar({ enum: CHAT_MEMBER_STATUS_CONST }).default("active").notNull(),
  last_read_msg_id: uuid(),
  last_delivered_msg_id: uuid(),
  joined_at: timestamp({ withTimezone: true }).defaultNow(),
  removed_at: timestamp({ withTimezone: true }),
  // Per-user mute. NULL = not muted. A timestamp in the future = muted until
  // then ("forever" = far-future date written by the API). A timestamp in the
  // past is treated as not muted (lets us avoid a cron sweep — the send-path
  // ZRANGEBYSCORE filters by score > now()).
  muted_until: timestamp({ withTimezone: true }),
  // Per-user "clear chat" watermark ("delete for me", but for the whole chat
  // while keeping the membership). NULL = never cleared. When set, every read
  // path serves this user only messages created AFTER it: history,
  // messages-around, and the chat-list last-message/pinned enrichment. This is
  // the group analogue of the DM delete-for-me tombstones — a single timestamp
  // instead of one message_info row per message, because a group can have
  // hundreds of members × tens of thousands of messages.
  cleared_at: timestamp({ withTimezone: true }),
  // ── Sync v2 watermarks and floors (SYNC_V2_PROTOCOL.md §2.1, §3.2, §3.7) ─
  // Columns: 20261020a; initial values: 20261022-sync-v2-watermarks.ts.
  // read_seq / delivered_seq only ever rise (GREATEST), clamped to seq_head;
  // delivered_seq >= read_seq. Written by apply_receipts (sync/watermark.service).
  read_seq: bigint({ mode: "number" }).default(0).notNull(),
  delivered_seq: bigint({ mode: "number" }).default(0).notNull(),
  // Floors set by the chat_members_seq trigger (20261020c): joined_seq on a
  // FRESH join (insert, status -> active, or a group re-add's joined_at reset;
  // a DM revive is not a join), left_seq when leaving active. cleared_seq is
  // the clear-chat floor (§3.12). Visible to this member: seq > GREATEST(joined_seq, cleared_seq).
  joined_seq: bigint({ mode: "number" }).default(0).notNull(),
  cleared_seq: bigint({ mode: "number" }).default(0).notNull(),
  left_seq: bigint({ mode: "number" }),
  // When the member last left 'active' (same trigger; cleared on a fresh
  // join). Lets 20261022 resolve left_seq for a leave that happened before
  // the backfill numbered the chat.
  left_at: timestamp({ withTimezone: true }),
  // true once the member has any delete-for-me row in this chat; lets derived
  // unread skip the message_info probe for everyone else (§3.6).
  has_hidden: boolean().default(false).notNull(),
  // deleted: boolean().default(false).notNull(), -- use removed_at instead
  // unread_count: integer().default(0),
}, (table) => [
  uniqueIndex("uniq_chat_members_active").on(table.chat_id, table.user_id).where(isNull(table.removed_at)),
  index("idx_chatmemeber_chat_id_user_id_unremoved").on(table.chat_id, table.user_id).where(isNull(table.removed_at)),
  index("idx_chatmemeber_user_id_chat_id_unremoved").on(table.user_id, table.chat_id).where(isNull(table.removed_at)),
  // Fast lookup of pending join requests for a group's "manage requests" screen.
  index("idx_chat_members_pending").on(table.chat_id).where(and(eq(table.status, "pending"), isNull(table.removed_at))!),
  // Built CONCURRENTLY by 20261021b, exactly this shape. No watermark
  // columns on purpose: indexing read_seq / delivered_seq would make every
  // receipt write a non-HOT update (see 20261021b). Never db:push before
  // 20261021b (see message.model.ts).
  index("idx_chat_members_wm").on(table.chat_id).where(sql`${table.status} = 'active'`),
]);

// Sync v2 per-chat receipt minimums (SYNC_V2_PROTOCOL.md §3.2, §3.7). The two
// lowest read and delivered watermarks over COUNTED members (active, user_id
// NOT NULL, not hidden unless the chat is a DM, broadcast lists excluded) and
// the holder of the lowest. Serves the per-viewer "others" ticks:
//   others_read_seq(me) = CASE WHEN r_min1_user = me THEN COALESCE(r_min2, seq_head) ELSE r_min1 END
// Written only by amigo_refresh_min_wm() (20261020c), under a per-chat
// advisory lock; the values never decrease.
const chat_receipt_mins_model = pgTable("chat_receipt_mins", {
  chat_id: uuid().primaryKey().references(() => chat_model.id, { onDelete: 'cascade' }),
  r_min1: bigint({ mode: "number" }).default(0).notNull(),
  r_min1_user: uuid(),
  r_min2: bigint({ mode: "number" }),
  d_min1: bigint({ mode: "number" }).default(0).notNull(),
  d_min1_user: uuid(),
  d_min2: bigint({ mode: "number" }),
  updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
});


type DBConversationType = InferSelectModel<typeof chat_model>;
type DBInsertConversationType = InferInsertModel<typeof chat_model>;
type DBUpdateConversationType = Partial<DBInsertConversationType>;

type DBConversationMemberType = InferSelectModel<typeof chat_member_model>;
type DBInsertConversationMemberType = InferInsertModel<typeof chat_member_model>;
type DBUpdateConversationMemberType = Partial<DBInsertConversationMemberType>;

type DBChatReceiptMinsType = InferSelectModel<typeof chat_receipt_mins_model>;

export {
  chat_model,
  chat_member_model,
  chat_receipt_mins_model,
};
export type {
  DBConversationType,
  DBInsertConversationType,
  DBUpdateConversationType,
  DBConversationMemberType,
  DBInsertConversationMemberType,
  DBUpdateConversationMemberType,
  DBChatReceiptMinsType,
};
