ALTER TABLE "chats" ADD COLUMN "disappearing_after_sec" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp with time zone;