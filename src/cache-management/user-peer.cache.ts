import { redis, get_new_redis_client } from "@/config/redis";
import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { and, eq, isNull, inArray } from "drizzle-orm";
import LRUCache from "@/utils/cache.utils";
import { get_conversation_members } from "./conv.cache";

// ────────────────────────────────────────────────────────────────────────────
// 3-tier peer cache (mirrors conv.cache layout):
//   user_peers_cache (LRU, 10 min)         ─┐
//   redis  user_peers:{user_id}  set        ├─ user_id → peer user_ids
//   chat_member_model (DB)                 ─┘
//
// A peer = any user that shares at least one DM or group with {user_id}.
// Used to scope presence/typing/profile broadcasts without scanning every
// connected socket.
// ────────────────────────────────────────────────────────────────────────────

const REDIS_TTL_SEC = 24 * 60 * 60;
const LRU_TTL_MS = 10 * 60 * 1000;     // 10 min
const user_peers_key = (user_id: string) => `user_peers:${user_id}`;

const user_peers_cache = new LRUCache<string, Set<string>>();

const load_peers_from_db = async (user_id: string): Promise<string[]> => {
  const own_chats = await db
    .select({ chat_id: chat_member_model.chat_id })
    .from(chat_member_model)
    .where(
      and(
        eq(chat_member_model.user_id, user_id),
        isNull(chat_member_model.removed_at),
      ),
    );

  const chat_ids = own_chats
    .map((r) => r.chat_id)
    .filter((id): id is string => id !== null);
  if (chat_ids.length === 0) return [];

  const rows = await db
    .select({ user_id: chat_member_model.user_id })
    .from(chat_member_model)
    .where(
      and(
        inArray(chat_member_model.chat_id, chat_ids),
        isNull(chat_member_model.removed_at),
      ),
    );

  const peers = new Set<string>();
  for (const row of rows) {
    if (row.user_id && row.user_id !== user_id) peers.add(row.user_id);
  }
  return Array.from(peers);
};

const get_user_peers = async (user_id: string): Promise<Set<string>> => {
  // Tier 1: LRU
  const lru_hit = user_peers_cache.get(user_id);
  if (lru_hit !== null) return lru_hit;

  try {
    // Tier 2: Redis
    const cached = await redis.smembers(user_peers_key(user_id));
    let peers_set: Set<string>;

    if (cached.length > 0) {
      peers_set = new Set(cached);
    } else {
      // Tier 3: DB
      const peers = await load_peers_from_db(user_id);
      peers_set = new Set(peers);
      if (peers.length > 0) {
        const pipe = redis.pipeline();
        pipe.sadd(user_peers_key(user_id), ...peers);
        pipe.expire(user_peers_key(user_id), REDIS_TTL_SEC);
        await pipe.exec();
      }
    }

    user_peers_cache.set(user_id, peers_set, LRU_TTL_MS);
    return peers_set;
  } catch (err) {
    console.error(`[CACHE] get_user_peers failed (${user_id}):`, err);
    return new Set();
  }
};

// Intersect the peer set with a list of candidate user_ids (e.g. currently
// online users). Prefers LRU; falls back to a single SMISMEMBER so no data
// round-trips the wire beyond the candidate list.
const filter_peers = async (
  user_id: string,
  candidates: string[],
): Promise<string[]> => {
  if (candidates.length === 0) return [];
  const lru_hit = user_peers_cache.get(user_id);
  if (lru_hit !== null) return candidates.filter((c) => lru_hit.has(c));
  try {
    const flags = (await (redis as any).smismember(
      user_peers_key(user_id),
      ...candidates,
    )) as number[];
    return candidates.filter((_, i) => flags[i] === 1);
  } catch (err) {
    console.error(`[CACHE] filter_peers failed (${user_id}):`, err);
    return [];
  }
};

// Bidirectional add — call when a new chat membership links two users.
const add_peer = async (user_id: string, peer_id: string): Promise<void> => {
  if (user_id === peer_id) return;
  try {
    const pipe = redis.pipeline();
    pipe.sadd(user_peers_key(user_id), peer_id);
    pipe.expire(user_peers_key(user_id), REDIS_TTL_SEC);
    pipe.sadd(user_peers_key(peer_id), user_id);
    pipe.expire(user_peers_key(peer_id), REDIS_TTL_SEC);
    await pipe.exec();

    user_peers_cache.delete(user_id);
    user_peers_cache.delete(peer_id);
    await publish_peer_invalidation(user_id);
    await publish_peer_invalidation(peer_id);
  } catch (err) {
    console.error(`[CACHE] add_peer failed (${user_id}, ${peer_id}):`, err);
  }
};

