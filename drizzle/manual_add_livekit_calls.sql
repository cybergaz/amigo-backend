-- LiveKit call history — a separate ledger from the legacy calls table so the
-- WebRTC/Stream rows and their provider columns stay untouched while LiveKit
-- runs alongside them. Mirrors calls minus the provider discriminators.
--
-- Idempotent — safe to re-run. Applied manually (drizzle-kit generate can't be
-- used here without reconciling pre-existing schema drift; see
-- manual_add_auth_devices.sql).

CREATE TABLE IF NOT EXISTS "livekit_calls" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "caller_id" uuid NOT NULL,
    "callee_id" uuid NOT NULL,
    "duration_seconds" integer DEFAULT 0,
    "status" varchar NOT NULL,
    "reason" varchar,
    "started_at" timestamp with time zone DEFAULT now() NOT NULL,
    "answered_at" timestamp with time zone,
    "ended_at" timestamp with time zone
);

-- FKs to users (cascade delete). Guarded — Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'livekit_calls_caller_id_users_id_fk'
    ) THEN
        ALTER TABLE "livekit_calls"
            ADD CONSTRAINT "livekit_calls_caller_id_users_id_fk"
            FOREIGN KEY ("caller_id")
            REFERENCES "public"."users"("id")
            ON DELETE CASCADE
            ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'livekit_calls_callee_id_users_id_fk'
    ) THEN
        ALTER TABLE "livekit_calls"
            ADD CONSTRAINT "livekit_calls_callee_id_users_id_fk"
            FOREIGN KEY ("callee_id")
            REFERENCES "public"."users"("id")
            ON DELETE CASCADE
            ON UPDATE NO ACTION;
    END IF;
END
$$;

-- Call-log reads are "my calls, newest first" from either side of the leg.
CREATE INDEX IF NOT EXISTS "idx_livekit_calls_caller_started"
ON "livekit_calls" USING btree (
    "caller_id",
    "started_at" DESC
);

CREATE INDEX IF NOT EXISTS "idx_livekit_calls_callee_started"
ON "livekit_calls" USING btree (
    "callee_id",
    "started_at" DESC
);

CREATE INDEX IF NOT EXISTS "idx_livekit_calls_started"
ON "livekit_calls" USING btree (
    "started_at" DESC
);