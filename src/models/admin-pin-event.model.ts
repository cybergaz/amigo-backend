import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { user_model } from "./user.model";

// Records each time a user unlocks the app with their ADMIN PIN (i.e. enters the
// camouflage / duress decoy). Surfaced on the admin panel as an "Admin PIN Usage"
// history so a super admin can see who triggered it, on which device, and when —
// and resolve (delete) an entry once handled.
//
// `id` is a CLIENT-provided event id (idempotency key): the app may retry a send
// (offline → back online), so the insert is onConflictDoNothing on this PK to
// avoid duplicate rows. `created_at` is the moment the admin PIN was actually
// used (client-supplied occurred_at), NOT the moment it reached the server, so a
// retried event keeps its real time.
const admin_pin_event_model = pgTable(
  "admin_pin_events",
  {
    id: uuid().primaryKey(),
    user_id: uuid()
      .notNull()
      .references(() => user_model.id, { onDelete: "cascade" }),
    device_id: text(),
    device_name: text(),
    platform: text(),
    created_at: timestamp({ withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_admin_pin_events_user").on(table.user_id),
    index("idx_admin_pin_events_created").on(table.created_at),
  ]
);

type AdminPinEventType = InferSelectModel<typeof admin_pin_event_model>;
type InsertAdminPinEventType = InferInsertModel<typeof admin_pin_event_model>;

export { admin_pin_event_model };
export type { AdminPinEventType, InsertAdminPinEventType };
