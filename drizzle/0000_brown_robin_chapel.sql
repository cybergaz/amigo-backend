CREATE TABLE "calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"caller_id" bigint NOT NULL,
	"callee_id" bigint NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"answered_at" timestamp,
	"ended_at" timestamp,
	"duration_seconds" integer DEFAULT 0,
	"status" varchar NOT NULL,
	"reason" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" varchar,
	"unread_count" integer DEFAULT 0,
	"joined_at" timestamp DEFAULT now(),
	"deleted" boolean DEFAULT false NOT NULL,
	"last_read_message_id" bigint,
	"last_delivered_message_id" bigint
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"creater_id" bigint NOT NULL,
	"dm_key" varchar(64),
	"type" varchar NOT NULL,
	"title" varchar(255),
	"metadata" jsonb,
	"last_message_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "conversations_dm_key_unique" UNIQUE("dm_key")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" bigint,
	"sender_id" bigint NOT NULL,
	"type" varchar DEFAULT 'text' NOT NULL,
	"body" text,
	"attachments" jsonb,
	"metadata" jsonb,
	"edited_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"forwarded_from" bigint,
	"forwarded_to" bigint[]
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"group_ids" bigint[],
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otps" (
	"phone" varchar(20) PRIMARY KEY NOT NULL,
	"otp" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"phone" varchar(20),
	"email" varchar(50),
	"role" varchar NOT NULL,
	"profile_pic" text,
	"hashed_password" text,
	"refresh_token" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"last_seen" timestamp DEFAULT now(),
	"call_access" boolean DEFAULT false,
	"online_status" boolean DEFAULT false,
	"location" jsonb,
	"ip_address" varchar(50),
	"permissions" jsonb,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_users_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_creater_id_users_id_fk" FOREIGN KEY ("creater_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_conversations_id_fk" FOREIGN KEY ("forwarded_from") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;