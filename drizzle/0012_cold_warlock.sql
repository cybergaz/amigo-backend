CREATE TABLE "signup_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"first_name" varchar(50) NOT NULL,
	"last_name" varchar(50) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "signup_requests_phone_unique" UNIQUE("phone")
);
