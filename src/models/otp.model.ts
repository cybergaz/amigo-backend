import { integer, serial, pgTable, text, bigint, varchar } from "drizzle-orm/pg-core";

const otp_model = pgTable("otps", {
  phone: varchar({ length: 15 }).primaryKey(),
  otp: integer().notNull(),
});

export { otp_model };

