ALTER TABLE "users" ALTER COLUMN "last_seen" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "dm_key" varchar(64);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_dm_key_unique" UNIQUE("dm_key");