import "dotenv/config";
import LRUCache from "@/utils/cache.utils";
import { redis } from "@/config/redis";
import db from "@/config/db";
import { missed_ws_messages_model } from "@/models/message.model";
import { VITAL_WS_EVENTS_CONST, VitalWSMessage, VitalWSMessageEventsType, WSMessage, WSMessageEventsType } from "@/types/socket.types";
import { eq, and, lt, asc, gt, inArray } from "drizzle-orm";
import Snowflake from "@/utils/snowflake.utils";
import { sort_pending_for_replay } from "@/utils/pending-order.utils";
import { randomUUIDv7 } from "bun";
import { run_batched_singleton, run_daily } from "@/cluster/jobs";
import { is_draining, track } from "@/cluster/lifecycle";

// ============================================================================
// Three-tier Polling Cache for Missed WS Messages
//   Tier 1: LRU Cache (in-memory)   → 10 minutes TTL
//   Tier 2: Redis                   → 1 week TTL
//   Tier 3: PostgreSQL DB           → 1 month (cleaned by cron/scheduled task)
//
// Deduplication strategy — DETERMINISTIC correlation keys (see
// correlation_key below): `{user_id}:{event_type}:{natural_id}`.
//   Tier 1: Map<correlation_key, CachedPollMessage>
//   Tier 2: Redis Hash keyed by correlation_key (HSET/HGETALL/HDEL)
//   Tier 3: DB onConflictDoUpdate (upsert by id = correlation_key)
// Two properties fall out of the key shape:
//   • self-compaction — a re-broadcast of the same logical event (duplicate
//     re-ack after a client resend, LWW state like pin/user:update)
//     OVERWRITES its previous pending entry instead of piling up a new
//     random-keyed copy;
//   • targeted drain — the delivery-ack path can compute the exact key a
//     message was stored under and delete it (impossible with the old
//     randomUUIDv7 keys, which forced delete-on-poll as the ONLY drain).
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
// Key: "user_id:message_id" → timer handle. If remove_pending_message(s) is
// called before the timer fires, clearTimeout() cancels the DB write entirely.
// With drain-on-ack (handle_message_status_ack → remove_pending_messages_batch)
// reachable users who ack within 10s now genuinely never touch the DB — under
// the old random keys nothing could cancel these timers except a poll, so for
// pure-WS recipients EVERY deferred insert always fired.
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

// --- Deterministic correlation keys ---
// Natural per-type ids. Types with a stable natural id get a deterministic
// key (self-compacting + ack-drainable); types where every event is a
// distinct fact (conversation:action, batched status acks, deletes, ...)
// fall through to a random key — overwriting a sibling there would LOSE an
// event for an offline user, so they keep today's append semantics.
const natural_event_id = (ws_message: VitalWSMessage): string | undefined => {
  const p = ws_message.payload as any;
  switch (ws_message.type) {
    case "message:new":
      return p?.id ?? p?.message_id;
    case "message:sent:ack":
      return p?.msg_id ?? p?.message_id ?? p?.id;
    case "message:pin": // LWW: only the latest pin state per chat matters
      return p?.conv_id ?? p?.chat_id;
    case "message:react": // LWW per (message, reactor): final reaction wins
      return p?.message_id && p?.sender_id
        ? `${p.message_id}:${p.sender_id}`
        : undefined;
    case "conversation:disappearing": // LWW per chat
      return p?.conv_id ?? p?.chat_id;
    case "conversation:join":
      return p?.conv_id && p?.user_id ? `${p.conv_id}:${p.user_id}` : undefined; // LWW per (conv, reader).
    case "user:update": // LWW per user snapshot (payload field is user_id)
      return p?.user_id ?? p?.id;
    case "auth:force_logout": // only the latest matters
      return "singleton";
    default:
      return undefined;
  }
};

const correlation_key = (user_id: string, ws_message: VitalWSMessage): string =>
  Snowflake.correlationId(
    user_id,
    ws_message.type,
    natural_event_id(ws_message) ?? randomUUIDv7(),
  );

// ============================================================================
// WRITE PATH — store a missed WS message for an offline user
// Writes to ALL three tiers simultaneously (fan-out).
// ============================================================================
// --- Tier 1 helper: LRU store with cap trim ---
const lru_store = (user_id: string, entry: CachedPollMessage): void => {
  const existing = polling_lru.get(user_id) ?? new Map<string, CachedPollMessage>();
  existing.set(entry.message_id, entry); // overwrites if same key (idempotent)
  if (existing.size > MAX_MESSAGES_PER_USER) {
    const sorted = Array.from(existing.entries()).sort((a, b) => a[1].created_at - b[1].created_at);
    const excess = existing.size - MAX_MESSAGES_PER_USER;
    sorted.slice(0, excess).forEach(([id]) => existing.delete(id));
  }
  polling_lru.set(user_id, existing, LRU_TTL_MS);
};

