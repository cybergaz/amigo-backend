ALTER TABLE "users" ADD COLUMN "call_access" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "online_status" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "location" jsonb;