import { pgTable, unique, bigint, varchar, text, timestamp } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const users = pgTable("users", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().notNull(),
	name: varchar({ length: 50 }).notNull(),
	phone: varchar({ length: 20 }).notNull(),
	hashedPassword: text("hashed_password"),
	refreshToken: text("refresh_token").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
}, (table) => [
	unique("users_phone_unique").on(table.phone),
]);
