-- Group ownership + membership lifecycle: additive schema bump.
--
-- chats.owner_id          — current group owner (transferable). Backfilled from
--   creater_id. creater_id stays immutable; an owner must transfer ownership to
--   another member before leaving. Null for DMs.
-- chat_members.status     — "active" | "left" | "pending".
--   active  = normal member (only state that can send/receive/read).
--   left    = voluntarily left OR kicked by an admin (collapsed into one state);
--             the row is KEPT (removed_at stays NULL) so the chat still shows in
--             the user's list as a read-only shell with an "ask to join" action.
--   pending = requested to (re)join, awaiting owner/sub_admin approval.
--
-- INVARIANT: left/pending rows keep removed_at IS NULL. Every membership gate
-- therefore checks `removed_at IS NULL AND status = 'active'`, not removed_at alone.

ALTER TABLE "chats"
  ADD COLUMN IF NOT EXISTS "owner_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- Backfill ownership for every existing group from its creator.
UPDATE "chats"
  SET "owner_id" = "creater_id"
  WHERE "owner_id" IS NULL
    AND "creater_id" IS NOT NULL
    AND "type" IN ('group', 'community_group');

ALTER TABLE "chat_members"
  ADD COLUMN IF NOT EXISTS "status" varchar DEFAULT 'active' NOT NULL;

-- Keeps the "manage join requests" lookup a tiny index scan.
CREATE INDEX IF NOT EXISTS "idx_chat_members_pending"
  ON "chat_members" ("chat_id")
  WHERE "status" = 'pending' AND "removed_at" IS NULL;
