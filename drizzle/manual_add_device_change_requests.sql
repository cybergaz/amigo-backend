-- Device-change requests: a user's request to move their account to a new device,
-- reviewed by an admin. Storage behind the single-device LOCK (see
-- device-change-request.model.ts / device-change-request.service.ts).
--
-- Idempotent — safe to re-run. Applied manually (drizzle-kit generate can't be
-- used here without reconciling pre-existing drift; see manual_add_auth_devices.sql).

CREATE TABLE IF NOT EXISTS "device_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"current_device_id" text,
	"current_device_name" text,
	"requested_device_id" text,
	"device_name" text,
	"platform" text,
	"reason" text,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);

-- FK to users (cascade delete). Guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_change_requests_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "device_change_requests"
      ADD CONSTRAINT "device_change_requests_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

-- FK to the reviewing admin (no cascade — keep the audit trail if the admin row goes).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_change_requests_reviewed_by_users_id_fk'
  ) THEN
    ALTER TABLE "device_change_requests"
      ADD CONSTRAINT "device_change_requests_reviewed_by_users_id_fk"
      FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_device_change_req_user" ON "device_change_requests" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_device_change_req_status" ON "device_change_requests" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_device_change_req_created" ON "device_change_requests" USING btree ("created_at");

-- At most one OPEN (pending) request per user (partial unique). The service layer
-- replaces an existing pending request; this is the integrity backstop.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_device_change_req_one_pending"
  ON "device_change_requests" USING btree ("user_id") WHERE "status" = 'pending';
