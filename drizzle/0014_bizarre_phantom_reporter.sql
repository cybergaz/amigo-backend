CREATE TABLE "missed_ws_messages" (
	"id" varchar(60) PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"event_type" varchar NOT NULL,
	"ws_message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "missed_ws_messages" ADD CONSTRAINT "missed_ws_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_missed_messages_user_id" ON "missed_ws_messages" USING btree ("user_id","created_at");