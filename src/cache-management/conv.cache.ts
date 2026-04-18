import "dotenv/config"
import LRUCache from '@/utils/cache.utils';
import { get_new_redis_client, redis } from '@/config/redis';
import db from '@/config/db';
import { chat_member_model } from '@/models/chat.model';
import { and, eq, isNull } from 'drizzle-orm';

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not defined in environment variables can't proceed");
}

// ────────────────────────────────────────────────────────────────────────────
// 3-tier membership caches
//   conv_user_cache (LRU, 1–5 min)  ─┐
//   redis "conv:{id}:members" set    ├─ chat_id → user_ids
//   chat_member_model (DB)          ─┘
//
//   user_conv_cache (LRU, 5 min)    ─┐
//   redis "user_conv:{id}" set       ├─ user_id → chat_ids
//   chat_member_model (DB)          ─┘
// ────────────────────────────────────────────────────────────────────────────

const conv_user_cache = new LRUCache<string, Set<string>>(); // chat_id -> user_ids
const user_conv_cache = new LRUCache<string, Set<string>>(); // user_id -> chat_ids

const REDIS_TTL_SEC = 24 * 60 * 60;             // 24h
const USER_CONV_LRU_TTL_MS = 5 * 60 * 1000;     // 5 min

const conv_members_key = (chat_id: string) => `conv:${chat_id}:members`;
const user_conv_key = (user_id: string) => `user_conv:${user_id}`;

// ────────────────────────────────────────────────────────────────────────────
// Pub/sub invalidation
//
// Channel: "conv:invalidate"
// Payloads accepted (subscriber):
//   bare id     → treated as chat_id (legacy publishers)
//   "conv:{id}" → chat_id invalidation
//   "user:{id}" → user_id invalidation
// ────────────────────────────────────────────────────────────────────────────

const INVALIDATE_CHANNEL = "conv:invalidate";

const sub = get_new_redis_client(process.env.REDIS_URL);
sub.subscribe(INVALIDATE_CHANNEL, (err, count) => {
  if (err) {
    console.error("Failed to subscribe: ", err);
  } else {
    console.log(`Subscribed successfully to "${INVALIDATE_CHANNEL}", This client is currently subscribed to ${count} channels.`);
  }
});

sub.on("message", (channel, message) => {
  if (channel !== INVALIDATE_CHANNEL) return;
  const idx = message.indexOf(":");
  if (idx < 0) {
    // Legacy bare-id payload — assume chat_id
    conv_user_cache.delete(message);
    return;
  }
  const kind = message.slice(0, idx);
  const id = message.slice(idx + 1);
  if (kind === "conv") {
    conv_user_cache.delete(id);
  } else if (kind === "user") {
    user_conv_cache.delete(id);
  }
});

const publish_conv_invalidation = async (chat_id: string): Promise<void> => {
  try {
    await redis.publish(INVALIDATE_CHANNEL, `conv:${chat_id}`);
  } catch (err) {
    console.error(`[CACHE] publish_conv_invalidation failed (${chat_id}):`, err);
  }
};

