import { redis } from "@/config/redis";
import db from "@/config/db";
import { chat_model } from "@/models/chat.model";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { MessageType } from "@/types/chat.types";

// ────────────────────────────────────────────────────────────────────────────
// Redis hash: chat_meta:{chat_id}
// Stores the last-message display data so the chat list never needs to
// JOIN messages or do N+1 queries.
// Fields: id, body, type, sender_id, sent_at, attachments
// `attachments` is JSON-stringified on write and parsed on read because
// Redis hash values are strings.
// TTL: none (evicted only when chat is deleted)
// ────────────────────────────────────────────────────────────────────────────

type ChatMetaFields = {
  id: string; // message ID
  body: string;
  type: MessageType;
  sender_id: string;
  // sender_name: string;
  sent_at: string; // ISO timestamp
  attachments?: unknown; // [{url, mime, size, key, thumbnail}] — null/missing for text
};

// Cached chats.disappearing_after_sec. Separate field on the same hash so
// updating the last-message fields doesn't clobber the setting and vice versa.
const DISAPPEARING_FIELD = "disappearing_after_sec";

const chat_meta_key = (chat_id: string) => `chat_meta:${chat_id}`;

/**
 * Parse the raw hgetall response into a ChatMetaFields, decoding the
 * attachments JSON. Returns null if the row is empty.
 */
const parse_chat_meta_row = (raw: Record<string, string> | null | undefined): ChatMetaFields | null => {
  if (!raw || !raw.id) return null;
  let attachments: unknown = null;
  if (raw.attachments) {
    try {
      attachments = JSON.parse(raw.attachments);
    } catch {
      attachments = null;
    }
  }
  return {
    id: raw.id,
    body: raw.body ?? "",
    type: raw.type as MessageType,
    sender_id: raw.sender_id,
    sent_at: raw.sent_at,
    attachments,
  };
};

/**
 * Update the last-message display data for a chat.
 * Called fire-and-forget from handle_message_new after storing + broadcasting.
 */
const update_chat_meta = async (chat_id: string, msg: ChatMetaFields): Promise<void> => {
  try {
    await redis.hset(chat_meta_key(chat_id), {
      id: msg.id,
      body: msg.body ?? "",
      type: msg.type,
      sender_id: msg.sender_id,
      // sender_name: msg.sender_name ?? "",
      sent_at: msg.sent_at,
      attachments: msg.attachments != null ? JSON.stringify(msg.attachments) : "",
    });
  } catch (err) {
    console.error(`[CACHE] update_chat_meta failed for chat ${chat_id}:`, err);
  }
};

// Fields of the hash that describe the last message. Deliberately enumerated
// so a clear never touches DISAPPEARING_FIELD, which lives on the same hash.
const LAST_MESSAGE_FIELDS = ["id", "body", "type", "sender_id", "sent_at", "attachments"] as const;

/**
 * Drop ONLY the last-message fields, leaving the disappearing setting intact.
 * Used when the chat's newest message is deleted and nothing visible is left —
 * without this the hash would keep serving the deleted message as the chat-list
 * preview forever (the chat_meta hash has no TTL).
 */
const clear_chat_meta_message = async (chat_id: string): Promise<void> => {
  try {
    await redis.hdel(chat_meta_key(chat_id), ...LAST_MESSAGE_FIELDS);
  } catch (err) {
    console.error(`[CACHE] clear_chat_meta_message failed for chat ${chat_id}:`, err);
  }
};

