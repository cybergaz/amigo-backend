ALTER TABLE "community_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "community_members" CASCADE;--> statement-breakpoint
ALTER TABLE "communities" DROP CONSTRAINT "communities_super_admin_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "group_ids" bigint[];--> statement-breakpoint
ALTER TABLE "communities" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "communities" DROP COLUMN "super_admin_id";