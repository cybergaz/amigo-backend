import { redis } from "@/config/redis";

// ────────────────────────────────────────────────────────────────────────────
// Short-lived per-message, per-user delivery/read status.
//
// Lives for ~MESSAGE_STATUS_TTL_SEC after the first ack so out-of-order acks
// can merge before being flushed to message_info.
//
// Keys:
//   msg_status:{message_id}   hash, field = user_id, value = JSON(MessageStatus)
//   msg_status:dirty          set of message_ids with unflushed updates
// ────────────────────────────────────────────────────────────────────────────

type MessageStatus = {
  delivered_at: string | null;   // ISO
  read_at: string | null;        // ISO
};

// TTL must outlive the debounce window so late ACKs can still merge after a flush.
// Flush every ~90s, keep status hashes for ~3 min.
const MESSAGE_STATUS_TTL_SEC = 180;

// Sentinel field on the per-message hash that stores chat_id. Not a user_id.
const CHAT_ID_FIELD = "__chat_id";

const msg_status_key = (message_id: string) => `msg_status:${message_id}`;
const dirty_key = "msg_status:dirty";

// Monotonic merge — only writes a newer timestamp for the requested field.
// Also pins chat_id on the hash (HSETNX) so the flush worker can emit
// message_info rows without a separate lookup. Sets TTL and dirties the msg.
const MERGE_STATUS_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local s = cur and cjson.decode(cur) or { delivered_at = cjson.null, read_at = cjson.null }
local f = ARGV[2]
local stored = s[f]
local changed = 0
if stored == nil or stored == cjson.null or tostring(stored) < ARGV[3] then
  s[f] = ARGV[3]
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(s))
  changed = 1
end
redis.call('HSETNX', KEYS[1], ARGV[6], ARGV[7])
redis.call('EXPIRE', KEYS[1], ARGV[4])
if changed == 1 then
  redis.call('SADD', KEYS[2], ARGV[5])
