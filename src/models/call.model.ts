import {
  pgTable,
  bigserial,
  bigint,
  timestamp,
  varchar,
  integer,
  uuid,
} from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { user_model } from "./user.model";
import {
  CALL_END_REASONS_CONSTS,
  CALL_PROVIDER_CONSTS,
  CALL_STATUS_CONSTS,
} from "@/types/call.types";

export const call_model = pgTable("calls", {
  id: uuid().primaryKey().defaultRandom(),
  caller_id: uuid()
    .references(() => user_model.id, { onDelete: "cascade" })
    .notNull(),
  callee_id: uuid()
    .references(() => user_model.id, { onDelete: "cascade" })
    .notNull(),
  // Which call backend produced this row. New rows from Stream Video set 'stream';
  // legacy WebRTC rows default to 'webrtc'.
  provider: varchar({ enum: CALL_PROVIDER_CONSTS }).notNull().default("webrtc"),
  // Provider-specific external id (e.g. Stream call cid "default:<uuid>").
  provider_call_id: varchar({ length: 128 }),
  duration_seconds: integer().default(0),
  status: varchar({ enum: CALL_STATUS_CONSTS }).notNull(),
  reason: varchar({ enum: CALL_END_REASONS_CONSTS }),
  started_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  answered_at: timestamp({ withTimezone: true }),
  ended_at: timestamp({ withTimezone: true }),
});

export const livekit_call_model = pgTable("livekit_calls", {
  id: uuid().primaryKey().defaultRandom(),
  caller_id: uuid()
    .references(() => user_model.id, { onDelete: "cascade" })
    .notNull(),
  callee_id: uuid()
    .references(() => user_model.id, { onDelete: "cascade" })
    .notNull(),
  // Which call backend produced this row. New rows from Stream Video set 'stream';
  // legacy WebRTC rows default to 'webrtc'.
  // provider: varchar({ enum: CALL_PROVIDER_CONSTS }).notNull().default("webrtc"),
  // Provider-specific external id (e.g. Stream call cid "default:<uuid>").
  // provider_call_id: varchar({ length: 128 }),
  duration_seconds: integer().default(0),
  status: varchar({ enum: CALL_STATUS_CONSTS }).notNull(),
  reason: varchar({ enum: CALL_END_REASONS_CONSTS }),
  started_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  answered_at: timestamp({ withTimezone: true }),
  ended_at: timestamp({ withTimezone: true }),
});

export type CallType = InferSelectModel<typeof call_model>;
export type InsertCallType = InferInsertModel<typeof call_model>;
export type UpdateCallType = Partial<InsertCallType>;

export type LivekitCallType = InferSelectModel<typeof livekit_call_model>;
export type LivekitInsertCall = InferInsertModel<typeof livekit_call_model>;
export type LivekitUpdateCallType = Partial<LivekitInsertCall>;
