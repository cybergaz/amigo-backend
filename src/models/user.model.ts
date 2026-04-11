import { pgTable, text, timestamp, char, varchar, boolean, jsonb, bigserial, uuid, uniqueIndex, } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { ROLE_CONST, REQUEST_STATUS_CONST } from "@/types/user.types";
import { chat_model } from "./chat.model";

const user_model = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  name: varchar({ length: 60 }).notNull(),
  phone: varchar({ length: 20 }).unique(),
  email: varchar({ length: 50 }).unique(),
  role: varchar({ enum: ROLE_CONST }).notNull(),
  profile_pic: text(),
  hashed_password: text(),
  refresh_token: text(),
  last_seen: timestamp({ withTimezone: true }).defaultNow(),
  location: jsonb(), // { latitude: number, longitude: number }
  ip_address: varchar({ length: 50 }), // To accommodate IPv6 addresses
  call_access: boolean().default(false),
  permissions: jsonb(), // Array of permitted routes for sub-admins: ["dashboard", "manage-groups", "manage-chats", "admin-management"]
  fcm_token: text(), // Firebase Cloud Messaging token for push notifications
  app_version: char({ length: 10 }), // To track the app version the user is on
  created_at: timestamp({ withTimezone: true }).defaultNow(),
  // online_status: boolean().default(false),
  // connection_status: varchar({ enum: CONNECTION_STATUS_CONST }),
}, (table) => [
  uniqueIndex("idx_users_phone").on(table.phone)
]);

const signup_request_model = pgTable("signup_requests", {
  id: bigserial({ mode: "number" }).primaryKey(),
  first_name: varchar({ length: 50 }).notNull(),
  last_name: varchar({ length: 50 }).notNull(),
  phone: varchar({ length: 20 }).unique().notNull(),
  status: varchar({ enum: REQUEST_STATUS_CONST }).default("pending").notNull(),
  rejected_reason: text(),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
});

type SignupRequestType = InferSelectModel<typeof signup_request_model>;
type InsertSignupRequestType = InferInsertModel<typeof signup_request_model>;
type UpdateSignupRequestType = Partial<InsertSignupRequestType>;

type UserType = InferSelectModel<typeof user_model>;
type InsertUserType = InferInsertModel<typeof user_model>;
type UpdateUserType = Partial<InsertUserType>;

export { user_model, signup_request_model };
export type { UserType, InsertUserType, UpdateUserType, SignupRequestType, InsertSignupRequestType, UpdateSignupRequestType };
