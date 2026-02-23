import "dotenv/config";
import LRUCache from "@/utils/cache.utils";
import { redis } from "@/config/redis";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { eq } from "drizzle-orm";

// ============================================================================
// Three-tier FCM Token Cache
//   Tier 1: LRU Cache (in-memory)   → 10 minutes TTL
//   Tier 2: Redis                   → 1 month TTL
//   Tier 3: PostgreSQL DB           → forever (no expiration)
// ============================================================================

// --- Constants ---
const LRU_TTL_MS = 10 * 60 * 1000;            // 10 minutes
const REDIS_TTL_SECONDS = 30 * 24 * 60 * 60;  // 1 month

// --- Tier 1: LRU in-memory cache ---
// user_id → fcm_token (hot cache, 10min TTL)
const fcm_token_lru = new LRUCache<number, string>(5000, LRU_TTL_MS);

// --- Helper: Redis key for a user's FCM token ---
const redis_fcm_key = (user_id: number) => `fcm:user:${user_id}:token`;

// ============================================================================
// WRITE PATH — store/update FCM token for a user
// Writes to ALL three tiers simultaneously (fan-out).
// ============================================================================
async function store_fcm_token(
  user_id: number,
  fcm_token: string | null,
): Promise<void> {
  // If token is null, remove it from all tiers
  if (fcm_token === null) {
    await remove_fcm_token(user_id);
    return;
  }

  // --- Tier 1: LRU ---
  fcm_token_lru.set(user_id, fcm_token, LRU_TTL_MS);

  // --- Tier 2 + 3: Redis & DB in parallel (fire-and-forget, errors logged) ---
  const redis_promise = (async () => {
    try {
      const key = redis_fcm_key(user_id);
      await redis.set(key, fcm_token);
      await redis.expire(key, REDIS_TTL_SECONDS);
    } catch (err) {
      console.error(`[FCM-CACHE] Redis write error for user ${user_id}:`, err);
    }
  })();

  const db_promise = (async () => {
    try {
      await db
        .update(user_model)
        .set({ fcm_token })
        .where(eq(user_model.id, user_id));
    } catch (err) {
      console.error(`[FCM-CACHE] DB write error for user ${user_id}:`, err);
    }
  })();

  await Promise.allSettled([redis_promise, db_promise]);
}

// ============================================================================
// READ PATH — fetch FCM token for a user (3-tier fallthrough)
//   1. LRU cache (fastest)
//   2. Redis (if LRU miss)
//   3. DB (if Redis miss)
// After reading from Redis/DB, populate LRU cache for future reads.
// ============================================================================
async function fetch_fcm_token(user_id: number): Promise<string | null> {
  // --- Tier 1: LRU ---
  const lru_token = fcm_token_lru.get(user_id);
  if (lru_token !== null) {
    return lru_token;
  }

  // --- Tier 2: Redis ---
  try {
    const key = redis_fcm_key(user_id);
    const redis_token = await redis.get(key);

    if (redis_token !== null) {
      // Populate LRU cache for future reads
      fcm_token_lru.set(user_id, redis_token, LRU_TTL_MS);
      return redis_token;
    }
  } catch (err) {
    console.error(`[FCM-CACHE] Redis read error for user ${user_id}:`, err);
  }

  // --- Tier 3: DB ---
  try {
    const db_user = await db
      .select({ fcm_token: user_model.fcm_token })
      .from(user_model)
      .where(eq(user_model.id, user_id))
      .limit(1);

    const db_token = db_user[0]?.fcm_token || null;

    if (db_token !== null) {
      // Populate both LRU and Redis for future reads
      fcm_token_lru.set(user_id, db_token, LRU_TTL_MS);
      
      const redis_populate_promise = (async () => {
        try {
          const key = redis_fcm_key(user_id);
          await redis.set(key, db_token);
          await redis.expire(key, REDIS_TTL_SECONDS);
        } catch (err) {
          console.error(`[FCM-CACHE] Redis populate error for user ${user_id}:`, err);
        }
      })();
      
      // Don't await Redis populate, fire-and-forget
      Promise.allSettled([redis_populate_promise]).catch(() => {});

      return db_token;
    }
  } catch (err) {
    console.error(`[FCM-CACHE] DB read error for user ${user_id}:`, err);
  }

  return null;
}

// ============================================================================
// REMOVE PATH — remove FCM token from all tiers (for logout)
// ============================================================================
async function remove_fcm_token(user_id: number): Promise<void> {
  // --- Tier 1: LRU ---
  fcm_token_lru.delete(user_id);

  // --- Tier 2 + 3: Redis & DB in parallel (fire-and-forget, errors logged) ---
  const redis_promise = (async () => {
    try {
      const key = redis_fcm_key(user_id);
      await redis.del(key);
    } catch (err) {
      console.error(`[FCM-CACHE] Redis delete error for user ${user_id}:`, err);
    }
  })();

  const db_promise = (async () => {
    try {
      await db
        .update(user_model)
        .set({ fcm_token: null })
        .where(eq(user_model.id, user_id));
    } catch (err) {
      console.error(`[FCM-CACHE] DB delete error for user ${user_id}:`, err);
    }
  })();

  await Promise.allSettled([redis_promise, db_promise]);
}

// ============================================================================
// BATCH FETCH — fetch FCM tokens for multiple users
// ============================================================================
async function fetch_fcm_tokens(user_ids: number[]): Promise<Map<number, string | null>> {
  const results = new Map<number, string | null>();

  // Fetch all tokens in parallel
  const promises = user_ids.map(async (user_id) => {
    const token = await fetch_fcm_token(user_id);
    return { user_id, token };
  });

  const fetched = await Promise.allSettled(promises);

  fetched.forEach((result, index) => {
    if (result.status === "fulfilled") {
      results.set(result.value.user_id, result.value.token);
    } else {
      // On error, set to null for that user
      results.set(user_ids[index], null);
    }
  });

  return results;
}

export {
  store_fcm_token,
  fetch_fcm_token,
  fetch_fcm_tokens,
  remove_fcm_token,
};