// --- Tier 2 helper: trim a user's Redis hash back to cap (rare path) ---
const trim_redis_queue = async (user_id: string, hash_len: number): Promise<void> => {
  try {
    const key = redis_poll_key(user_id);
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
  } catch (err) {
    console.error(`[POLL-CACHE] Redis trim error for user ${user_id}:`, err);
  }
};

// --- Tier 3 helper: delayed DB write (cancelled by drain within 10s) ---
const schedule_db_write = (user_id: string, entry: CachedPollMessage): void => {
  const { message_id: pending_message_id, ws_message } = entry;
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
};

async function store_pending_message(
  user_id: string,
  ws_message: VitalWSMessage,
): Promise<void> {
  await store_pending_message_for_users([user_id], ws_message);
}

// Store for multiple users at once — THE fan-out path (broadcast_message).
// One Redis pipeline covers the entire recipient list: hset + expire + hlen
// per user, single round trip. The old per-recipient version awaited 3
// sequential round trips per user (≈450 commands one-by-one for a
// 150-member group message, on the shared connection).
async function store_pending_message_for_users(
  user_ids: string[],
  ws_message: VitalWSMessage,
): Promise<void> {
  if (user_ids.length === 0 || !is_allowed_event(ws_message.type)) return;

  const now = Date.now();
  const pipeline = redis.pipeline();
  const entries: { user_id: string; entry: CachedPollMessage; }[] = [];

  for (const user_id of user_ids) {
    const entry: CachedPollMessage = {
      message_id: correlation_key(user_id, ws_message),
      ws_message,
      created_at: now,
    };
    entries.push({ user_id, entry });

    // Tier 1 + Tier 3 are local (Map / setTimeout) — do them inline.
    lru_store(user_id, entry);
    schedule_db_write(user_id, entry);

    // Tier 2 queued into the shared pipeline.
    const key = redis_poll_key(user_id);
    pipeline.hset(key, entry.message_id, JSON.stringify(entry));
    pipeline.expire(key, REDIS_TTL_SECONDS);
    pipeline.hlen(key);
  }

  try {
    const results = await pipeline.exec();
    // Every 3rd result is the user's hlen — trim the (rare) over-cap queues.
    for (let i = 0; i < entries.length; i++) {
      const hlen_result = results?.[i * 3 + 2];
      const hash_len = typeof hlen_result?.[1] === "number" ? hlen_result[1] : 0;
      if (hash_len > MAX_MESSAGES_PER_USER) {
        await trim_redis_queue(entries[i].user_id, hash_len);
      }
    }
  } catch (err) {
    console.error(`[POLL-CACHE] Redis pipeline write error (${user_ids.length} users):`, err);
  }
}

// ============================================================================
// READ PATH — fetch pending messages for a user (3-tier UNION)
//   LRU ∪ Redis ∪ DB, deduped by correlation key.
// After reading, messages are cleared from all tiers.
//
// SYNC_V2 R0: this used to be a fallthrough — Redis was read only when this
// process's LRU was empty, and the DB only when Redis was empty too. The LRU
// is PER PROCESS and the DB tier holds entries Redis no longer has (trimmed /
// expired), so a non-empty upper tier SHADOWED entries that existed only below
// it: they stayed undelivered until the upper tier happened to be empty.
// Every tier is now read on every poll and merged.
// ============================================================================

// [POLL] cursor_would_drop counter (per process, since start).
let cursor_would_drop_total = 0;

