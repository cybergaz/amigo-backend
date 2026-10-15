import { redis } from "@/config/redis";
import db from "@/config/db";
import { chat_model } from "@/models/chat.model";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { MessageType } from "@/types/chat.types";
import { sync_v2_flags } from "@/services/app-settings.service";
import { v2_on } from "@/services/sync/flags-core";
import { count } from "@/utils/counters";
import { bind_meta_cas } from "./chat-meta-cas";
import { strip_list } from "@/utils/attachment-thumbs";

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
  // SYNC_V2 §3.5 (write side only; never read back into a payload): the
  // message's seq and server arrival time. With sync_v2 'on' a write that
  // carries a seq is a compare-and-set on the hash's `seq` field.
  seq?: number | null;
  srv_ts?: string | null;
};

// Bound lazily: only sync_v2 'on' ever runs the script.
let meta_cas: ReturnType<typeof bind_meta_cas> | null = null;
const cas = () => (meta_cas ??= bind_meta_cas(redis));

// Use the seq-CAS for this write? Only in 'on' and only when the caller knows
// the seq (a numbered chat's insert returned it). Off / shadow keep the plain
// last-writer-wins HSET, byte-for-byte the old hash.
const use_cas = (msg: ChatMetaFields): msg is ChatMetaFields & { seq: number } =>
  typeof msg.seq === "number" && Number.isFinite(msg.seq) && v2_on(sync_v2_flags());

// A list preview never needs the inline thumbs (§14.7 item 5): they stay out
// of the chat_meta hash (strip_list is identity when there are none).
const meta_attachments = (a: unknown): string => (a != null ? JSON.stringify(strip_list(a)) : "");

const meta_hash_fields = (msg: ChatMetaFields): Record<string, string> => ({
  id: msg.id,
  body: msg.body ?? "",
  type: msg.type,
  sender_id: msg.sender_id,
  sent_at: msg.sent_at,
  attachments: meta_attachments(msg.attachments),
});

const note_cas = (r: number, chat_id: string): void => {
  if (r === 1) count("META", "cas_written");
  else if (r === 0) count("META", "cas_refused");
  else console.error(`[CACHE] chat_meta CAS failed for chat ${chat_id}`);
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
    if (use_cas(msg)) {
      const fields = meta_hash_fields(msg);
      if (msg.srv_ts) fields.srv_ts = msg.srv_ts;
      note_cas(await cas().cas(chat_meta_key(chat_id), msg.seq, fields), chat_id);
      return;
    }
    await redis.hset(chat_meta_key(chat_id), {
      id: msg.id,
      body: msg.body ?? "",
      type: msg.type,
      sender_id: msg.sender_id,
      // sender_name: msg.sender_name ?? "",
      sent_at: msg.sent_at,
      attachments: meta_attachments(msg.attachments),
    });
  } catch (err) {
    console.error(`[CACHE] update_chat_meta failed for chat ${chat_id}:`, err);
  }
};

// Fields of the hash that describe the last message. Deliberately enumerated
// so a clear never touches DISAPPEARING_FIELD, which lives on the same hash.
// `seq` / `srv_ts` (sync_v2 'on' writes) go too: a rewind must also clear the
// CAS guard, or the next (lower-seq) refill would be refused.
const LAST_MESSAGE_FIELDS = ["id", "body", "type", "sender_id", "sent_at", "attachments", "seq", "srv_ts"] as const;

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
 * SYNC_V2 §3.3.4: the Postgres half only writes while the chat is NOT
 * numbered (seq_head IS NULL, in the same WHERE — no extra round trip). On a
 * numbered chat the clock owns the pointer: messages_bi moves last_seq /
 * last_msg_id in the allocating UPDATE and the delete triggers rewind it, by
 * seq. A sent_at-ordered write from here would fight them.
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
  // numbered: the caller KNOWS the chat is numbered — its INSERT returned a
  // seq, so messages_bi already moved the pointer in that same statement.
  // The PG half is then skipped outright: one round trip less on every send
  // (the guarded UPDATE below would match no row anyway).
  opts?: { allow_rewind?: boolean; numbered?: boolean; },
): Promise<void> => {
  // sent_at travels as an ISO string in the hash but must be a Date for the
  // timestamptz column; fall back to now() rather than writing a NULL pointer.
  const parsed = new Date(msg.sent_at);
  const sent_at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  await Promise.all([
    update_chat_meta(chat_id, { ...msg, sent_at: sent_at.toISOString() }),
    opts?.numbered ? Promise.resolve() : db
      .update(chat_model)
      .set({ last_msg_id: msg.id, last_msg_at: sent_at })
      .where(
        opts?.allow_rewind
          ? and(eq(chat_model.id, chat_id), isNull(chat_model.seq_head))
          : and(
            eq(chat_model.id, chat_id),
            isNull(chat_model.seq_head),
            or(isNull(chat_model.last_msg_at), lte(chat_model.last_msg_at, sent_at)),
          ),
      )
      .catch((err) =>
        console.error(`[LASTMSG] postgres pointer write failed for chat ${chat_id}:`, err),
      ),
  ]);
};

