import { MESSAGE_STATUS_CONSTS, MESSAGE_TYPE_CONSTS } from "@/types/chat.types";
import { pgTable, bigint, bigserial, text, varchar, timestamp, boolean, jsonb, uniqueIndex, index, uuid, primaryKey } from "drizzle-orm/pg-core";
import { user_model } from "./user.model";
import { chat_model } from "./chat.model";
import { desc, InferInsertModel, InferSelectModel, isNull, isNotNull, and, ne } from "drizzle-orm";
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
  // ── Sync v2 per-chat clock (SYNC_V2_PROTOCOL.md §2.1, §3.1–§3.2) ─────────
  // Columns: scripts/migrations/20261020a-sync-v2-columns.ts. Values are
  // written ONLY by the triggers in 20261020c-sync-v2-triggers.ts
  // (messages_bi allocates under the chat row lock, messages_bu_del bumps
  // mod_seq on delete) and by the backfill 20261021. Any seq/mod_seq passed in
  // an INSERT is discarded by the trigger, so app code never sets them.
  // seq: clock value at creation, unique per chat (uniq_messages_chat_seq),
  // immutable. NULL only while the chat is not backfilled (chats.seq_head NULL).
  seq: bigint({ mode: "number" }),
  // mod_seq: clock value of the last change (creation, then delete/expiry).
  // Always >= seq. A row with mod_seq <> seq is a "changed row" for the delta.
  mod_seq: bigint({ mode: "number" }),
  // System-row payload ({action, members, actor_id, ...}, §3.10). The
  // messages_ai_sys trigger reads meta->>'action' to bump settings_seq /
  // roster_seq. Never sent to old clients.
  meta: jsonb(),
  // status: varchar({ enum: MESSAGE_STATUS_CONSTS }).default("sent").notNull(), // sent, delivered, read
}, (table) => [
  index("idx_messages_chat_id_sent_at_undeleted").on(table.chat_id, desc(table.sent_at)).where(isNull(table.deleted_at)),
  // Sync v2 indexes. Built CONCURRENTLY by the ledger scripts (20261020b pre,
  // 20261021b post), never by drizzle-kit. RULE: do not run db:push /
  // db:genpush on an environment until 20261021b is applied there (the
  // marker app_settings.sync_v2_indexes_post = 1 says it is) — push would build
  // these with a blocking CREATE INDEX on the live messages table. Even after
  // it, read what push prints first (drizzle.config.ts).
  // Full (no predicate): backfill ordering, joined/cleared floors, legacy cursors.
  index("idx_messages_chat_created").on(table.chat_id, table.created_at, table.id),
  uniqueIndex("uniq_messages_chat_seq").on(table.chat_id, table.seq).where(isNotNull(table.seq)),
  // Changed rows only, so a plain insert costs no extra index entry. The delta
  // query must use the exact predicate `mod_seq <> seq` to hit it.
  index("idx_messages_chat_modchg").on(table.chat_id, table.mod_seq).where(ne(table.mod_seq, table.seq)),
  // The real index is (chat_id, seq) INCLUDE (sender_id, type, expires_at,
  // created_at), for index-only unread counts (§3.6); the ledger script is the
  // source of truth. drizzle's builder cannot express INCLUDE, and
  // drizzle-kit 0.31 introspects INCLUDE columns as trailing key columns —
  // so they are declared that way here: a push then sees no difference
  // instead of DROP + blocking CREATE on messages. (A DB built by push alone
  // gets a 6-column key index, which serves the same queries.)
  index("idx_messages_unread")
    .on(table.chat_id, table.seq, table.sender_id, table.type, table.expires_at, table.created_at)
    .where(and(isNull(table.deleted_at), isNotNull(table.seq))!),
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
  // scripts/migrations/20260801-missed-ws-id-text.ts; ids are always app-supplied.
  id: text().primaryKey(),
  user_id: uuid().references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  event_type: varchar({ enum: VITAL_WS_EVENTS_CONST }).notNull(),  // WS event type e.g. 'message:new', 'conversation:action'
  ws_message: jsonb().notNull(),  // Store the entire message payload that was missed
  created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  // Poll v2 entry version (§3.11): the UUIDv7 minted once at store time and
  // carried in the Redis value; the ack's compare-and-delete matches on it.
  // Added by 20261020a; NULL for rows written by older builds.
  entry_v: text(),
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
