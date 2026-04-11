CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_id" uuid NOT NULL,
	"callee_id" uuid NOT NULL,
	"duration_seconds" integer DEFAULT 0,
	"status" varchar NOT NULL,
	"reason" varchar,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid,
	"role" varchar,
	"last_read_msg_id" uuid,
	"last_delivered_msg_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now(),
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creater_id" uuid,
	"type" varchar NOT NULL,
	"title" varchar(255),
	"last_msg_id" uuid,
	"last_msg_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"group_ids" uuid[],
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_info" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"reaction" varchar(50),
	CONSTRAINT "message_info_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"sender_id" uuid,
	"type" varchar DEFAULT 'text' NOT NULL,
	"body" text,
	"attachments" jsonb,
	"replied_to" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "missed_ws_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" varchar NOT NULL,
	"ws_message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otps" (
	"phone" varchar(20) PRIMARY KEY NOT NULL,
	"otp" integer NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(60) NOT NULL,
	"phone" varchar(20),
	"email" varchar(50),
	"role" varchar NOT NULL,
	"profile_pic" text,
	"hashed_password" text,
	"refresh_token" text,
	"last_seen" timestamp with time zone DEFAULT now(),
	"location" jsonb,
	"ip_address" varchar(50),
	"call_access" boolean DEFAULT false,
	"permissions" jsonb,
	"fcm_token" text,
	"app_version" char(10),
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_users_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_creater_id_users_id_fk" FOREIGN KEY ("creater_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_info" ADD CONSTRAINT "message_info_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_info" ADD CONSTRAINT "message_info_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_info" ADD CONSTRAINT "message_info_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_ws_messages" ADD CONSTRAINT "missed_ws_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_chat_members_active" ON "chat_members" USING btree ("chat_id","user_id") WHERE "chat_members"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "idx_chatmemeber_chat_id_user_id_unremoved" ON "chat_members" USING btree ("chat_id","user_id") WHERE "chat_members"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "idx_chatmemeber_user_id_chat_id_unremoved" ON "chat_members" USING btree ("user_id","chat_id") WHERE "chat_members"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "idx_chats_last_message_at" ON "chats" USING btree ("last_msg_at" desc) WHERE "chats"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_messageinfo_chat_id_user_id" ON "message_info" USING btree ("chat_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_messageinfo_user_id_chat_id" ON "message_info" USING btree ("user_id","chat_id");--> statement-breakpoint
CREATE INDEX "idx_messages_chat_id_sent_at_undeleted" ON "messages" USING btree ("chat_id","sent_at" desc) WHERE "messages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_missedwsmessages_user_id" ON "missed_ws_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_phone" ON "users" USING btree ("phone");