import { redis } from "@/config/redis";

// ────────────────────────────────────────────────────────────────────────────
// Per-member receipts for each chat.
//
// Primary key (hash):
//   user_receipts:{user_id}     field = chat_id   value = JSON(Receipt)
// Dirty set (for 5-min flush worker):
//   receipts:dirty              members = "user_id:chat_id"
//
// Unread count is computed by the caller by diffing last_read_msg_id
// against the chat's latest message.
// ────────────────────────────────────────────────────────────────────────────

type Receipt = {
  last_delivered_msg_id: string | null;
  last_delivered_at: string | null;   // ISO
  last_read_msg_id: string | null;
  last_read_at: string | null;        // ISO
};

const EMPTY: Receipt = {
  last_delivered_msg_id: null,
  last_delivered_at: null,
  last_read_msg_id: null,
  last_read_at: null,
};

const user_receipts_key = (user_id: string) => `user_receipts:${user_id}`;
const dirty_key = "receipts:dirty";
const dirty_member = (user_id: string, chat_id: string) => `${user_id}:${chat_id}`;

// Monotonic update — only overwrites if new_at > stored_at (lexicographic ISO).
// Also marks (user,chat) dirty. Returns 1 if updated, 0 if skipped.
const MONOTONIC_UPDATE_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local r = cur and cjson.decode(cur) or {
  last_delivered_msg_id = cjson.null,
  last_delivered_at     = cjson.null,
  last_read_msg_id      = cjson.null,
  last_read_at          = cjson.null,
}
local id_f, at_f
if ARGV[4] == 'delivered' then id_f, at_f = 'last_delivered_msg_id', 'last_delivered_at'
else                           id_f, at_f = 'last_read_msg_id',      'last_read_at'      end
local stored = r[at_f]
if stored ~= nil and stored ~= cjson.null and tostring(stored) >= ARGV[3] then
  return 0
end
r[id_f] = ARGV[2]
r[at_f] = ARGV[3]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(r))
redis.call('SADD', KEYS[2], ARGV[5])
return 1
`;

// Combined update — sets delivered and/or read in one atomic round-trip.
// ARGV: [chat_id, dirty_member, delivered_msg_id|"", delivered_at|"", read_msg_id|"", read_at|""]
const MONOTONIC_COMBINED_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local r = cur and cjson.decode(cur) or {
  last_delivered_msg_id = cjson.null,
  last_delivered_at     = cjson.null,
  last_read_msg_id      = cjson.null,
  last_read_at          = cjson.null,
}
local changed = 0
if ARGV[4] ~= '' then
  local s = r.last_delivered_at
  if s == nil or s == cjson.null or tostring(s) < ARGV[4] then
    r.last_delivered_msg_id = ARGV[3]
    r.last_delivered_at     = ARGV[4]
    changed = 1
  end
end
if ARGV[6] ~= '' then
  local s = r.last_read_at
  if s == nil or s == cjson.null or tostring(s) < ARGV[6] then
    r.last_read_msg_id = ARGV[5]
    r.last_read_at     = ARGV[6]
    changed = 1
  end
end
if changed == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(r))
  redis.call('SADD', KEYS[2], ARGV[2])
end
return changed
`;

