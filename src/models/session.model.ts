import { pgTable, text, timestamp, uuid, varchar, index } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { user_model } from "./user.model";

// One row per logged-in device/session. Built to support multiple devices per
// account in the future; single-device is currently enforced in the auth service
// (login/signup revoke a user's other sessions) rather than by the schema.
//
// Rotation keeps a short grace window: on refresh, the outgoing token is moved to
// `prev_refresh_token` (valid until `prev_expires_at`). A client that lost its
// rotation response — e.g. during a server restart/deploy — can retry with the old
// token within that window and re-sync instead of being force-logged-out.
const refresh_session_model = pgTable(
  "refresh_sessions",
  {
    id: uuid().primaryKey().defaultRandom(), // session id (sid); stable across rotations
    user_id: uuid()
      .notNull()
      .references(() => user_model.id, { onDelete: "cascade" }),
    refresh_token: text().notNull(), // current valid refresh token
    prev_refresh_token: text(), // previous token, accepted during the grace window
    prev_expires_at: timestamp({ withTimezone: true }), // grace deadline for prev token
    user_agent: text(), // future: device label for "manage devices"
    ip_address: varchar({ length: 50 }), // future: device origin (IPv4/IPv6)
    created_at: timestamp({ withTimezone: true }).defaultNow(),
    last_used_at: timestamp({ withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_refresh_sessions_user").on(table.user_id),
    index("idx_refresh_sessions_token").on(table.refresh_token),
    index("idx_refresh_sessions_prev_token").on(table.prev_refresh_token),
  ]
);

type RefreshSessionType = InferSelectModel<typeof refresh_session_model>;
type InsertRefreshSessionType = InferInsertModel<typeof refresh_session_model>;

export { refresh_session_model };
export type { RefreshSessionType, InsertRefreshSessionType };
