ALTER TABLE "chat_members" ADD COLUMN "status" varchar DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_members_pending" ON "chat_members" USING btree ("chat_id") WHERE ("chat_members"."status" = $1 and "chat_members"."removed_at" is null);