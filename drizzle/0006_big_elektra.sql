ALTER TABLE "calls" ALTER COLUMN "started_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "answered_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "ended_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "created_at" SET DEFAULT now();