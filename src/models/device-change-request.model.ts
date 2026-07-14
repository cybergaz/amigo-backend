import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel, sql } from "drizzle-orm";
import { user_model } from "./user.model";
import { REQUEST_STATUS_CONST } from "@/types/user.types";

// A user's request to move their account from its currently-registered device to a
// new one, reviewed by an admin. This is the storage behind the single-device LOCK:
// login_device() is destructive last-login-wins, so on its own a new device would
// silently take over. The pre-mint gate (device-change-request.service.ts →
// is_device_allowed) refuses a *different* device UNLESS there is an `accepted`,
// unconsumed request for it, flipping the default to locked-first-device.
//
// `requested_device_id` semantics:
//   - set    → the request names a SPECIFIC new device (came from the blocked new
//              device itself); approval admits only that device.
//   - null   → a WILDCARD request (came from the OLD device via Settings, which
//              can't know the future device's id); approval admits the NEXT new
//              device to log in, once.
// Either way the approval is single-use: `consumed_at` is stamped the moment the
// new device completes login (it then becomes the registered device via the
// existing login_device eviction, so the old device is auto-logged-out for free).
const device_change_request_model = pgTable(
  "device_change_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .references(() => user_model.id, { onDelete: "cascade" }),
    // The device being replaced (populated server-side from auth_devices), for
    // admin context. Informational only.
    current_device_id: text(),
    current_device_name: text(),
    // The new device asking in. Null = wildcard (see header).
    requested_device_id: text(),
    device_name: text(), // new device label
    platform: text(), // new device platform
    reason: text(), // optional user note
    status: varchar({ enum: REQUEST_STATUS_CONST }).default("pending").notNull(),
    reviewed_by: uuid().references(() => user_model.id), // acting admin
    reviewed_at: timestamp({ withTimezone: true }),
    review_note: text(), // admin's deny reason
    consumed_at: timestamp({ withTimezone: true }), // single-use marker
    created_at: timestamp({ withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_device_change_req_user").on(table.user_id),
    index("idx_device_change_req_status").on(table.status),
    index("idx_device_change_req_created").on(table.created_at),
    // At most one OPEN (pending) request per user — a new request replaces the
    // old one in the service layer; this is the integrity backstop.
    uniqueIndex("idx_device_change_req_one_pending")
      .on(table.user_id)
      .where(sql`${table.status} = 'pending'`),
  ]
);

type DeviceChangeRequestType = InferSelectModel<typeof device_change_request_model>;
type InsertDeviceChangeRequestType = InferInsertModel<typeof device_change_request_model>;

export { device_change_request_model };
export type { DeviceChangeRequestType, InsertDeviceChangeRequestType };
