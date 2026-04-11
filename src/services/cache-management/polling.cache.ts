import "dotenv/config";
import LRUCache from "@/utils/cache.utils";
import { redis } from "@/config/redis";
import db from "@/config/db";
import { missed_ws_messages_model } from "@/models/message.model";
import { VITAL_WS_EVENTS_CONST, VitalWSMessage, VitalWSMessageEventsType, WSMessage, WSMessageEventsType } from "@/types/socket.types";
import { eq, and, lt, asc, gt } from "drizzle-orm";
import Snowflake from "@/utils/snowflake.utils";

// ============================================================================
// Three-tier Polling Cache for Missed WS Messages
//   Tier 1: LRU Cache (in-memory)   → 10 minutes TTL
//   Tier 2: Redis                   → 1 week TTL
//   Tier 3: PostgreSQL DB           → 1 month (cleaned by cron/scheduled task)
//
// Deduplication strategy:
//   Tier 1: Map<message_id, CachedPollMessage> — keyed by message_id
//   Tier 2: Redis Hash keyed by message_id (HSET/HGETALL/HDEL)
//   Tier 3: DB onConflictDoUpdate (upsert by id)
// ============================================================================

interface CachedPollMessage {
  message_id: string;
  ws_message: VitalWSMessage;
  created_at: number; // epoch ms
}

// --- Constants ---
const LRU_TTL_MS = 10 * 60 * 1000;            // 10 minutes
const REDIS_TTL_SECONDS = 7 * 24 * 60 * 60;   // 1 week
const DB_RETENTION_DAYS = 30;                 // 1 month
const MAX_MESSAGES_PER_USER = 500;            // cap per-user queue in Redis/LRU

// --- Tier 1: LRU in-memory cache ---
// user_id → Map<message_id, CachedPollMessage> for O(1) dedup by message_id
const polling_lru = new LRUCache<string, Map<string, CachedPollMessage>>(5000, LRU_TTL_MS);

// --- Delayed DB write timers ---
// Key: "user_id:message_id" → timer handle. If remove_pending_message is called
// before the timer fires, clearTimeout() cancels the DB write entirely.
// This means truly online users (who ACK within 10s) never touch the DB.
const DB_WRITE_DELAY_MS = 10_000; // 10 seconds
const pending_db_timers = new Map<string, ReturnType<typeof setTimeout>>();
const db_timer_key = (user_id: string, message_id: string) => `${user_id}:${message_id}`;

// --- Helper: Redis key for a user's pending poll messages ---
// NOTE: Using _v2 suffix to avoid WRONGTYPE conflicts with old Set-typed keys
const redis_poll_key = (user_id: string) => `poll:user:${user_id}:messages_v2`;

// --- Guard: check if event type is allowed for polling cache ---
const is_allowed_event = (event_type: WSMessageEventsType): event_type is VitalWSMessageEventsType => {
  return (VITAL_WS_EVENTS_CONST as readonly string[]).includes(event_type);
};