/**
 * Bulk form of set_last_message for one event that moves MANY chats' last
 * message at once — a broadcast-list send updates every recipient's DM plus
 * the list itself. Same two halves, same rules, but O(1) round-trips instead
 * of O(N): ONE Redis pipeline for the chat_meta hashes and ONE Postgres
 * `UPDATE … FROM (VALUES …)` for the pointers.
 *
 * The Postgres half keeps set_last_message's MONOTONIC rule per row
 * (last_msg_at IS NULL OR last_msg_at <= sent_at), so an out-of-order write
 * can never rewind any of the chats. There is no allow_rewind variant on
 * purpose — rewinds only happen on delete, which repoints one chat at a time.
 *
 * Never rejects; each half logs and swallows its own failure (one failing must
 * not skip the other), exactly like set_last_message.
 */
const batch_set_last_message = async (
  entries: { chat_id: string; msg: ChatMetaFields }[],
): Promise<void> => {
  if (entries.length === 0) return;

  const normalized = entries.map(({ chat_id, msg }) => {
    const parsed = new Date(msg.sent_at);
    const sent_at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    return { chat_id, msg: { ...msg, sent_at: sent_at.toISOString() } };
  });

  const redis_half = (async () => {
    try {
      // sync_v2 'on': entries with a seq go through the seq-CAS (one
      // pipeline); the rest keep the plain HSET pipeline. Both in parallel.
      const cas_entries = normalized.filter(({ msg }) => use_cas(msg));
      const plain = cas_entries.length === normalized.length
        ? []
        : normalized.filter(({ msg }) => !use_cas(msg));
      const plain_half = (async () => {
        if (plain.length === 0) return;
        const pipe = redis.pipeline();
        for (const { chat_id, msg } of plain) {
          pipe.hset(chat_meta_key(chat_id), meta_hash_fields(msg));
        }
        await pipe.exec();
      })();
      const cas_half = (async () => {
        if (cas_entries.length === 0) return;
        const res = await cas().cas_many(cas_entries.map(({ chat_id, msg }) => {
          const fields = meta_hash_fields(msg);
          if (msg.srv_ts) fields.srv_ts = msg.srv_ts;
          return { key: chat_meta_key(chat_id), seq: msg.seq as number, fields };
        }));
        res.forEach((r, i) => note_cas(r, cas_entries[i]!.chat_id));
      })();
      await Promise.all([plain_half, cas_half]);
    } catch (err) {
      console.error(`[CACHE] batch_set_last_message redis half failed (${normalized.length} chats):`, err);
    }
  })();

  const postgres_half = (async () => {
    try {
      const rows = normalized.map(
        ({ chat_id, msg }) =>
          sql`(${chat_id}::uuid, ${msg.id}::uuid, ${msg.sent_at}::timestamptz)`,
      );
      await db.execute(sql`
        UPDATE ${chat_model} AS c
        SET last_msg_id = v.msg_id,
            last_msg_at = v.sent_at
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(chat_id, msg_id, sent_at)
        WHERE c.id = v.chat_id
          AND c.seq_head IS NULL  -- numbered chats: the clock owns the pointer (§3.3.4)
          AND (c.last_msg_at IS NULL OR c.last_msg_at <= v.sent_at)
      `);
    } catch (err) {
      console.error(`[LASTMSG] batch postgres pointer write failed (${normalized.length} chats):`, err);
    }
  })();

  await Promise.all([redis_half, postgres_half]);
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
 * Batch increment unread by an arbitrary amount, in a single pipeline.
 *
 * A forward drops N messages into a chat in one shot. Calling
 * batch_increment_unread N times would issue N pipelines for what is one
 * logical bump, so the forward path uses this instead.
 */
const batch_increment_unread_by = async (
  user_ids: string[],
  chat_id: string,
  by: number,
): Promise<void> => {
  if (user_ids.length === 0 || by <= 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const uid of user_ids) {
      pipeline.hincrby(unread_key(uid), chat_id, by);
    }
    await pipeline.exec();
  } catch (err) {
    console.error(`[CACHE] batch_increment_unread_by failed for chat ${chat_id}:`, err);
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
 * Set the unread count for a user in a specific chat to an absolute value.
 * Used by the read handlers when the read watermark is NOT the chat's newest
 * message, so a stale or replayed read can't zero messages that arrived after it.
 */
const set_unread = async (user_id: string, chat_id: string, count: number): Promise<void> => {
  try {
    await redis.hset(unread_key(user_id), chat_id, String(Math.max(0, count)));
  } catch (err) {
    console.error(`[CACHE] set_unread failed for user ${user_id}, chat ${chat_id}:`, err);
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
  batch_set_last_message,
  clear_chat_meta_message,
  get_chat_meta,
  get_chat_metas,
  get_disappearing_after_sec,
  set_disappearing_after_sec,
  increment_unread,
  batch_increment_unread,
  batch_increment_unread_by,
  reset_unread,
  set_unread,
  get_unread,
  get_all_unread,
};
export type { ChatMetaFields };
