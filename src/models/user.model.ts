import { pgTable, serial, text, timestamp, pgEnum, bigint, char, varchar, boolean, } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { ROLE_CONST } from "@/types/user.types";

const user_model = pgTable("users", {
  id: bigint({ mode: "number" }).primaryKey(),
  name: varchar({ length: 50 }).notNull(),
  phone: varchar({ length: 20 }).notNull().unique(),
  role: varchar({ enum: ROLE_CONST }).notNull(),
  profile_pic: text(),
  hashed_password: text(),
  refresh_token: text().notNull(),
  created_at: timestamp().defaultNow(),
  last_seen: timestamp().defaultNow(),
});

type UserType = InferSelectModel<typeof user_model>;
type InsertUserType = InferInsertModel<typeof user_model>;
type UpdateUserType = Partial<InsertUserType>;

export { user_model };
export type { UserType, InsertUserType, UpdateUserType };
