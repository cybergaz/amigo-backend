import { pgTable, serial, text, timestamp, pgEnum, bigint, char, varchar, boolean, } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";

const user_model = pgTable("users", {
  id: bigint({ mode: "number" }).primaryKey(),
  name: varchar({ length: 50 }).notNull(),
  phone: varchar({ length: 20 }).notNull().unique(),
  hashed_password: text(),
  refresh_token: text().notNull(),
  created_at: timestamp().defaultNow(),
});

type UserType = InferSelectModel<typeof user_model>;
type InsertUserType = InferInsertModel<typeof user_model>;
type UpdateUserType = Partial<Omit<InsertUserType, 'id' | 'created_at'>>;

export { user_model };
export type { UserType, InsertUserType, UpdateUserType };
