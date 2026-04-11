import { redis } from "@/config/redis";

// ────────────────────────────────────────────────────────────────────────────
// Redis hash: chat_meta:{chat_id}
// Stores the last-message display data so the chat list never needs to
// JOIN messages or do N+1 queries.
// Fields: id, body, type, sender_id, sender_name, sent_at
// TTL: none (evicted only when chat is deleted)
// ────────────────────────────────────────────────────────────────────────────

type ChatMetaFields = {
  id: string;
  body: string;
  type: string;
  sender_id: string;
  sender_name: string;
  sent_at: string; // ISO timestamp
};

const chat_meta_key = (chat_id: string) => `chat_meta:${chat_id}`;

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
      sender_name: msg.sender_name ?? "",
      sent_at: msg.sent_at,
    });
  } catch (err) {
    console.error(`[CACHE] update_chat_meta failed for chat ${chat_id}:`, err);
  }
};

/**
 * Get last-message display data for a single chat.
 */
const get_chat_meta = async (chat_id: string): Promise<ChatMetaFields | null> => {
  try {
    const data = await redis.hgetall(chat_meta_key(chat_id));
    if (!data || !data.id) return null;
    return data as ChatMetaFields;
  } catch (err) {
    console.error(`[CACHE] get_chat_meta failed for chat ${chat_id}:`, err);
    return null;
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
      if (err || !data || !(data as any).id) {
        result.set(chat_ids[i], null);
      } else {
        result.set(chat_ids[i], data as ChatMetaFields);
      }
    }
  } catch (err) {
    console.error("[CACHE] get_chat_metas pipeline failed:", err);
    // Return empty map — caller will fall back to DB data
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
  get_chat_meta,
  get_chat_metas,
  increment_unread,
  batch_increment_unread,
  reset_unread,
  get_all_unread,
};
export type { ChatMetaFields };
