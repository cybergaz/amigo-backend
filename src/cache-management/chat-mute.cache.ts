import { redis } from "@/config/redis";
import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { and, eq, gt, isNull } from "drizzle-orm";

// ============================================================================
// Per-chat mute cache.
//
// Redis key:   chat_mute:{chat_id}
// Type:        sorted set (ZSET)
// Member:      user_id of a member who has muted this chat
// Score:       muted_until epoch-millis
//
// Send-path query:  ZRANGEBYSCORE chat_mute:{chat_id} (now +inf
//                   → user_ids whose mute hasn't expired yet.
//
// Expired entries are not actively swept — they fall out of the query above
// because their score is <= now(). They get re-evaluated and either left in
// place (next mute extends it) or ZREMmed on the next mute/unmute API call.
//
// Cache miss is "the chat has nothing in Redis yet". We hydrate from
// chat_members (active members with muted_until > now()) on demand and stamp
// a TTL so abandoned chats don't keep a key forever.
// ============================================================================

const CACHE_TTL_SECONDS = 24 * 60 * 60;       // 1 day
const HYDRATED_FLAG_TTL_SECONDS = 24 * 60 * 60;

const chat_mute_key = (chat_id: string) => `chat_mute:${chat_id}`;
// Companion key so we can tell "empty muted set" from "never hydrated".
// A ZSET with 0 members is indistinguishable from an absent key in Redis.
const chat_mute_hydrated_key = (chat_id: string) => `chat_mute:${chat_id}:hydrated`;

// ---------------------------------------------------------------------------
// Lazy hydration from DB. Called on a cache miss in get_muted_user_ids.
// Idempotent: re-hydrating an already-hydrated chat is harmless.
// ---------------------------------------------------------------------------
const hydrate_from_db = async (chat_id: string): Promise<void> => {
  try {
    const now = new Date();
    const rows = await db
      .select({
        user_id: chat_member_model.user_id,
        muted_until: chat_member_model.muted_until,
      })
      .from(chat_member_model)
      .where(and(
        eq(chat_member_model.chat_id, chat_id),
        isNull(chat_member_model.removed_at),
        gt(chat_member_model.muted_until, now),
      ));

    const key = chat_mute_key(chat_id);
    const hydrated_key = chat_mute_hydrated_key(chat_id);

    // Use a pipeline so the hydration is one round-trip even with many rows.
    const pipe = redis.pipeline();
    // Mark hydrated even if the set ends up empty.
    pipe.set(hydrated_key, "1", "EX", HYDRATED_FLAG_TTL_SECONDS);
    for (const r of rows) {
      if (!r.user_id || !r.muted_until) continue;
      pipe.zadd(key, r.muted_until.getTime(), r.user_id);
    }
    if (rows.length > 0) {
      pipe.expire(key, CACHE_TTL_SECONDS);
    }
    await pipe.exec();
  } catch (err) {
    console.error(`[CHAT-MUTE] hydrate error for chat ${chat_id}:`, err);
  }
};

// ---------------------------------------------------------------------------
// READ — currently-muted user_ids for a chat.
// Cache miss → DB hydrate → return.
// ---------------------------------------------------------------------------
const get_muted_user_ids = async (chat_id: string): Promise<Set<string>> => {
  try {
    const hydrated_key = chat_mute_hydrated_key(chat_id);
    const hydrated = await redis.get(hydrated_key);
    if (hydrated === null) {
      await hydrate_from_db(chat_id);
    }

    const now_ms = Date.now();
    // Exclusive lower bound: we want muted_until strictly greater than now.
    const ids = await redis.zrangebyscore(
      chat_mute_key(chat_id),
      `(${now_ms}`,
      "+inf",
    );
    return new Set(ids);
  } catch (err) {
    console.error(`[CHAT-MUTE] get_muted_user_ids error for chat ${chat_id}:`, err);
    return new Set();
  }
};

// ---------------------------------------------------------------------------
// WRITE — set/extend a single user's mute for a chat.
// Writes DB (source of truth) and Redis (send-path cache) together.
// ---------------------------------------------------------------------------
const set_chat_mute = async (
  user_id: string,
  chat_id: string,
  muted_until: Date,
): Promise<void> => {
  // DB first so the source of truth is correct if Redis errors. Update
  // only the active membership row for this user; matches the partial
  // index we use elsewhere on chat_members.
  await db
    .update(chat_member_model)
    .set({ muted_until })
    .where(and(
      eq(chat_member_model.chat_id, chat_id),
      eq(chat_member_model.user_id, user_id),
      isNull(chat_member_model.removed_at),
    ));

  try {
    const key = chat_mute_key(chat_id);
    const hydrated_key = chat_mute_hydrated_key(chat_id);
    const pipe = redis.pipeline();
    pipe.zadd(key, muted_until.getTime(), user_id);
    pipe.expire(key, CACHE_TTL_SECONDS);
    // Ensure subsequent reads skip DB hydration.
    pipe.set(hydrated_key, "1", "EX", HYDRATED_FLAG_TTL_SECONDS);
    await pipe.exec();
  } catch (err) {
    console.error(`[CHAT-MUTE] redis set error for ${user_id}@${chat_id}:`, err);
  }
};

// ---------------------------------------------------------------------------
// CLEAR — remove a user's mute for a chat.
// ---------------------------------------------------------------------------
const clear_chat_mute = async (user_id: string, chat_id: string): Promise<void> => {
  await db
    .update(chat_member_model)
    .set({ muted_until: null })
    .where(and(
      eq(chat_member_model.chat_id, chat_id),
      eq(chat_member_model.user_id, user_id),
      isNull(chat_member_model.removed_at),
    ));

  try {
    await redis.zrem(chat_mute_key(chat_id), user_id);
  } catch (err) {
    console.error(`[CHAT-MUTE] redis clear error for ${user_id}@${chat_id}:`, err);
  }
};

// ---------------------------------------------------------------------------
// INVALIDATE — drop the cache for a chat. Used when membership changes in
// ways that could leave a stale user_id in the ZSET (e.g. member removed).
// Next read re-hydrates.
// ---------------------------------------------------------------------------
const invalidate_chat_mute = async (chat_id: string): Promise<void> => {
  try {
    await redis.del(chat_mute_key(chat_id), chat_mute_hydrated_key(chat_id));
  } catch (err) {
    console.error(`[CHAT-MUTE] redis invalidate error for ${chat_id}:`, err);
  }
};

export {
  get_muted_user_ids,
  set_chat_mute,
  clear_chat_mute,
  invalidate_chat_mute,
};
