import { integer, pgTable, varchar, timestamp } from "drizzle-orm/pg-core";

// One outstanding OTP per phone. Requesting a new code for any purpose overwrites
// the previous row, so a user can never hold two live codes at once.
//
// `purpose` SCOPES the code: an OTP minted to reset a forgotten PIN must not be
// replayable against the login endpoint (and vice versa), so verify_otp requires
// the purpose to match what was issued.
//
// `expires_at` is the authority on freshness — rows are left in place after expiry
// (harmless, overwritten on the next request) rather than swept.
const OTP_PURPOSES = ["signup", "login", "pin_reset", "admin_pin", "phone_change"] as const;
type OtpPurpose = (typeof OTP_PURPOSES)[number];

const otp_model = pgTable("otps", {
  phone: varchar({ length: 20 }).primaryKey(),
  otp: integer().notNull(),
  // Nullable + defaulted so the columns can be added to a live table without a
  // backfill; rows written before this migration verify as legacy (see verify_otp).
  purpose: varchar({ length: 20, enum: OTP_PURPOSES }),
  channel: varchar({ length: 20 }),
  expires_at: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
});

export { otp_model, OTP_PURPOSES };
export type { OtpPurpose };
