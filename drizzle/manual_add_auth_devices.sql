-- Mobile single-token auth: auth_devices table (additive; web/admin refresh_sessions untouched).
--
-- One row per logged-in MOBILE device. `token_version` is the single-device authority:
-- on each login we evict the user's other device rows and bump this device's version,
-- so a superseded device's long-lived JWT (which embeds the version it was minted at)
-- fails the WS open check. `public_key` is reserved for a future device-keypair upgrade.
--
-- Idempotent — safe to re-run. Applied manually (drizzle-kit generate can't be used
-- here without reconciling an unrelated pre-existing signup_requests drift).

CREATE TABLE IF NOT EXISTS "auth_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"platform" text,
	"device_name" text,
	"public_key" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone DEFAULT now()
);

-- FK to users (cascade delete). Guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_devices_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "auth_devices"
      ADD CONSTRAINT "auth_devices_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

-- (user_id, device_id) unique — the ON CONFLICT target for the single-device upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_devices_user_device" ON "auth_devices" USING btree ("user_id","device_id");
CREATE INDEX IF NOT EXISTS "idx_auth_devices_user" ON "auth_devices" USING btree ("user_id");