const parse_receipt = (raw: string | null | undefined): Receipt => {
  if (!raw) return { ...EMPTY };
  try {
    const r = JSON.parse(raw);
    return {
      last_delivered_msg_id: r.last_delivered_msg_id ?? null,
      last_delivered_at: r.last_delivered_at ?? null,
      last_read_msg_id: r.last_read_msg_id ?? null,
      last_read_at: r.last_read_at ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
};

const set_last_delivered = async (
  user_id: string,
  chat_id: string,
  msg_id: string,
  at: Date | string,
): Promise<boolean> => {
  try {
    const at_str = at instanceof Date ? at.toISOString() : (typeof at === 'string' ? at : new Date(at).toISOString());
    const res = await redis.eval(
      MONOTONIC_UPDATE_LUA,
      2,
      user_receipts_key(user_id),
      dirty_key,
      chat_id,
      msg_id,
      at_str,
      "delivered",
      dirty_member(user_id, chat_id),
    );
    return res === 1;
  } catch (err) {
    console.error(`[CACHE] set_last_delivered failed (${user_id}, ${chat_id}):`, err);
    return false;
  }
};

const set_last_read = async (
  user_id: string,
  chat_id: string,
  msg_id: string,
  at: Date | string,
): Promise<boolean> => {
  try {
    const at_str = at instanceof Date ? at.toISOString() : (typeof at === 'string' ? at : new Date(at).toISOString());
    const res = await redis.eval(
      MONOTONIC_UPDATE_LUA,
      2,
      user_receipts_key(user_id),
      dirty_key,
      chat_id,
      msg_id,
      at_str,
      "read",
      dirty_member(user_id, chat_id),
    );
    return res === 1;
  } catch (err) {
    console.error(`[CACHE] set_last_read failed (${user_id}, ${chat_id}):`, err);
    return false;
  }
};

// Set delivered and/or read in one atomic call. Pass undefined for fields you
// don't want to touch. Returns true if anything was updated.
type ReceiptUpdate = {
  delivered?: { msg_id: string; at: Date };
  read?: { msg_id: string; at: Date };
};

const set_receipt = async (
  user_id: string,
  chat_id: string,
  update: ReceiptUpdate,
): Promise<boolean> => {
  if (!update.delivered && !update.read) return false;
  try {
    const res = await redis.eval(
      MONOTONIC_COMBINED_LUA,
      2,
      user_receipts_key(user_id),
      dirty_key,
      chat_id,
      dirty_member(user_id, chat_id),
      update.delivered?.msg_id ?? "",
      update.delivered?.at.toISOString() ?? "",
      update.read?.msg_id ?? "",
      update.read?.at.toISOString() ?? "",
    );
    return res === 1;
  } catch (err) {
    console.error(`[CACHE] set_receipt failed (${user_id}, ${chat_id}):`, err);
    return false;
  }
};

const get_receipt = async (user_id: string, chat_id: string): Promise<Receipt> => {
  try {
    const raw = await redis.hget(user_receipts_key(user_id), chat_id);
    return parse_receipt(raw);
  } catch (err) {
    console.error(`[CACHE] get_receipt failed (${user_id}, ${chat_id}):`, err);
    return { ...EMPTY };
  }
};

// All receipts for one user — used to enrich the chat list.
const get_user_receipts = async (user_id: string): Promise<Map<string, Receipt>> => {
  const result = new Map<string, Receipt>();
  try {
    const data = await redis.hgetall(user_receipts_key(user_id));
    for (const [chat_id, raw] of Object.entries(data)) {
      result.set(chat_id, parse_receipt(raw));
    }
  } catch (err) {
    console.error(`[CACHE] get_user_receipts failed (${user_id}):`, err);
  }
  return result;
};

// Receipts for a specific chat across a set of users (for broadcasting message:ack).
// Uses one pipeline; user_ids is typically the chat's member set.
const get_chat_receipts = async (
  chat_id: string,
  user_ids: string[],
): Promise<Map<string, Receipt>> => {
  const result = new Map<string, Receipt>();
  if (user_ids.length === 0) return result;
  try {
    const pipe = redis.pipeline();
    for (const uid of user_ids) pipe.hget(user_receipts_key(uid), chat_id);
    const replies = await pipe.exec();
    for (let i = 0; i < user_ids.length; i++) {
      const [err, raw] = replies![i];
      if (err) continue;
      result.set(user_ids[i], parse_receipt(raw as string | null));
    }
  } catch (err) {
    console.error(`[CACHE] get_chat_receipts failed (${chat_id}):`, err);
  }
  return result;
};

// Remove the whole receipt entry (e.g. user left chat).
const clear_receipt = async (user_id: string, chat_id: string): Promise<void> => {
  try {
    const pipe = redis.pipeline();
    pipe.hdel(user_receipts_key(user_id), chat_id);
    pipe.srem(dirty_key, dirty_member(user_id, chat_id));
    await pipe.exec();
  } catch (err) {
    console.error(`[CACHE] clear_receipt failed (${user_id}, ${chat_id}):`, err);
  }
};

// Drain up to `limit` dirty entries and fetch their current receipts in one round-trip.
// Caller upserts these into Postgres, then the entries stay out of the dirty set
// until a new ack bumps them again.
type DirtyReceipt = { user_id: string; chat_id: string; receipt: Receipt };

const pop_dirty_receipts = async (limit: number): Promise<DirtyReceipt[]> => {
  if (limit <= 0) return [];
  try {
    const members = (await redis.spop(dirty_key, limit)) as string[] | null;
    if (!members || members.length === 0) return [];

    const parsed = members
      .map((m) => {
        const idx = m.indexOf(":");
        if (idx < 0) return null;
        return { user_id: m.slice(0, idx), chat_id: m.slice(idx + 1) };
      })
      .filter((x): x is { user_id: string; chat_id: string } => x !== null);

    const pipe = redis.pipeline();
    for (const { user_id, chat_id } of parsed) {
      pipe.hget(user_receipts_key(user_id), chat_id);
    }
    const replies = await pipe.exec();

    const out: DirtyReceipt[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const [err, raw] = replies![i];
      if (err) continue;
      out.push({
        user_id: parsed[i].user_id,
        chat_id: parsed[i].chat_id,
        receipt: parse_receipt(raw as string | null),
      });
    }
    return out;
  } catch (err) {
    console.error("[CACHE] pop_dirty_receipts failed:", err);
    return [];
  }
};

// How many entries are currently waiting to be flushed.
const dirty_receipts_count = async (): Promise<number> => {
  try {
    return await redis.scard(dirty_key);
  } catch {
    return 0;
  }
};

// Push items back onto the dirty set — used by the flush worker when the
// caller's upsert throws, so data isn't lost.
const readd_dirty_receipts = async (items: DirtyReceipt[]): Promise<void> => {
  if (items.length === 0) return;
  try {
    const members = items.map((i) => dirty_member(i.user_id, i.chat_id));
    await redis.sadd(dirty_key, ...members);
  } catch (err) {
    console.error("[CACHE] readd_dirty_receipts failed:", err);
  }
};

// Periodic flush worker. Call with your DB upsert function. Drains the dirty
// set in batches on each tick; re-enqueues on error. Returns a stop() fn.
type ReceiptFlushFn = (items: DirtyReceipt[]) => Promise<void>;

const DEFAULT_RECEIPT_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RECEIPT_BATCH_SIZE = 500;

const start_receipt_flush_worker = (
  flush: ReceiptFlushFn,
  opts: { interval_ms?: number; batch_size?: number } = {},
): (() => void) => {
  const interval_ms = opts.interval_ms ?? DEFAULT_RECEIPT_FLUSH_INTERVAL_MS;
  const batch_size = opts.batch_size ?? DEFAULT_RECEIPT_BATCH_SIZE;
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
        const batch = await pop_dirty_receipts(batch_size);
        if (batch.length === 0) break;
        try {
          await flush(batch);
        } catch (err) {
          console.error("[CACHE] receipt flush failed, re-enqueueing:", err);
          await readd_dirty_receipts(batch);
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
  set_last_delivered,
  set_last_read,
  set_receipt,
  get_receipt,
  get_user_receipts,
  get_chat_receipts,
  clear_receipt,
  pop_dirty_receipts,
  readd_dirty_receipts,
  dirty_receipts_count,
  start_receipt_flush_worker,
};
export type { Receipt, DirtyReceipt, ReceiptUpdate, ReceiptFlushFn };
