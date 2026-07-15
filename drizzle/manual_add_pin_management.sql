-- Admin-provisioned users + admin-fulfilled PIN reset.
--
-- 1. users.must_reset_pin — TRUE for accounts whose password PIN was set BY an
--    admin (create-user, or an admin PIN reset). Forces the app's create-PIN gate
--    to make the user set their OWN password PIN (+ admin PIN if missing) on next
--    login, since the admin knows the current one. Cleared server-side when the
--    user successfully sets their password PIN (see set_user_pin). Nullable-with-
--    default ⇒ metadata-only ADD COLUMN; existing rows read false.
--
-- 2. pin_reset_requests — a user's "I forgot my PIN, please reset it" request that
--    a super admin fulfils from the panel. status pending → accepted/rejected.
--
-- Idempotent — safe to re-run. Applied manually (drizzle-kit generate can't be used
-- here without reconciling pre-existing schema drift; see manual_add_auth_devices.sql).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_reset_pin" boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS "pin_reset_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);

-- FK to users (cascade delete). Guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pin_reset_requests_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "pin_reset_requests"
      ADD CONSTRAINT "pin_reset_requests_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_pin_reset_requests_user" ON "pin_reset_requests" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_pin_reset_requests_status" ON "pin_reset_requests" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_pin_reset_requests_created" ON "pin_reset_requests" USING btree ("created_at");

-- One OPEN (pending) request per user — a retried "forgot PIN" tap must not stack
-- duplicate rows. Partial unique index; resolved rows are free to accumulate as history.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pin_reset_requests_open"
  ON "pin_reset_requests" ("user_id") WHERE "status" = 'pending';
