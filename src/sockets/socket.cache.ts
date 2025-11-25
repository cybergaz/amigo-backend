import "dotenv/config"
import LRUCache from '@/utils/cache.utils';
import { get_new_redis_client, redis } from '@/config/redis';
import db from '@/config/db';
import { conversation_member_model } from '@/models/chat.model';
import { and, eq } from 'drizzle-orm';

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not defined in environment variables can't proceed");
}

const conv_user_cache = new LRUCache<number, Set<number>>(); // coversation_id -> user_id
const user_conv_cache = new LRUCache<number, Set<number>>(); // user_id -> conv_id 

const sub = get_new_redis_client(process.env.REDIS_URL);
sub.subscribe("conv:invalidate", (err, count) => {
  if (err) {
    console.error("Failed to subscribe: ", err);
  } else {
    console.log(`Subscribed successfully to "conv:invalidate", This client is currently subscribed to ${count} channels.`);
  }
});
// sub.subscribe("cnx:invalidate", (err, count) => {
//   if (err) {
//     console.error("Failed to subscribe: ", err);
//   } else {
//     console.log(`Subscribed successfully to cnx:invalidate! This client is currently subscribed to ${count} channels.`);
//   }
// });

sub.on("message", (channel, message) => {
  if (channel === "conv:invalidate") {
    const conv_id = parseInt(message, 10);
    conv_user_cache.delete(conv_id); // Invalidate cache by deleting the entry
    console.log(`Invalidated cache for conversation ID: ${conv_id}`);
  }
  // else if (channel === "cnx:invalidate") {
  //   const user_id = parseInt(message, 10);
  //   conv_lru_cache.delete(conv_id); // Invalidate cache by deleting the entry
  //   console.log(`Invalidated cache for conversation ID: ${conv_id}`);
  // }
});

/**
 * Get conversation members following the cache flow:
 * 1. Check LRU cache (local)
 * 2. If cache miss, fetch from Redis (SMEMBERS conv:{conv_id}:members)
 * 3. If Redis miss, fetch from DB
**/
const get_conversation_members = async (conv_id: number): Promise<Set<number>> => {
  // Step 1: Check LRU cache (local)
  const cached = conv_user_cache.get(conv_id);
  if (cached !== null) {
    return cached;
  }

  // Step 2: Cache miss - fetch from Redis
  try {
    const redis_key = `conv:${conv_id}:members`;
    const member_strings = await redis.smembers(redis_key);

    let members: Set<number>;

    if (member_strings.length > 0) {
      // Redis has data - convert string array to Set<number>
      members = new Set<number>(
        member_strings
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id))
      );
    } else {
      // Step 3: Redis miss - fetch from DB
      const db_members = await db
        .select({ user_id: conversation_member_model.user_id })
        .from(conversation_member_model)
        .where(
          and(
            eq(conversation_member_model.conversation_id, conv_id),
            eq(conversation_member_model.deleted, false)
          )
        );

      members = new Set<number>(db_members.map((m) => m.user_id));

      // Step 3b: Update Redis with DB results
      if (members.size > 0) {
        const memberIds = Array.from(members).map((id) => id.toString());
        await redis.sadd(redis_key, ...memberIds);
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
    return new Set<number>();
  }
};

// Get all conversations for a user (cached)
const get_user_conversations = async (user_id: number): Promise<Set<number>> => {
  // Check cache first
  const cached = user_conv_cache.get(user_id);
  if (cached !== null) {
    return cached;
  }

  // Fetch from DB
  const conversations = await db
    .select({ conversation_id: conversation_member_model.conversation_id })
    .from(conversation_member_model)
    .where(
      and(
        eq(conversation_member_model.user_id, user_id),
        eq(conversation_member_model.deleted, false)
      )
    );

  const conv_set = new Set(conversations.map(c => c.conversation_id));

  // Cache for 5 minutes
  user_conv_cache.set(user_id, conv_set, 5 * 60 * 1000);

  return conv_set;
};

export { conv_user_cache, user_conv_cache, get_conversation_members, get_user_conversations };
