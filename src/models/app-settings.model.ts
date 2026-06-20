import { pgTable, jsonb, timestamp, varchar, uuid } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { user_model } from "./user.model";

// Generic key/value store for app-wide global settings managed by the super
// admin (e.g. the marquee banner). Kept intentionally generic — one row per
// setting keyed by `key`, payload in `value` — so future global toggles reuse
// this table without a new migration.
const app_settings_model = pgTable("app_settings", {
  key: varchar({ length: 64 }).primaryKey(), // e.g. "marquee_banner"
  value: jsonb(), // setting-specific payload, e.g. { text, enabled }
  updated_by: uuid().references(() => user_model.id),
  updated_at: timestamp({ withTimezone: true }).defaultNow(),
});

type AppSettingType = InferSelectModel<typeof app_settings_model>;
type InsertAppSettingType = InferInsertModel<typeof app_settings_model>;

export { app_settings_model };
export type { AppSettingType, InsertAppSettingType };
