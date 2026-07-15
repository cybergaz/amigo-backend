import { pgTable, varchar, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { REQUEST_STATUS_CONST } from "@/types/user.types";
import { user_model } from "./user.model";

// A user-raised "I forgot my PIN, please reset it" request, fulfilled by a super
// admin from the panel. The user has no self-service OTP reset — a forgotten PIN
// is recovered by an admin setting a new one (which flips users.must_reset_pin so
// the user must then set their own; see set_user_pin / admin_set_user_password_pin).
//
// A partial unique index (see manual_add_pin_management.sql) keeps at most ONE
// `pending` row per user, so a retried request is idempotent; resolved rows stay
// as history. `resolved_by` is the admin who actioned it.
const pin_reset_request_model = pgTable(
  "pin_reset_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .references(() => user_model.id, { onDelete: "cascade" }),
    status: varchar({ enum: REQUEST_STATUS_CONST }).default("pending").notNull(),
    resolved_by: uuid(),
    resolved_at: timestamp({ withTimezone: true }),
    created_at: timestamp({ withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_pin_reset_requests_user").on(table.user_id),
    index("idx_pin_reset_requests_status").on(table.status),
    index("idx_pin_reset_requests_created").on(table.created_at),
  ]
);

type PinResetRequestType = InferSelectModel<typeof pin_reset_request_model>;
type InsertPinResetRequestType = InferInsertModel<typeof pin_reset_request_model>;

export { pin_reset_request_model };
export type { PinResetRequestType, InsertPinResetRequestType };
