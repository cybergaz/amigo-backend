-- Manual migration: adds Stream Video provider columns to the `calls` table.
-- Apply by running `bun run db:genpush` (preferred — keeps drizzle journal in
-- sync) or by executing the statements below directly against the database.
--
-- Idempotent: safe to re-run.

ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "provider" varchar NOT NULL DEFAULT 'webrtc';

ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "provider_call_id" varchar(128);

CREATE INDEX IF NOT EXISTS "idx_calls_provider_call_id"
  ON "calls" ("provider_call_id");