/**
 * THE single last-message writer: keeps the Redis chat_meta hash (display data)
 * and the Postgres pointer (chats.last_msg_id / last_msg_at) in lockstep.
 *
 * WHY: chat_meta is a CACHE that is never flushed to Postgres, and every site
 * that wrote only one of the two halves left the other stale — a cache wipe
 * blanked the whole chat list (no preview, and the app hides chats whose
 * last_msg_id is null), while a Postgres-only writer left the list previewing
 * an older, or even deleted, message. Call this instead of update_chat_meta
 * anywhere a chat's newest message changes.
 *
 * Never rejects — both halves swallow their own errors independently (one
 * failing must not skip the other), so latency-sensitive callers can fire it
 * un-awaited exactly like update_chat_meta.
 *
 * The Postgres half is MONOTONIC: the pointer only moves forward
 * (last_msg_at IS NULL OR last_msg_at <= sent_at). An out-of-order write — a
 * queued/retried send landing after a newer one — therefore cannot rewind the
 * list, and redundant writes are dropped by the WHERE instead of queueing on
 * the single busiest chat row in a 100+ member group. Pass allow_rewind for the
 * one case where the pointer must legitimately move BACKWARD: repointing after
 * the newest message was deleted.
 *
 * The Redis half stays last-writer-wins (unchanged behaviour — making it
 * monotonic would need a read-modify-write or a Lua script on the send path).
 * The two can therefore disagree for an offline-queued message that lands with
 * an older sent_at than one already recorded; the durable half keeps the newer
 * message, so the disagreement resolves in the right direction on any wipe.
 */
const set_last_message = async (
  chat_id: string,
  msg: ChatMetaFields,
  opts?: { allow_rewind?: boolean; },
): Promise<void> => {
  // sent_at travels as an ISO string in the hash but must be a Date for the
  // timestamptz column; fall back to now() rather than writing a NULL pointer.
  const parsed = new Date(msg.sent_at);
  const sent_at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  await Promise.all([
    update_chat_meta(chat_id, { ...msg, sent_at: sent_at.toISOString() }),
    db
      .update(chat_model)
      .set({ last_msg_id: msg.id, last_msg_at: sent_at })
      .where(
        opts?.allow_rewind
          ? eq(chat_model.id, chat_id)
          : and(
            eq(chat_model.id, chat_id),
            or(isNull(chat_model.last_msg_at), lte(chat_model.last_msg_at, sent_at)),
          ),
      )
      .catch((err) =>
        console.error(`[LASTMSG] postgres pointer write failed for chat ${chat_id}:`, err),
      ),
  ]);
};

/**
 * Get last-message display data for a single chat.
 */
const get_chat_meta = async (chat_id: string): Promise<ChatMetaFields | null> => {
  try {
    const data = await redis.hgetall(chat_meta_key(chat_id));
    return parse_chat_meta_row(data as Record<string, string>);
  } catch (err) {
    console.error(`[CACHE] get_chat_meta failed for chat ${chat_id}:`, err);
    return null;
  }
};

// Read the cached disappearing-messages duration for a chat. Returns null when
// the chat hasn't been touched yet (caller falls back to a DB read + hydrate)
// or when disappearing is explicitly off (stored as the literal string "0").
const get_disappearing_after_sec = async (chat_id: string): Promise<number | null | undefined> => {
  try {
    const raw = await redis.hget(chat_meta_key(chat_id), DISAPPEARING_FIELD);
    if (raw == null) return undefined; // miss — caller hydrates
    if (raw === "" || raw === "0") return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    console.error(`[CACHE] get_disappearing_after_sec failed (${chat_id}):`, err);
    return undefined;
  }
};

// Write the disappearing-messages duration into the chat_meta hash. Passing
// null clears the setting. Used by the settings endpoint after the DB update
// and by the send path to hydrate the cache lazily on first miss.
const set_disappearing_after_sec = async (chat_id: string, duration_sec: number | null): Promise<void> => {
  try {
    await redis.hset(chat_meta_key(chat_id), DISAPPEARING_FIELD, duration_sec == null ? "0" : String(duration_sec));
  } catch (err) {
    console.error(`[CACHE] set_disappearing_after_sec failed (${chat_id}):`, err);
  }
};

/**
 * Get last-message display data for multiple chats in one pipeline call.
 * Returns a Map<chat_id, ChatMetaFields | null>.
 */