end
return changed
`;

const parse_status = (raw: string | null | undefined): MessageStatus => {
  if (!raw) return { delivered_at: null, read_at: null };
  try {
    const s = JSON.parse(raw);
    return {
      delivered_at: s.delivered_at ?? null,
      read_at: s.read_at ?? null,
    };
  } catch {
    return { delivered_at: null, read_at: null };
  }
};

const mark_delivered = async (
  message_id: string,
  chat_id: string,
  user_id: string,
  at: Date,
): Promise<boolean> => {
  try {
    const res = await redis.eval(
      MERGE_STATUS_LUA,
      2,
      msg_status_key(message_id),
      dirty_key,
      user_id,
      "delivered_at",
      at.toISOString(),
      String(MESSAGE_STATUS_TTL_SEC),
      message_id,
      CHAT_ID_FIELD,
      chat_id,
    );
    return res === 1;
  } catch (err) {
    console.error(`[CACHE] mark_delivered failed (${message_id}, ${user_id}):`, err);
    return false;
  }
};

const mark_read = async (
  message_id: string,
  chat_id: string,
  user_id: string,
  at: Date,
): Promise<boolean> => {
  try {
    const res = await redis.eval(
      MERGE_STATUS_LUA,
      2,
      msg_status_key(message_id),
      dirty_key,
      user_id,
      "read_at",
      at.toISOString(),
      String(MESSAGE_STATUS_TTL_SEC),
      message_id,
      CHAT_ID_FIELD,
      chat_id,
    );
    return res === 1;
  } catch (err) {
    console.error(`[CACHE] mark_read failed (${message_id}, ${user_id}):`, err);
    return false;
  }
};

type StatusKind = "delivered" | "read";

type AckGroup = {
  chat_id: string;
  msg_ids: string[];
  status: StatusKind[];
};

// One pipelined round-trip for an entire client batch. For each (msg, kind)
// it runs the same monotonic merge as mark_delivered/mark_read, so timestamps
// never go backwards and chat_id is pinned on first touch.
// Returns count of fields actually updated (skipped duplicates don't count).
const batch_mark_status = async (
  user_id: string,
  at: Date,
  groups: AckGroup[],
): Promise<number> => {
  if (groups.length === 0) return 0;
  const at_iso = at.toISOString();
  const ttl = String(MESSAGE_STATUS_TTL_SEC);
  const pipe = redis.pipeline();
  let dispatched = 0;

  for (const g of groups) {
    if (g.msg_ids.length === 0 || g.status.length === 0) continue;
    for (const msg_id of g.msg_ids) {
      for (const kind of g.status) {
        pipe.eval(
          MERGE_STATUS_LUA,
          2,
          msg_status_key(msg_id),
          dirty_key,
          user_id,
          kind === "delivered" ? "delivered_at" : "read_at",
          at_iso,
          ttl,
          msg_id,
          CHAT_ID_FIELD,
          g.chat_id,
        );
        dispatched++;
      }
    }
  }

  if (dispatched === 0) return 0;

  try {
    const replies = await pipe.exec();
    let updated = 0;
    for (const [err, res] of replies ?? []) {
      if (!err && res === 1) updated++;
    }
    return updated;
  } catch (err) {
    console.error(`[CACHE] batch_mark_status failed (${user_id}, ${dispatched} ops):`, err);
    return 0;
  }
};

// Splits an HGETALL result into the chat_id sentinel and the per-user statuses.
const split_hash = (
  data: Record<string, string>,
): { chat_id: string | null; statuses: Map<string, MessageStatus> } => {
  const statuses = new Map<string, MessageStatus>();
  let chat_id: string | null = null;
  for (const [field, raw] of Object.entries(data)) {
    if (field === CHAT_ID_FIELD) {
      chat_id = raw ?? null;
      continue;
    }
    statuses.set(field, parse_status(raw));
  }
  return { chat_id, statuses };
};

// All per-user statuses for one message (for building a full ack payload).
const get_message_statuses = async (
  message_id: string,
): Promise<Map<string, MessageStatus>> => {
  try {
    const data = await redis.hgetall(msg_status_key(message_id));
    return split_hash(data).statuses;
  } catch (err) {
    console.error(`[CACHE] get_message_statuses failed (${message_id}):`, err);
    return new Map();
  }
};

// Fetch statuses for many messages in one pipeline (e.g. flushing a window
// of recent messages to DB). Returns Map<message_id, Map<user_id, Status>>.
const get_message_statuses_bulk = async (
  message_ids: string[],
): Promise<Map<string, Map<string, MessageStatus>>> => {
  const out = new Map<string, Map<string, MessageStatus>>();
  if (message_ids.length === 0) return out;
  try {
    const pipe = redis.pipeline();
    for (const id of message_ids) pipe.hgetall(msg_status_key(id));
    const replies = await pipe.exec();
    for (let i = 0; i < message_ids.length; i++) {
      const [err, data] = replies![i];
      if (err) continue;
      out.set(message_ids[i], split_hash((data ?? {}) as Record<string, string>).statuses);
    }
  } catch (err) {
    console.error("[CACHE] get_message_statuses_bulk failed:", err);
  }
  return out;
};

const get_user_status_for_message = async (
  message_id: string,
  user_id: string,
): Promise<MessageStatus> => {
  if (user_id === CHAT_ID_FIELD) return { delivered_at: null, read_at: null };
  try {
    const raw = await redis.hget(msg_status_key(message_id), user_id);
    return parse_status(raw);
  } catch (err) {
    console.error(`[CACHE] get_user_status_for_message failed (${message_id}, ${user_id}):`, err);
    return { delivered_at: null, read_at: null };
  }
};

// Drain up to `limit` dirty messages and return their full status maps.
// Caller flushes these to message_info. After draining, the status hashes
// still exist (until TTL) so late acks merge naturally; a subsequent ack
// re-adds the message to the dirty set.
type DirtyMessage = {
  message_id: string;
  chat_id: string | null;
  statuses: Map<string, MessageStatus>;
};

const pop_dirty_messages = async (limit: number): Promise<DirtyMessage[]> => {
  if (limit <= 0) return [];
  try {
    const ids = (await redis.spop(dirty_key, limit)) as string[] | null;
    if (!ids || ids.length === 0) return [];

    const pipe = redis.pipeline();
    for (const id of ids) pipe.hgetall(msg_status_key(id));
    const replies = await pipe.exec();

    const out: DirtyMessage[] = [];
    for (let i = 0; i < ids.length; i++) {
      const [err, data] = replies![i];
      if (err) continue;
      const { chat_id, statuses } = split_hash((data ?? {}) as Record<string, string>);
      if (statuses.size > 0) out.push({ message_id: ids[i], chat_id, statuses });
    }
    return out;
  } catch (err) {
    console.error("[CACHE] pop_dirty_messages failed:", err);
    return [];
  }
};

// Drop the cached statuses for a message (e.g. after final flush).
const clear_message_statuses = async (message_id: string): Promise<void> => {
  try {
    const pipe = redis.pipeline();
    pipe.del(msg_status_key(message_id));
    pipe.srem(dirty_key, message_id);
    await pipe.exec();
  } catch (err) {
    console.error(`[CACHE] clear_message_statuses failed (${message_id}):`, err);
  }
};

const dirty_messages_count = async (): Promise<number> => {
  try {
    return await redis.scard(dirty_key);
  } catch {
    return 0;
  }
};

const readd_dirty_messages = async (items: DirtyMessage[]): Promise<void> => {
  if (items.length === 0) return;
  try {
    await redis.sadd(dirty_key, ...items.map((i) => i.message_id));
  } catch (err) {
    console.error("[CACHE] readd_dirty_messages failed:", err);
  }
};

type MessageFlushFn = (items: DirtyMessage[]) => Promise<void>;

// Debounce window: drain ACKs accumulated over the last ~90s on each tick.
const DEFAULT_MESSAGE_FLUSH_INTERVAL_MS = 90 * 1000;
const DEFAULT_MESSAGE_BATCH_SIZE = 500;

const start_message_flush_worker = (
  flush: MessageFlushFn,
  opts: { interval_ms?: number; batch_size?: number } = {},
): (() => void) => {
  const interval_ms = opts.interval_ms ?? DEFAULT_MESSAGE_FLUSH_INTERVAL_MS;
  const batch_size = opts.batch_size ?? DEFAULT_MESSAGE_BATCH_SIZE;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped || running) {
      schedule();
      return;
    }
    running = true;
    try {
      while (!stopped) {
        const batch = await pop_dirty_messages(batch_size);
        if (batch.length === 0) break;
        try {
          await flush(batch);
        } catch (err) {
          console.error("[CACHE] message flush failed, re-enqueueing:", err);
          await readd_dirty_messages(batch);
          break;
        }
      }
    } finally {
      running = false;
      schedule();
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, interval_ms);
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

export {
  mark_delivered,
  mark_read,
  batch_mark_status,
  get_message_statuses,
  get_message_statuses_bulk,
  get_user_status_for_message,
  pop_dirty_messages,
  readd_dirty_messages,
  clear_message_statuses,
  dirty_messages_count,
  start_message_flush_worker,
  MESSAGE_STATUS_TTL_SEC,
};
export type { MessageStatus, DirtyMessage, MessageFlushFn, StatusKind, AckGroup };
