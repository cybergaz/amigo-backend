import { pgTable, bigserial, bigint, timestamp, varchar, integer, uuid } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { user_model } from "./user.model";
import { CALL_END_REASONS_CONSTS, CALL_STATUS_CONSTS } from "@/types/call.types";

export const call_model = pgTable("calls", {
  id: uuid().primaryKey().defaultRandom(),
  caller_id: uuid().references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  callee_id: uuid().references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
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
