CREATE TABLE "refresh_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token" text NOT NULL,
	"prev_refresh_token" text,
	"prev_expires_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" varchar(50),
	"created_at" timestamp with time zone DEFAULT now(),
	"last_used_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_refresh_sessions_user" ON "refresh_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_sessions_token" ON "refresh_sessions" USING btree ("refresh_token");--> statement-breakpoint
CREATE INDEX "idx_refresh_sessions_prev_token" ON "refresh_sessions" USING btree ("prev_refresh_token");