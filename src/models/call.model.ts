import { pgTable, bigserial, bigint, timestamp, varchar, integer } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { user_model } from "./user.model";

export const CALL_STATUS_CONSTS = [
  "initiated",
  "ringing", 
  "answered",
  "ended",
  "missed",
  "declined"
] as const;

export const call_model = pgTable("calls", {
  id: bigserial({ mode: "number" }).primaryKey(),
  caller_id: bigint({ mode: "number" }).references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  callee_id: bigint({ mode: "number" }).references(() => user_model.id, { onDelete: 'cascade' }).notNull(),
  started_at: timestamp().defaultNow().notNull(),
  answered_at: timestamp(),
  ended_at: timestamp(),
  duration_seconds: integer().default(0),
  status: varchar({ enum: CALL_STATUS_CONSTS }).notNull(),
  reason: varchar(),
  created_at: timestamp().defaultNow().notNull(),
});

export type CallType = InferSelectModel<typeof call_model>;
export type InsertCallType = InferInsertModel<typeof call_model>;
export type UpdateCallType = Partial<InsertCallType>;
