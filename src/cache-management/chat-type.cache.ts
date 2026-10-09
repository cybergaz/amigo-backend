import db from "@/config/db";
import { chat_model } from "@/models/chat.model";
import { ChatType } from "@/types/chat.types";
import LRUCache from "@/utils/cache.utils";
import { eq } from "drizzle-orm";

// ────────────────────────────────────────────────────────────────────────────
// Process-local chat_id → chats.type cache.
//
// A chat's type never changes after creation, so this needs no invalidation
// and no cross-instance pub/sub: every PM2 worker may hold its own copy and
// they can never disagree. It exists so the send path (handle_message_new) can
// branch broadcast-list chats off the normal DM/group path without paying a
// SELECT on every message, and so group-only endpoints can cheaply refuse a
// broadcast chat.
//
// Only successful lookups are cached. A chat that doesn't exist (null) is NOT
// cached — it may be created a moment later — and a DB error is surfaced as
// `undefined` so callers can tell "unknown right now" from "no such chat".
// ────────────────────────────────────────────────────────────────────────────

const TYPE_CACHE_CAPACITY = 50_000;
const TYPE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // immutable data — the TTL only bounds memory churn

const chat_type_cache = new LRUCache<string, ChatType>(TYPE_CACHE_CAPACITY, TYPE_CACHE_TTL_MS);

/**
 * Resolve a chat's type.
 *   ChatType  → the chat exists (cached thereafter)
 *   null      → no such chat
 *   undefined → lookup failed (DB error); the caller decides how to degrade
 * Never throws.
 */
const get_chat_type = async (chat_id: string): Promise<ChatType | null | undefined> => {
  const cached = chat_type_cache.get(chat_id);
  if (cached !== null) return cached;
  try {
    const [row] = await db
      .select({ type: chat_model.type })
      .from(chat_model)
      .where(eq(chat_model.id, chat_id))
      .limit(1);
    if (!row) return null;
    const type = row.type as ChatType;
    chat_type_cache.set(chat_id, type);
    return type;
  } catch (err) {
    console.error(`[CACHE] get_chat_type failed (${chat_id}):`, err);
    return undefined;
  }
};

/** Seed the cache for a chat this process just created (saves the first lookup). */
const prime_chat_type = (chat_id: string, type: ChatType): void => {
  chat_type_cache.set(chat_id, type);
};

/** True when `chat_id` is a broadcast-list chat. A failed lookup reads as false. */
const is_broadcast_chat = async (chat_id: string): Promise<boolean> =>
  (await get_chat_type(chat_id)) === "broadcast";

export { get_chat_type, prime_chat_type, is_broadcast_chat };
