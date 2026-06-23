-- Collapse signup_requests.first_name + last_name into a single `name` column.
-- Data-preserving: backfills existing rows before dropping the old columns.
-- Run manually against the DB (psql / drizzle studio) — do NOT rely on
-- `drizzle-kit push` for this, as it would drop the columns and lose data.

ALTER TABLE "signup_requests" ADD COLUMN "name" varchar(100);

UPDATE "signup_requests"
SET "name" = trim(both ' ' from coalesce("first_name", '') || ' ' || coalesce("last_name", ''));

ALTER TABLE "signup_requests" ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "signup_requests" DROP COLUMN "first_name";
ALTER TABLE "signup_requests" DROP COLUMN "last_name";
