ALTER TABLE "calls" ADD COLUMN "provider" varchar DEFAULT 'webrtc' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "provider_call_id" varchar(128);