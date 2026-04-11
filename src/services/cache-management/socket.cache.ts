import "dotenv/config"
import LRUCache from '@/utils/cache.utils';
import { get_new_redis_client, redis } from '@/config/redis';
import db from '@/config/db';
import { chat_member_model } from '@/models/chat.model';
import { and, eq, isNull } from 'drizzle-orm';

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not defined in environment variables can't proceed");
}

const conv_user_cache = new LRUCache<string, Set<string>>(); // chat_id -> user_id
const user_conv_cache = new LRUCache<string, Set<string>>(); // user_id -> chat_id

const sub = get_new_redis_client(process.env.REDIS_URL);
sub.subscribe("conv:invalidate", (err, count) => {
  if (err) {
    console.error("Failed to subscribe: ", err);
  } else {
    console.log(`Subscribed successfully to "conv:invalidate", This client is currently subscribed to ${count} channels.`);
  }
});

sub.on("message", (channel, message) => {
  if (channel === "conv:invalidate") {
    conv_user_cache.delete(message); // message is the chat_id string
    console.log(`Invalidated cache for conversation ID: ${message}`);
  }
});

// Get conversation members following the cache flow:
// 1. Check LRU cache (local)
// 2. If cache miss, fetch from Redis (SMEMBERS conv:{chat_id}:members)
// 3. If Redis miss, fetch from DB
const get_conversation_members = async (conv_id: string): Promise<Set<string>> => {
  // Step 1: Check LRU cache (local)
  const cached = conv_user_cache.get(conv_id);
  if (cached !== null) {
    return cached;
  }

  // Step 2: Cache miss - fetch from Redis
  try {
    const redis_key = `conv:${conv_id}:members`;
    const member_strings = await redis.smembers(redis_key);

    let members: Set<string>;

    if (member_strings.length > 0) {
      // Redis has data - strings are already UUIDs
      members = new Set<string>(member_strings);
    } else {
      // Step 3: Redis miss - fetch from DB
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

      // Step 3b: Update Redis with DB results + set TTL
      if (members.size > 0) {
        const memberIds = Array.from(members);
        await redis.sadd(redis_key, ...memberIds);
        await redis.expire(redis_key, 86400); // 24h TTL
      }
    }

    // Step 4: Cache in LRU with randomized TTL (1-5 minutes)
    // Random TTL between 60,000ms (1 min) and 300,000ms (5 min)
    const randomTTL = Math.floor(Math.random() * (300000 - 60000 + 1)) + 60000;
    conv_user_cache.set(conv_id, members, randomTTL);

    return members;
  } catch (error) {
    console.error(`[CACHE] Error fetching conversation members for conv_id ${conv_id}:`, error);
    // Return empty set on error to prevent crashes
    return new Set<string>();
  }
};

// Get all conversations for a user (cached)
const get_user_conversations = async (user_id: string): Promise<Set<string>> => {
  // Check cache first
  const cached = user_conv_cache.get(user_id);
  if (cached !== null) {
    return cached;
  }

  // Fetch from DB
  const conversations = await db
    .select({ chat_id: chat_member_model.chat_id })
    .from(chat_member_model)
    .where(
      and(
        eq(chat_member_model.user_id, user_id),
        isNull(chat_member_model.removed_at)
      )
    );

  const conv_set = new Set(conversations.map(c => c.chat_id));

  // Cache for 5 minutes
  user_conv_cache.set(user_id, conv_set, 5 * 60 * 1000);

  return conv_set;
};

export { conv_user_cache, user_conv_cache, get_conversation_members, get_user_conversations };
