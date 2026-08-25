import "dotenv/config";
import LRUCache from "@/utils/cache.utils";
import { redis, get_new_redis_client } from "@/config/redis";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { and, eq, ne } from "drizzle-orm";

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
const fcm_token_lru = new LRUCache<string, string>(5000, LRU_TTL_MS);

// --- Helper: Redis key for a user's FCM token ---
const redis_fcm_key = (user_id: string) => `fcm:user:${user_id}:token`;

// ============================================================================
// CROSS-WORKER LRU INVALIDATION
//
// Tier 1 is per-PROCESS with a 10-minute TTL, and PM2 runs us in cluster mode
// (ecosystem.config.js instances:'max'). So a worker that never handled the
// write keeps serving a stale user→token mapping for up to 10 minutes. That is
// exactly the privacy leak this cache had to begin with: after a device changes
// hands, a stale entry keeps pushing the PREVIOUS owner's notifications to the
// new owner's handset. Every write path therefore publishes the affected
// user_id here and every worker drops its local entry, falling back to Redis
// (which is already authoritative by the time we publish).
//
// ioredis cannot mix subscribe-mode with normal commands on one connection, so
// the subscriber gets its own client — same pattern as user-peer.cache.ts.
// ============================================================================

const INVALIDATE_CHANNEL = "fcm:invalidate";
// payload format: user_id

let _sub_started = false;
const start_invalidation_subscriber = (): void => {
  if (_sub_started) return;
  _sub_started = true;
  try {
    const sub = get_new_redis_client();
    sub.subscribe(INVALIDATE_CHANNEL, (err) => {
      if (err) console.error("[FCM-CACHE] invalidation subscribe failed:", err);
    });
    sub.on("message", (channel, message) => {
      if (channel !== INVALIDATE_CHANNEL) return;
      fcm_token_lru.delete(message);
    });
  } catch (err) {
    // A broken pub/sub must never break token storage — the LRU just stays
    // process-local (pre-existing behaviour) until the next restart.
    console.error("[FCM-CACHE] invalidation subscriber setup failed:", err);
  }
};

start_invalidation_subscriber();

const publish_fcm_invalidation = async (user_id: string): Promise<void> => {
  try {
    await redis.publish(INVALIDATE_CHANNEL, user_id);
  } catch (err) {
    console.error(`[FCM-CACHE] publish_fcm_invalidation failed (${user_id}):`, err);
  }
};

// ============================================================================
// WRITE PATH — store/update FCM token for a user
// Writes to ALL three tiers simultaneously (fan-out).
//
// A device token is EXCLUSIVE to one user: it identifies a handset, not an
// account. Before claiming it we steal it from anybody else still holding it,
// otherwise two users' rows point at the same device and the previous owner's
// pushes keep landing on it forever (there is no unique constraint on
// users.fcm_token to stop that — see scripts/apply-fcm-token-unique.ts).
// ============================================================================
async function store_fcm_token(
  user_id: string,
  fcm_token: string | null,
): Promise<void> {
  // If token is null, remove it from all tiers
  if (fcm_token === null) {
    await remove_fcm_token(user_id);
    return;
  }

  // --- Tier 0: exclusive ownership — evict this token from every OTHER user ---
  // Each hit here is a handset that WAS leaking one account's pushes to another,
  // so the warn line is the field-confirmation signal for this fix.
  try {
    const stolen = await db
      .update(user_model)
      .set({ fcm_token: null })
      .where(and(eq(user_model.fcm_token, fcm_token), ne(user_model.id, user_id)))
      .returning({ id: user_model.id });

    if (stolen.length > 0) {
      const ids = stolen.map((u) => u.id);
      console.warn('[FCM-CACHE] token reassigned from', ids, '->', user_id);
      // Clear the losers' LRU + Redis too — the DB row is already NULL above,
      // but Redis (1 month TTL) would otherwise resurrect the stale mapping.
      for (const u of stolen) await remove_fcm_token(u.id);
    }
  } catch (err) {
    // Non-fatal: a failed steal degrades to the old (leaky) behaviour rather
    // than losing the new owner's token entirely.
    console.error(`[FCM-CACHE] token steal failed for user ${user_id}:`, err);
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

  // Tell the other workers to drop their (now stale) entry for this user. Done
  // AFTER the Redis write so anyone re-reading immediately gets the new token.
  // This process drops its own fresh entry too — one extra Redis GET on the
  // next read, which is the cheap price for never serving a superseded token.
  await publish_fcm_invalidation(user_id);
}

// ============================================================================
// READ PATH — fetch FCM token for a user (3-tier fallthrough)
//   1. LRU cache (fastest)
//   2. Redis (if LRU miss)
//   3. DB (if Redis miss)
// After reading from Redis/DB, populate LRU cache for future reads.
// ============================================================================
async function fetch_fcm_token(user_id: string): Promise<string | null> {
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
async function remove_fcm_token(user_id: string): Promise<void> {
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

  // Tier 1 lives in THIS process only — without this every other worker keeps
  // pushing to the removed token for up to LRU_TTL_MS (the logout leak).
  await publish_fcm_invalidation(user_id);
}

// ============================================================================
// BATCH FETCH — fetch FCM tokens for multiple users
// ============================================================================
async function fetch_fcm_tokens(user_ids: string[]): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

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