async function fetch_pending_messages(
  user_id: string,
  after_message_id?: string,
): Promise<CachedPollMessage[]> {

  // Map<message_id, CachedPollMessage> for dedup across tiers. Merge order is
  // DB → LRU → Redis, each overwriting the previous for the same correlation
  // key: Redis is written synchronously by EVERY worker's fan-out, so for a
  // self-compacting key (pin / react / user:update ...) it holds the latest
  // version; this process's LRU can hold an older one written here before
  // another worker overwrote it; the DB copy is a deferred snapshot.
  const messages = new Map<string, CachedPollMessage>();

  const redis_read = (async () => {
    const out: [string, CachedPollMessage][] = [];
    try {
      const raw_hash = await redis.hgetall(redis_poll_key(user_id));
      if (raw_hash) {
        for (const [msg_id, str] of Object.entries(raw_hash)) {
          try {
            out.push([msg_id, JSON.parse(str) as CachedPollMessage]);
          } catch (err) {
            console.error(`[POLL-CACHE] Error parsing Redis message for user ${user_id}:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[POLL-CACHE] Redis read error for user ${user_id}:`, err);
    }
    return out;
  })();

  const db_read = (async () => {
    const out: [string, CachedPollMessage][] = [];
    try {
      const db_messages = await db
        .select()
        .from(missed_ws_messages_model)
        .where(eq(missed_ws_messages_model.user_id, user_id))
        .orderBy(asc(missed_ws_messages_model.created_at))
        .limit(MAX_MESSAGES_PER_USER);

      for (const row of db_messages) {
        out.push([row.id, {
          message_id: row.id,
          ws_message: row.ws_message as VitalWSMessage,
          created_at: new Date(row.created_at).getTime(),
        }]);
      }
    } catch (err) {
      console.error(`[POLL-CACHE] DB read error for user ${user_id}:`, err);
    }
    return out;
  })();

  const [redis_entries, db_entries] = await Promise.all([redis_read, db_read]);

  // --- Tier 3: DB ---
  for (const [id, msg] of db_entries) messages.set(id, msg);
  // --- Tier 1: LRU ---
  const lru_map = polling_lru.get(user_id);
  if (lru_map && lru_map.size > 0) {
    lru_map.forEach((msg, id) => messages.set(id, msg));
  }
  // --- Tier 2: Redis ---
  for (const [id, msg] of redis_entries) messages.set(id, msg);

  // Replay order: created_at, with conversation:new first on a same-ms tie
  // (see pending-order.utils — e.g. a new DM's conversation:new and its first
  // message:new).
  const sorted = sort_pending_for_replay(Array.from(messages.values()));

  // Cap one response at MAX_MESSAGES_PER_USER, oldest first: the tier union
  // can reach ~1000 entries, and poll v1 deletes on read, so a bigger
  // response lost mid-transfer on flaky wifi is lost for good. The rest stays
  // queued for the next poll (same size as the old one-tier-per-poll read).
  const result = sorted.length > MAX_MESSAGES_PER_USER
    ? sorted.slice(0, MAX_MESSAGES_PER_USER)
    : sorted;
  if (result.length < sorted.length) {
    console.log(
      `[POLL] capped user=${user_id} returned=${result.length} remaining=${sorted.length - result.length}`,
    );
  }

  // Remove the RETURNED entries from all 3 tiers — batched: one variadic
  // HDEL + one IN-list DB delete instead of 2 round trips per entry (a
  // 500-entry backlog used to cost ~1000 sequential ops per poll).
  await remove_pending_messages_batch(user_id, result.map(m => m.message_id));

  // Cursor (after_message_id): NO slicing (SYNC_V2 R0). Everything above was
  // just DELETED from every tier, so slicing "after the cursor" dropped the
  // entries at/before it for good. The cursor entry can only still be in the
  // queue because it was RE-STORED after the client saw it (a self-compacting
  // key such as message:pin / message:react / user:update overwritten with a
  // newer state, or a sibling worker's deferred DB write) — so it and the
  // entries sorted before it are new to the client. Return them all; client
  // handlers are idempotent per id. Counted so the old loss is visible.
  if (after_message_id) {
    const idx = result.findIndex(m => m.message_id === after_message_id);
    if (idx !== -1) {
      cursor_would_drop_total += idx + 1;
      console.warn(
        `[POLL] cursor_would_drop user=${user_id} n=${idx + 1} of=${result.length} total=${cursor_would_drop_total}`,
      );
    }
  }

  return result;
}

// Batch removal from all 3 tiers. Used by the poll drain and by
// drain-on-ack (handle_message_status_ack / mark_message_delivered), which
// can now compute the exact correlation keys to delete. Keys that don't
// exist (e.g. pre-deploy random-keyed entries) miss harmlessly.
async function remove_pending_messages_batch(user_id: string, message_ids: string[]): Promise<void> {
  if (message_ids.length === 0) return;

  // Cancel delayed DB writes that haven't fired yet
  for (const message_id of message_ids) {
    const tk = db_timer_key(user_id, message_id);
    const timer = pending_db_timers.get(tk);
    if (timer) {
      clearTimeout(timer);
      pending_db_timers.delete(tk);
    }
  }

  // LRU
  try {
    const lru_map = polling_lru.get(user_id);
    if (lru_map) {
      for (const message_id of message_ids) lru_map.delete(message_id);
      if (lru_map.size === 0) polling_lru.delete(user_id);
    }
  } catch (e) {
    console.error(`[POLL-CACHE] LRU batch remove error for user ${user_id}:`, e);
  }

  // Redis — one variadic HDEL
  try {
    await redis.hdel(redis_poll_key(user_id), ...message_ids);
  } catch (err) {
    console.error(`[POLL-CACHE] Redis batch remove error for user ${user_id}:`, err);
  }

  // DB — one IN-list delete
  try {
    await db
      .delete(missed_ws_messages_model)
      .where(inArray(missed_ws_messages_model.id, message_ids));
  } catch (err) {
    console.error(`[POLL-CACHE] DB batch remove error for user ${user_id}:`, err);
  }
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
// ============================================================================
// SYNC_V2 §13.7 C4. This used to run on every process once a day AND 10 s
// after every boot — so every deploy (and, at N>1, every worker) issued one
// unbounded DELETE over the whole table. Now:
//   - run_daily(): at most one run per ~day across all workers, no boot run
//     (the marker lives in Redis, so a restart does not reset it);
//   - 5k-row batches, each its own transaction under the job's advisory
//     lock, so a second worker can never run a batch concurrently, a drain
//     stops between batches, and no single statement holds locks for long.
// What is deleted is unchanged: rows older than DB_RETENTION_DAYS.
const CLEANUP_BATCH_ROWS = 5_000;
// How often each worker asks "is the daily cleanup due?" (cheap: one Redis
// SET NX). The first ask is one interval after boot — never at boot.
const CLEANUP_CHECK_INTERVAL_MS = 10 * 60 * 1000;

async function cleanup_expired_messages(): Promise<number> {
  const cutoff = new Date(Date.now() - DB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const count = await run_batched_singleton("missed_cleanup", async (tx) => {
    const expired_ids = tx
      .select({ id: missed_ws_messages_model.id })
      .from(missed_ws_messages_model)
      .where(lt(missed_ws_messages_model.created_at, cutoff))
      .limit(CLEANUP_BATCH_ROWS);
    const deleted = await tx
      .delete(missed_ws_messages_model)
      .where(inArray(missed_ws_messages_model.id, expired_ids))
      .returning({ id: missed_ws_messages_model.id });
    return deleted.length;
  });
  if (count > 0) {
    console.log(`[POLL-CACHE] Cleaned up ${count} expired missed messages (older than ${DB_RETENTION_DAYS} days)`);
  }
  return count;
}

// ============================================================================
// CRON — ask every CLEANUP_CHECK_INTERVAL_MS whether the daily run is due
// ============================================================================
let cleanup_interval: ReturnType<typeof setInterval> | null = null;
let cleanup_running: Promise<unknown> | null = null;

function start_cleanup_cron() {
  if (cleanup_interval) clearInterval(cleanup_interval);

  cleanup_interval = setInterval(() => {
    if (cleanup_running || is_draining()) return;
    // track(): the drain waits for a batch in flight before closing the pool.
    cleanup_running = track(run_daily("missed_cleanup", cleanup_expired_messages))
      .finally(() => {
        cleanup_running = null;
      });
  }, CLEANUP_CHECK_INTERVAL_MS);

  console.log("[POLL-CACHE] Started daily cleanup cron for missed messages");
}

// Drain (SYNC_V2 §13.9.3): cancel the deferred DB inserts that have not fired.
// This is what an exit always did implicitly; it is now explicit and counted.
// The entries stay in Redis (7-day TTL), so the poll / reconnect replay still
// finds them — only the 30-day DB backstop copy is skipped. Running them
// early instead would race the recipient's ack-drain (RC-3 C3 handles that).
function drop_pending_db_timers(): number {
  const n = pending_db_timers.size;
  for (const timer of pending_db_timers.values()) clearTimeout(timer);
  pending_db_timers.clear();
  return n;
}

// Stops asking; a run already in flight is awaited by the drain via track()
// and itself stops between batches once draining.
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
  remove_pending_messages_batch,
  cleanup_expired_messages,
  start_cleanup_cron,
  stop_cleanup_cron,
  drop_pending_db_timers,
  is_allowed_event,
  log_current_cache_state,
  type CachedPollMessage,
};