const publish_user_conv_invalidation = async (user_id: string): Promise<void> => {
  try {
    await redis.publish(INVALIDATE_CHANNEL, `user:${user_id}`);
  } catch (err) {
    console.error(`[CACHE] publish_user_conv_invalidation failed (${user_id}):`, err);
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Reads (3-tier)
// ────────────────────────────────────────────────────────────────────────────

const get_conversation_members = async (conv_id: string): Promise<Set<string>> => {
  const cached = conv_user_cache.get(conv_id);
  if (cached !== null) return cached;

  try {
    const redis_key = conv_members_key(conv_id);
    const member_strings = await redis.smembers(redis_key);

    let members: Set<string>;
    if (member_strings.length > 0) {
      members = new Set<string>(member_strings);
    } else {
      const db_members = await db
        .select({ user_id: chat_member_model.user_id })
        .from(chat_member_model)
        .where(
          and(
            eq(chat_member_model.chat_id, conv_id),
            isNull(chat_member_model.removed_at)
          )
        );

      members = new Set<string>(
        db_members
          .map((m) => m.user_id)
          .filter((id): id is string => id !== null)
      );

      // Hydrate Redis (single round-trip via pipeline)
      if (members.size > 0) {
        const pipe = redis.pipeline();
        pipe.sadd(redis_key, ...Array.from(members));
        pipe.expire(redis_key, REDIS_TTL_SEC);
        await pipe.exec();
      }
    }

    // Random LRU TTL between 1–5 min so caches don't all expire together
    const randomTTL = Math.floor(Math.random() * (300000 - 60000 + 1)) + 60000;
    conv_user_cache.set(conv_id, members, randomTTL);

    return members;
  } catch (error) {
    console.error(`[CACHE] Error fetching conversation members for conv_id ${conv_id}:`, error);
    return new Set<string>();
  }
};

const get_user_conversations = async (user_id: string): Promise<Set<string>> => {
  const cached = user_conv_cache.get(user_id);
  if (cached !== null) return cached;

  try {
    const redis_key = user_conv_key(user_id);
    const cached_ids = await redis.smembers(redis_key);

    let conv_set: Set<string>;
    if (cached_ids.length > 0) {
      conv_set = new Set(cached_ids);
    } else {
      const conversations = await db
        .select({ chat_id: chat_member_model.chat_id })
        .from(chat_member_model)
        .where(
          and(
            eq(chat_member_model.user_id, user_id),
            isNull(chat_member_model.removed_at)
          )
        );

      conv_set = new Set(
        conversations
          .map(c => c.chat_id)
          .filter((id): id is string => id !== null)
      );

      if (conv_set.size > 0) {
        const pipe = redis.pipeline();
        pipe.sadd(redis_key, ...Array.from(conv_set));
        pipe.expire(redis_key, REDIS_TTL_SEC);
        await pipe.exec();
      }
    }

    user_conv_cache.set(user_id, conv_set, USER_CONV_LRU_TTL_MS);
    return conv_set;
  } catch (error) {
    console.error(`[CACHE] Error fetching user conversations for user_id ${user_id}:`, error);
    return new Set<string>();
  }
};

const is_member = async (user_id: string, chat_id: string): Promise<boolean> => {
  // Cheap path: hit the LRU sets if warm
  const cached_members = conv_user_cache.get(chat_id);
  if (cached_members !== null) return cached_members.has(user_id);
  const cached_convs = user_conv_cache.get(user_id);
  if (cached_convs !== null) return cached_convs.has(chat_id);

  try {
    const res = await redis.sismember(conv_members_key(chat_id), user_id);
    if (res === 1) return true;
    // Cold cache fallback — load full set (which also rehydrates Redis)
    const members = await get_conversation_members(chat_id);
    return members.has(user_id);
  } catch (err) {
    console.error(`[CACHE] is_member failed (${user_id}, ${chat_id}):`, err);
    return false;
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Mutators — keep both Redis sets in sync, drop affected LRU entries locally,
// and notify other instances via pub/sub.
// ────────────────────────────────────────────────────────────────────────────

const add_member = async (user_id: string, chat_id: string): Promise<void> => {
  try {
    const pipe = redis.pipeline();
    pipe.sadd(conv_members_key(chat_id), user_id);
    pipe.expire(conv_members_key(chat_id), REDIS_TTL_SEC);
    pipe.sadd(user_conv_key(user_id), chat_id);
    pipe.expire(user_conv_key(user_id), REDIS_TTL_SEC);
    await pipe.exec();

    conv_user_cache.delete(chat_id);
    user_conv_cache.delete(user_id);
    await publish_conv_invalidation(chat_id);
    await publish_user_conv_invalidation(user_id);
  } catch (err) {
    console.error(`[CACHE] add_member failed (${user_id}, ${chat_id}):`, err);
  }
};

const add_members = async (user_ids: string[], chat_id: string): Promise<void> => {
  if (user_ids.length === 0) return;
  try {
    const pipe = redis.pipeline();
    pipe.sadd(conv_members_key(chat_id), ...user_ids);
    pipe.expire(conv_members_key(chat_id), REDIS_TTL_SEC);
    for (const uid of user_ids) {
      pipe.sadd(user_conv_key(uid), chat_id);
      pipe.expire(user_conv_key(uid), REDIS_TTL_SEC);
    }
    await pipe.exec();

    conv_user_cache.delete(chat_id);
    for (const uid of user_ids) user_conv_cache.delete(uid);
    await publish_conv_invalidation(chat_id);
    for (const uid of user_ids) await publish_user_conv_invalidation(uid);
  } catch (err) {
    console.error(`[CACHE] add_members failed (${chat_id}):`, err);
  }
};

const remove_member = async (user_id: string, chat_id: string): Promise<void> => {
  try {
    const pipe = redis.pipeline();
    pipe.srem(conv_members_key(chat_id), user_id);
    pipe.srem(user_conv_key(user_id), chat_id);
    await pipe.exec();

    conv_user_cache.delete(chat_id);
    user_conv_cache.delete(user_id);
    await publish_conv_invalidation(chat_id);
    await publish_user_conv_invalidation(user_id);
  } catch (err) {
    console.error(`[CACHE] remove_member failed (${user_id}, ${chat_id}):`, err);
  }
};

const invalidate_conversation = async (chat_id: string): Promise<void> => {
  try {
    await redis.del(conv_members_key(chat_id));
    conv_user_cache.delete(chat_id);
    await publish_conv_invalidation(chat_id);
  } catch (err) {
    console.error(`[CACHE] invalidate_conversation failed (${chat_id}):`, err);
  }
};

const invalidate_user_conversations = async (user_id: string): Promise<void> => {
  try {
    await redis.del(user_conv_key(user_id));
    user_conv_cache.delete(user_id);
    await publish_user_conv_invalidation(user_id);
  } catch (err) {
    console.error(`[CACHE] invalidate_user_conversations failed (${user_id}):`, err);
  }
};

export {
  conv_user_cache,
  user_conv_cache,
  get_conversation_members,
  get_user_conversations,
  is_member,
  add_member,
  add_members,
  remove_member,
  invalidate_conversation,
  invalidate_user_conversations,
  publish_conv_invalidation,
  publish_user_conv_invalidation,
};