// Bidirectional add for many peers at once (e.g. user joined a group).
const add_peers = async (user_id: string, peer_ids: string[]): Promise<void> => {
  const valid = peer_ids.filter((p) => p && p !== user_id);
  if (valid.length === 0) return;
  try {
    const pipe = redis.pipeline();
    pipe.sadd(user_peers_key(user_id), ...valid);
    pipe.expire(user_peers_key(user_id), REDIS_TTL_SEC);
    for (const p of valid) {
      pipe.sadd(user_peers_key(p), user_id);
      pipe.expire(user_peers_key(p), REDIS_TTL_SEC);
    }
    await pipe.exec();

    user_peers_cache.delete(user_id);
    for (const p of valid) user_peers_cache.delete(p);
    await publish_peer_invalidation(user_id);
    for (const p of valid) await publish_peer_invalidation(p);
  } catch (err) {
    console.error(`[CACHE] add_peers failed (${user_id}):`, err);
  }
};

// Caller must verify no shared chat remains before calling — this cache
// cannot tell whether another chat still links the two users.
const remove_peer = async (user_id: string, peer_id: string): Promise<void> => {
  if (user_id === peer_id) return;
  try {
    const pipe = redis.pipeline();
    pipe.srem(user_peers_key(user_id), peer_id);
    pipe.srem(user_peers_key(peer_id), user_id);
    await pipe.exec();

    user_peers_cache.delete(user_id);
    user_peers_cache.delete(peer_id);
    await publish_peer_invalidation(user_id);
    await publish_peer_invalidation(peer_id);
  } catch (err) {
    console.error(`[CACHE] remove_peer failed (${user_id}, ${peer_id}):`, err);
  }
};

const INVALIDATE_CHANNEL = "user_peer:invalidate";
// payload format: user_id

const _local_sub = get_new_redis_client();
_local_sub.subscribe(INVALIDATE_CHANNEL, (err) => {
  if (err) console.error("[CACHE] user_peer invalidation subscribe failed:", err);
});
_local_sub.on("message", (channel, message) => {
  if (channel !== INVALIDATE_CHANNEL) return;
  user_peers_cache.delete(message);
});

const publish_peer_invalidation = async (user_id: string): Promise<void> => {
  try {
    await redis.publish(INVALIDATE_CHANNEL, user_id);
  } catch (err) {
    console.error(`[CACHE] publish_peer_invalidation failed (${user_id}):`, err);
  }
};

const invalidate_peers = async (user_id: string): Promise<void> => {
  try {
    await redis.del(user_peers_key(user_id));
    user_peers_cache.delete(user_id);
    await publish_peer_invalidation(user_id);
  } catch (err) {
    console.error(`[CACHE] invalidate_peers failed (${user_id}):`, err);
  }
};

// Force a rebuild from DB (e.g. after a bulk membership change).
const rebuild_peers = async (user_id: string): Promise<Set<string>> => {
  await invalidate_peers(user_id);
  return get_user_peers(user_id);
};

// A new member joined the chat — link them bidirectionally with every
// existing member. Uses the conv cache so no extra DB hit on a warm cache.
const add_peer_via_chat = async (
  chat_id: string,
  new_user_id: string,
): Promise<void> => {
  try {
    const members = await get_conversation_members(chat_id);
    const others: string[] = [];
    for (const m of members) {
      if (m && m !== new_user_id) others.push(m);
    }
    if (others.length === 0) return;
    await add_peers(new_user_id, others);
  } catch (err) {
    console.error(`[CACHE] add_peer_via_chat failed (${chat_id}, ${new_user_id}):`, err);
  }
};

type PeerInvalidationHandlers = {
  on_peer_invalidated?: (user_id: string) => void | Promise<void>;
};

const subscribe_peer_invalidations = (
  handlers: PeerInvalidationHandlers,
): (() => Promise<void>) => {
  const sub = get_new_redis_client();
  sub.subscribe(INVALIDATE_CHANNEL, (err) => {
    if (err) console.error("[CACHE] peer invalidation subscribe failed:", err);
  });
  sub.on("message", (channel, message) => {
    if (channel !== INVALIDATE_CHANNEL) return;
    handlers.on_peer_invalidated?.(message);
  });
  return async () => {
    try {
      await sub.unsubscribe(INVALIDATE_CHANNEL);
    } catch { }
    sub.disconnect();
  };
};

export {
  user_peers_cache,
  get_user_peers,
  filter_peers,
  add_peer,
  add_peers,
  add_peer_via_chat,
  remove_peer,
  invalidate_peers,
  rebuild_peers,
  publish_peer_invalidation,
  subscribe_peer_invalidations,
};
export type { PeerInvalidationHandlers };
