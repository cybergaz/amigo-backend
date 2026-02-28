import "dotenv/config";
import LRUCache from "@/utils/cache.utils";
import { redis } from "@/config/redis";
import db from "@/config/db";
import { missed_ws_messages_model } from "@/models/chat.model";
import { VITAL_WS_EVENTS_CONST, VitalWSMessage, VitalWSMessageEventsType, WSMessage, WSMessageEventsType } from "@/types/socket.types";
import { eq, and, lt, asc, gt } from "drizzle-orm";
import { convertBigIntToString, convertStringToBigInt } from "@/utils/serialization.utils";

// ============================================================================
// Three-tier Polling Cache for Missed WS Messages
//   Tier 1: LRU Cache (in-memory)   → 10 minutes TTL
//   Tier 2: Redis                   → 1 week TTL
//   Tier 3: PostgreSQL DB           → 1 month (cleaned by cron/scheduled task)
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
// user_id → array of pending messages (hot cache, 10min TTL)
const polling_lru = new LRUCache<number, CachedPollMessage[]>(5000, LRU_TTL_MS);

// --- Helper: Redis key for a user's pending poll messages ---
const redis_poll_key = (user_id: number) => `poll:user:${user_id}:messages`;

// Monotonic counter for unique message IDs within a process
let poll_msg_counter = 0;
function generate_poll_message_id(): string {
  poll_msg_counter++;
  return `${Date.now()}-${poll_msg_counter}`;
}

// --- Guard: check if event type is allowed for polling cache ---
const is_allowed_event = (event_type: WSMessageEventsType): event_type is VitalWSMessageEventsType => {
  return (VITAL_WS_EVENTS_CONST as readonly string[]).includes(event_type);
};

// ============================================================================
// WRITE PATH — store a missed WS message for an offline user
// Writes to ALL three tiers simultaneously (fan-out).
// ============================================================================
async function store_pending_message(
  user_id: number,
  ws_message: VitalWSMessage,
): Promise<void> {
  if (!is_allowed_event(ws_message.type)) {
    return; // silently ignore non-cacheable events
  }

  const pending_message_id = generate_poll_message_id();
  const now = Date.now();

  // Convert BigInt IDs to strings in the message payload for safe serialization/storage
  const serialized_ws_meeasge = convertBigIntToString(ws_message);
  const entry: CachedPollMessage = {
    message_id: pending_message_id,
    ws_message,
    created_at: now,
  };

  // --- Tier 1: LRU ---
  const existing = polling_lru.get(user_id);
  const messages = existing ? [...existing, entry] : [entry];
  // Cap the array to prevent memory bloat
  const trimmed = messages.length > MAX_MESSAGES_PER_USER
    ? messages.slice(-MAX_MESSAGES_PER_USER)
    : messages;
  polling_lru.set(user_id, trimmed, LRU_TTL_MS);

  // --- Tier 2 + 3: Redis & DB in parallel (fire-and-forget, errors logged) ---
  const redis_promise = (async () => {
    try {
      const key = redis_poll_key(user_id);
      await redis.rpush(key,
        JSON.stringify({
          ...entry,
          ws_message: serialized_ws_meeasge,
        }));
      // Trim to cap
      await redis.ltrim(key, -MAX_MESSAGES_PER_USER, -1);
      // Set/refresh TTL
      await redis.expire(key, REDIS_TTL_SECONDS);
    } catch (err) {
      console.error(`[POLL-CACHE] Redis write error for user ${user_id}:`, err);
    }
  })();

  const db_promise = (async () => {
    try {
      await db
        .insert(missed_ws_messages_model)
        .values({
          id: pending_message_id,
          user_id,
          event_type: ws_message.type,
          ws_message: serialized_ws_meeasge, // Use serialized version with BigInt converted to strings
        });
    } catch (err) {
      console.error(`[POLL-CACHE] DB write error for user ${user_id}:`, err);
    }
  })();

  await Promise.allSettled([redis_promise, db_promise]);
}

// Store for multiple users at once (batch convenience)
async function store_pending_message_for_users(
  user_ids: number[],
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
  user_id: number,
  after_message_id?: string,
): Promise<CachedPollMessage[]> {

  let messages: CachedPollMessage[] = [];

  // --- Tier 1: LRU ---
  const lru_messages = polling_lru.get(user_id);
  if (lru_messages && lru_messages.length > 0) {
    messages = lru_messages;
    polling_lru.delete(user_id);
  } else {
    // --- Tier 2: Redis ---
    try {
      const key = redis_poll_key(user_id);
      const raw_messages = await redis.lrange(key, 0, -1);

      if (raw_messages.length > 0) {
        messages = raw_messages.map(str => {
          try {
            const parsed = JSON.parse(str);
            // Convert ws_message back to VitalWSMessage with proper types deserialization of msg ids
            // const deserialized_ws_message_payload = convertStringIdsToBigInt(parsed.ws_message, parsed.ws_message.type);
            return {
              ...parsed,
              ws_message: convertStringToBigInt(parsed.ws_message) as VitalWSMessage,
            } as CachedPollMessage;
          } catch (err) {
            console.error(`[POLL-CACHE] Error parsing Redis message for user ${user_id}:`, err);
            return null;
          }
        }).filter((m): m is CachedPollMessage => m !== null);
        // Clear Redis queue after reading
        await redis.del(key);
      }
    } catch (err) {
      console.error(`[POLL-CACHE] Redis read error for user ${user_id}:`, err);
    }

    // --- Tier 3: DB (only if Redis was also empty) ---
    if (messages.length === 0) {
      try {
        const db_messages = await db
          .select()
          .from(missed_ws_messages_model)
          .where(eq(missed_ws_messages_model.user_id, user_id))
          .orderBy(asc(missed_ws_messages_model.created_at))
          .limit(MAX_MESSAGES_PER_USER);

        if (db_messages.length > 0) {
          messages = db_messages.map(row => ({
            message_id: row.id,
            event_type: row.event_type as VitalWSMessageEventsType,
            ws_message: convertStringToBigInt(row.ws_message) as VitalWSMessage,
            // ws_message: convertStringIdsToBigIntForWSMessage(JSON.stringify(row.ws_message)) as VitalWSMessage,
            created_at: new Date(row.created_at).getTime(),
          }));

          // Clear fetched messages from DB
          await db
            .delete(missed_ws_messages_model)
            .where(eq(missed_ws_messages_model.user_id, user_id));
        }
      } catch (err) {
        console.error(`[POLL-CACHE] DB read error for user ${user_id}:`, err);
      }
    }
  }

  // Filter by after_message_id if provided (for cursor-based pagination)
  if (after_message_id && messages.length > 0) {
    const idx = messages.findIndex(m => m.message_id === after_message_id);
    if (idx !== -1) {
      messages = messages.slice(idx + 1);
    }
  }

  return messages;
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

  // Run cleanup every 24 hours
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

export {
  store_pending_message,
  store_pending_message_for_users,
  fetch_pending_messages,
  cleanup_expired_messages,
  start_cleanup_cron,
  stop_cleanup_cron,
  is_allowed_event,
  type CachedPollMessage,
};
