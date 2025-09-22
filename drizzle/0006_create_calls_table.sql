-- Create calls table for audio call functionality
CREATE TABLE IF NOT EXISTS "calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"caller_id" bigint NOT NULL,
	"callee_id" bigint NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"answered_at" timestamp,
	"ended_at" timestamp,
	"duration_seconds" integer DEFAULT 0,
	"status" varchar NOT NULL CHECK ("status" IN ('initiated', 'ringing', 'answered', 'ended', 'missed', 'declined')),
	"reason" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Add foreign key constraints
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE cascade;
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_users_id_fk" FOREIGN KEY ("callee_id") REFERENCES "users"("id") ON DELETE cascade;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS "calls_caller_id_idx" ON "calls" ("caller_id");
CREATE INDEX IF NOT EXISTS "calls_callee_id_idx" ON "calls" ("callee_id");
CREATE INDEX IF NOT EXISTS "calls_status_idx" ON "calls" ("status");
CREATE INDEX IF NOT EXISTS "calls_created_at_idx" ON "calls" ("created_at");
