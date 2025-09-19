ALTER TABLE "otps" ALTER COLUMN "phone" SET DATA TYPE varchar(20);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deleted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen" timestamp;