// ============================================================================
// WRITE PATH — store a missed WS message for an offline user
// Writes to ALL three tiers simultaneously (fan-out).
// ============================================================================
async function store_pending_message(
  user_id: string,
  ws_message: VitalWSMessage,
): Promise<void> {
  if (!is_allowed_event(ws_message.type)) {
    return; // silently ignore non-cacheable events
  }

  const pending_message_id = Snowflake.correlationId(user_id, ws_message.type, (ws_message.payload as any).id || (ws_message.payload as any).message_id);
  const now = Date.now();

  const entry: CachedPollMessage = {
    message_id: pending_message_id,
    ws_message,
    created_at: now,
  };

  // --- Tier 1: LRU (Map keyed by message_id — O(1) dedup) ---
  const existing = polling_lru.get(user_id) ?? new Map<string, CachedPollMessage>();
  existing.set(pending_message_id, entry); // overwrites if same ID (idempotent)
  // Trim oldest entries if over cap
  if (existing.size > MAX_MESSAGES_PER_USER) {
    const sorted = Array.from(existing.entries()).sort((a, b) => a[1].created_at - b[1].created_at);
    const excess = existing.size - MAX_MESSAGES_PER_USER;
    sorted.slice(0, excess).forEach(([id]) => existing.delete(id));
  }
  polling_lru.set(user_id, existing, LRU_TTL_MS);

  // --- Tier 2: Redis (immediate) ---
  try {
    const key = redis_poll_key(user_id);
    await redis.hset(key, pending_message_id, JSON.stringify(entry));
    // Trim to cap (remove oldest by created_at)
    const hash_len = await redis.hlen(key);
    if (hash_len > MAX_MESSAGES_PER_USER) {
      const all = await redis.hgetall(key);
      const sorted = Object.entries(all).sort((a, b) => {
        const pa = JSON.parse(a[1]) as CachedPollMessage;
        const pb = JSON.parse(b[1]) as CachedPollMessage;
        return pa.created_at - pb.created_at;
      });
      const to_delete = sorted.slice(0, hash_len - MAX_MESSAGES_PER_USER).map(([id]) => id);
      if (to_delete.length > 0) {
        await redis.hdel(key, ...to_delete);
      }
    }
    await redis.expire(key, REDIS_TTL_SECONDS);
  } catch (err) {
    console.error(`[POLL-CACHE] Redis write error for user ${user_id}:`, err);
  }

  // --- Tier 3: DB (delayed — skip if user comes online within 10s) ---
  const tk = db_timer_key(user_id, pending_message_id);
  if (pending_db_timers.has(tk)) clearTimeout(pending_db_timers.get(tk)!);
  const timer = setTimeout(async () => {
    pending_db_timers.delete(tk);
    try {
      await db
        .insert(missed_ws_messages_model)
        .values({
          id: pending_message_id,
          user_id,
          event_type: ws_message.type,
          ws_message,
        })
        .onConflictDoUpdate({
          target: missed_ws_messages_model.id,
          set: {
            user_id,
            event_type: ws_message.type,
            ws_message,
          }
        });
    } catch (err) {
      console.error(`[POLL-CACHE] DB write error for user ${user_id}:`, err);
    }
  }, DB_WRITE_DELAY_MS);
  pending_db_timers.set(tk, timer);
}

// Store for multiple users at once (batch convenience)
async function store_pending_message_for_users(
  user_ids: string[],
  ws_message: VitalWSMessage,
): Promise<void> {
  if (!is_allowed_event(ws_message.type)) return;

  await Promise.allSettled(
    user_ids.map(uid => store_pending_message(uid, ws_message))
  );
}