const get_chat_metas = async (chat_ids: string[]): Promise<Map<string, ChatMetaFields | null>> => {
  const result = new Map<string, ChatMetaFields | null>();
  if (chat_ids.length === 0) return result;

  try {
    const pipeline = redis.pipeline();
    for (const id of chat_ids) {
      pipeline.hgetall(chat_meta_key(id));
    }
    const replies = await pipeline.exec();

    for (let i = 0; i < chat_ids.length; i++) {
      const [err, data] = replies![i];
      if (err) {
        result.set(chat_ids[i], null);
      } else {
        result.set(chat_ids[i], parse_chat_meta_row(data as Record<string, string>));
      }
    }
  } catch (err) {
    console.error("[CACHE] get_chat_metas pipeline failed:", err);
    // Return a partial/empty map. get_chat_list treats every chat_id that has
    // no entry (or a null one) as a miss and resolves it from Postgres — see
    // its read-through fallback. Callers that don't implement that fallback
    // simply ship no preview for those chats.
  }

  return result;
};

// ────────────────────────────────────────────────────────────────────────────
// Redis hash: user_unread:{user_id}
// Key = chat_id, value = unread count (integer stored as string)
// Operations: HINCRBY +1 on new message, HSET 0 on conversation join
// ────────────────────────────────────────────────────────────────────────────

const unread_key = (user_id: string) => `user_unread:${user_id}`;

/**
 * Increment unread count for a user in a specific chat.
 * Called from handle_message_new for offline/inactive members (fire-and-forget).
 */
const increment_unread = async (user_id: string, chat_id: string): Promise<void> => {
  try {
    await redis.hincrby(unread_key(user_id), chat_id, 1);
  } catch (err) {
    console.error(`[CACHE] increment_unread failed for user ${user_id}, chat ${chat_id}:`, err);
  }
};

/**
 * Batch increment unread for multiple users in a single pipeline.
 */
const batch_increment_unread = async (user_ids: string[], chat_id: string): Promise<void> => {
  if (user_ids.length === 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const uid of user_ids) {
      pipeline.hincrby(unread_key(uid), chat_id, 1);
    }
    await pipeline.exec();
  } catch (err) {
    console.error(`[CACHE] batch_increment_unread failed for chat ${chat_id}:`, err);
  }
};

/**
 * Reset unread count for a user in a specific chat (user opened the chat).
 * Called from handle_join_conversation.
 */
const reset_unread = async (user_id: string, chat_id: string): Promise<void> => {
  try {
    await redis.hset(unread_key(user_id), chat_id, "0");
  } catch (err) {
    console.error(`[CACHE] reset_unread failed for user ${user_id}, chat ${chat_id}:`, err);
  }
};

/**
 * Get unread count for a user in a specific chat.
 * Returns 0 if no entry exists (treated as "no unread").
 */
const get_unread = async (user_id: string, chat_id: string): Promise<number> => {
  try {
    const raw = await redis.hget(unread_key(user_id), chat_id);
    if (!raw) return 0;
    const count = parseInt(raw, 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch (err) {
    console.error(`[CACHE] get_unread failed for user ${user_id}, chat ${chat_id}:`, err);
    return 0;
  }
};

/**
 * Get all unread counts for a user (for chat list enrichment).
 * Returns Map<chat_id, count>.
 */
const get_all_unread = async (user_id: string): Promise<Map<string, number>> => {
  const result = new Map<string, number>();
  try {
    const data = await redis.hgetall(unread_key(user_id));
    for (const [chat_id, count_str] of Object.entries(data)) {
      const count = parseInt(count_str, 10);
      if (count > 0) result.set(chat_id, count);
    }
  } catch (err) {
    console.error(`[CACHE] get_all_unread failed for user ${user_id}:`, err);
  }
  return result;
};

export {
  update_chat_meta,
  set_last_message,
  clear_chat_meta_message,
  get_chat_meta,
  get_chat_metas,
  get_disappearing_after_sec,
  set_disappearing_after_sec,
  increment_unread,
  batch_increment_unread,
  reset_unread,
  get_unread,
  get_all_unread,
};
export type { ChatMetaFields };
