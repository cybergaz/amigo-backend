-- Mute-chat feature: additive schema bump.
--
-- chat_members.muted_until — null = not muted; future timestamp = muted until
--   that time; past timestamp = effectively not muted (the send path uses
--   ZRANGEBYSCORE muted_until > now() so expired entries fall off naturally
--   without a sweeper).
--
-- The partial index keeps "currently muted" lookups by user cheap and
-- excludes the (very large) NULL set.

ALTER TABLE "chat_members"
  ADD COLUMN IF NOT EXISTS "muted_until" timestamptz;

CREATE INDEX IF NOT EXISTS "idx_chat_members_muted_until"
  ON "chat_members" ("user_id", "chat_id")
  WHERE "muted_until" IS NOT NULL AND "removed_at" IS NULL;