// ============================================================================
// READ PATH — fetch pending messages for a user (3-tier fallthrough)
//   1. LRU cache (fastest)
//   2. Redis (if LRU miss)
//   3. DB (if Redis miss)
// After reading, messages are cleared from all tiers.
// ============================================================================
async function fetch_pending_messages(
  user_id: string,
  after_message_id?: string,
): Promise<CachedPollMessage[]> {

  // Map<message_id, CachedPollMessage> for dedup across tiers
  let messages = new Map<string, CachedPollMessage>();

  // --- Tier 1: LRU ---
  const lru_map = polling_lru.get(user_id);
  if (lru_map && lru_map.size > 0) {
    lru_map.forEach((msg, id) => messages.set(id, msg));
  } else {
    // --- Tier 2: Redis ---
    try {
      const key = redis_poll_key(user_id);
      const raw_hash = await redis.hgetall(key);

      if (raw_hash && Object.keys(raw_hash).length > 0) {
        for (const [msg_id, str] of Object.entries(raw_hash)) {
          try {
            const parsed = JSON.parse(str) as CachedPollMessage;
            messages.set(msg_id, parsed);
          } catch (err) {
            console.error(`[POLL-CACHE] Error parsing Redis message for user ${user_id}:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[POLL-CACHE] Redis read error for user ${user_id}:`, err);
    }

    // --- Tier 3: DB (only if Redis was also empty) ---
    if (messages.size === 0) {
      try {
        const db_messages = await db
          .select()
          .from(missed_ws_messages_model)
          .where(eq(missed_ws_messages_model.user_id, user_id))
          .orderBy(asc(missed_ws_messages_model.created_at))
          .limit(MAX_MESSAGES_PER_USER);

        for (const row of db_messages) {
          messages.set(row.id, {
            message_id: row.id,
            ws_message: row.ws_message as VitalWSMessage,
            created_at: new Date(row.created_at).getTime(),
          });
        }
      } catch (err) {
        console.error(`[POLL-CACHE] DB read error for user ${user_id}:`, err);
      }
    }
  }

  // Remove from all 3 tiers upon fetching success (await all removals)
  await Promise.allSettled(
    Array.from(messages.keys()).map(msg_id => remove_pending_message(user_id, msg_id))
  );

  // Filter by after_message_id if provided (cursor-based pagination)
  let result = Array.from(messages.values()).sort((a, b) => a.created_at - b.created_at);
  if (after_message_id) {
    const idx = result.findIndex(m => m.message_id === after_message_id);
    if (idx !== -1) {
      result = result.slice(idx + 1);
    }
  }

  return result;
}

// Remove pending message from 3 tiers after successful delivery
async function remove_pending_message(user_id: string, message_id: string): Promise<void> {
  // Cancel delayed DB write if it hasn't fired yet
  const tk = db_timer_key(user_id, message_id);
  const timer = pending_db_timers.get(tk);
  if (timer) {
    clearTimeout(timer);
    pending_db_timers.delete(tk);
  }

  // Remove from LRU
  try {
    const lru_map = polling_lru.get(user_id);
    if (lru_map) {
      lru_map.delete(message_id);
      if (lru_map.size === 0) {
        polling_lru.delete(user_id);
      }
      // No need to re-set since we mutated the Map in place; TTL refresh is optional
    }
  } catch (e) {
    console.error(`[POLL-CACHE] LRU remove error for user ${user_id}:`, e);
  }

  // Remove from Redis (O(1) HDEL by field name)
  try {
    await redis.hdel(redis_poll_key(user_id), message_id);
  } catch (err) {
    console.error(`[POLL-CACHE] Redis remove error for user ${user_id}:`, err);
  }

  // Remove from DB
  try {
    await db
      .delete(missed_ws_messages_model)
      .where(eq(missed_ws_messages_model.id, message_id));
  } catch (err) {
    console.error(`[POLL-CACHE] DB remove error for user ${user_id}:`, err);
  }
}


// ============================================================================
// CLEANUP — purge expired DB rows (> 1 month old)
// Call this from a cron job or scheduled task.
// ============================================================================
async function cleanup_expired_messages(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - DB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await db
      .delete(missed_ws_messages_model)
      .where(lt(missed_ws_messages_model.created_at, cutoff))
      .returning({ id: missed_ws_messages_model.id });

    const count = result.length;
    if (count > 0) {
      console.log(`[POLL-CACHE] Cleaned up ${count} expired missed messages (older than ${DB_RETENTION_DAYS} days)`);
    }
    return count;
  } catch (err) {
    console.error("[POLL-CACHE] Error cleaning up expired messages:", err);
    return 0;
  }
}

// ============================================================================
// CRON — start a periodic cleanup interval (runs once per day)
// ============================================================================
let cleanup_interval: ReturnType<typeof setInterval> | null = null;

function start_cleanup_cron() {
  if (cleanup_interval) clearInterval(cleanup_interval);

  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  cleanup_interval = setInterval(async () => {
    console.log("[POLL-CACHE] Running scheduled cleanup of expired missed messages...");
    await cleanup_expired_messages();
  }, CLEANUP_INTERVAL_MS);

  // Also run once on startup (after a short delay to let DB settle)
  setTimeout(() => cleanup_expired_messages(), 10_000);

  console.log("[POLL-CACHE] Started daily cleanup cron for missed messages");
}

function stop_cleanup_cron() {
  if (cleanup_interval) {
    clearInterval(cleanup_interval);
    cleanup_interval = null;
  }
}

function log_current_cache_state(user_id: string) {
  const lru_map = polling_lru.get(user_id);
  console.log(`[POLL-CACHE] Current LRU cache for user ${user_id}:`, lru_map?.size ?? 0);

  redis.hlen(redis_poll_key(user_id)).then(count => {
    console.log(`[POLL-CACHE] Current Redis cache for user ${user_id}:`, count);
  }).catch(err => {
    console.error(`[POLL-CACHE] Error fetching Redis cache for user ${user_id}:`, err);
  });

  db.select()
    .from(missed_ws_messages_model)
    .where(eq(missed_ws_messages_model.user_id, user_id))
    .limit(MAX_MESSAGES_PER_USER)
    .then(db_messages => {
      console.log(`[POLL-CACHE] Current DB cache for user ${user_id}:`, db_messages.length);
    })
    .catch(err => {
      console.error(`[POLL-CACHE] Error fetching DB cache for user ${user_id}:`, err);
    });
}

export {
  store_pending_message,
  store_pending_message_for_users,
  fetch_pending_messages,
  remove_pending_message,
  cleanup_expired_messages,
  start_cleanup_cron,
  stop_cleanup_cron,
  is_allowed_event,
  log_current_cache_state,
  type CachedPollMessage,
};
