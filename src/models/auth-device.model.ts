import { pgTable, text, timestamp, uuid, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { user_model } from "./user.model";

// One row per logged-in MOBILE device. `token_version` is the single-device
// authority: on each login we evict the user's other device rows and bump this
// device's version, so a superseded device's long-lived JWT (which embeds the
// version it was minted at) no longer matches on the WS open check.
//
// `public_key` is unused today — it's the drop-in seam for a future device-keypair
// upgrade (register a public key here; verify a signed challenge instead of an OTP).
// Web/admin sessions are unaffected: they use refresh_sessions, not this table.
const auth_device_model = pgTable(
  "auth_devices",
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .references(() => user_model.id, { onDelete: "cascade" }),
    device_id: text().notNull(),
    token_version: integer().notNull().default(0),
    platform: text(),
    device_name: text(),
    public_key: text(), // future: device-keypair migration
    created_at: timestamp({ withTimezone: true }).defaultNow(),
    last_seen_at: timestamp({ withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_auth_devices_user_device").on(table.user_id, table.device_id),
    index("idx_auth_devices_user").on(table.user_id),
  ]
);

type AuthDeviceType = InferSelectModel<typeof auth_device_model>;
type InsertAuthDeviceType = InferInsertModel<typeof auth_device_model>;
type UpdateAuthDeviceType = Partial<InsertAuthDeviceType>;

export { auth_device_model };
export type { AuthDeviceType, InsertAuthDeviceType, UpdateAuthDeviceType };
