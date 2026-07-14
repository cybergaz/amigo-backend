-- Admin-PIN usage history: one row per camouflage (admin-PIN) unlock.
--
-- `id` is a client-provided idempotency key (retried sends must not duplicate).
-- `created_at` is when the admin PIN was actually used (client occurred_at).
-- Idempotent — safe to re-run. Applied manually (drizzle-kit generate can't be
-- used here without reconciling pre-existing drift; see manual_add_auth_devices.sql).

CREATE TABLE IF NOT EXISTS "admin_pin_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text,
	"device_name" text,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now()
);

-- FK to users (cascade delete). Guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_pin_events_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "admin_pin_events"
      ADD CONSTRAINT "admin_pin_events_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_admin_pin_events_user" ON "admin_pin_events" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_admin_pin_events_created" ON "admin_pin_events" USING btree ("created_at");
