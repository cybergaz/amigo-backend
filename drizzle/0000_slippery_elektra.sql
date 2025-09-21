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
CREATE TABLE "otps" (
	"phone" varchar(20) PRIMARY KEY NOT NULL,
	"otp" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"role" varchar NOT NULL,
	"profile_pic" text,
	"hashed_password" text,
	"refresh_token" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"last_seen" timestamp DEFAULT now(),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_creater_id_users_id_fk" FOREIGN KEY ("creater_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_conversations_id_fk" FOREIGN KEY ("forwarded_from") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
