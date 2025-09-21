import { pgTable, serial, text, timestamp, pgEnum, bigint, char, varchar, boolean, jsonb, } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { ROLE_CONST } from "@/types/user.types";

const user_model = pgTable("users", {
  id: bigint({ mode: "number" }).primaryKey(),
  name: varchar({ length: 50 }).notNull(),
  phone: varchar({ length: 20 }).unique(),
  email: varchar({ length: 50 }).unique(),
  role: varchar({ enum: ROLE_CONST }).notNull(),
  profile_pic: text(),
  hashed_password: text(),
  refresh_token: text().notNull(),
  created_at: timestamp().defaultNow(),
  last_seen: timestamp().defaultNow(),
  call_access: boolean().default(false),
  online_status: boolean().default(false),
  location: jsonb(), // { latitude: number, longitude: number }
  ip_address: varchar({ length: 50 }), // To accommodate IPv6 addresses
  permissions: jsonb(), // Array of permitted routes for sub-admins: ["dashboard", "manage-groups", "manage-chats", "admin-management"]
});

type UserType = InferSelectModel<typeof user_model>;
type InsertUserType = InferInsertModel<typeof user_model>;
type UpdateUserType = Partial<InsertUserType>;

export { user_model };
export type { UserType, InsertUserType, UpdateUserType };
