-- Disappearing-messages feature: additive schema bump.
--
-- chats.disappearing_after_sec — null = off; otherwise messages sent into
--   this chat after the setting was enabled get expires_at stamped on insert.
-- messages.expires_at           — null = never expire; otherwise the sweeper
--   worker soft-deletes the row at/after this time.
--
-- The partial index keeps the sweeper's range scan tiny: only "alive rows
-- with a deadline" land in the index.

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "disappearing_after_sec" integer;

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

CREATE INDEX IF NOT EXISTS "idx_messages_expires_at"
  ON "messages" ("expires_at")
  WHERE "expires_at" IS NOT NULL AND "deleted_at" IS NULL;
