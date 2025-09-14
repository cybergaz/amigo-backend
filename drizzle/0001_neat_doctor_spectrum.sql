CREATE TABLE "otps" (
	"phone" varchar(15) PRIMARY KEY NOT NULL,
	"otp" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" varchar NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_pic" text;