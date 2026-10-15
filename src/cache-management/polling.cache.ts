import "dotenv/config";
import { redis } from "@/config/redis";
import db, { pg_client } from "@/config/db";
import { message_model, missed_ws_messages_model } from "@/models/message.model";
import { VITAL_WS_EVENTS_CONST, VitalWSMessage, VitalWSMessageEventsType, WSMessageEventsType } from "@/types/socket.types";
import { eq, and, lt, asc, gt, inArray, isNull, or } from "drizzle-orm";
import Snowflake from "@/utils/snowflake.utils";
import { sort_pending_for_replay } from "@/utils/pending-order.utils";
import {
  RETURN_META_TTL_SECONDS,
  classify_pending_read,
  finalize_pending_read,
  format_return_meta,
  message_id_of,
  newer_pending_entry,
  parse_return_meta,
  stale_meta_keys,
  type ReturnMeta,
} from "@/utils/poll-ack-drain.utils";
import {
  TOMBSTONE_WINDOW_MS,
  create_deferred_writer,
  create_pending_redis,
  db_delete_exact,
  db_delete_versions,
  db_upsert_entries,
  encode_entry,
  parse_value,
  redis_entries_key,
  redis_return_meta_key,
  uuid7_ms,
  type DrainItem,
  type PendingEntry,
} from "./pending-store-core";
import { is_uuid } from "@/utils/broadcast.utils";
import { count } from "@/utils/counters";
import { debug_log } from "@/utils/debug-log";
import { strip_ws_thumbs } from "@/utils/attachment-thumbs";
import { randomUUIDv7 } from "bun";
import { run_batched_singleton, run_daily } from "@/cluster/jobs";
import { is_draining, track } from "@/cluster/lifecycle";
import { ROUTING_MODE, presence_authoritative } from "@/cluster/mode";
import { is_sole_worker } from "@/cluster/beat";
import { was_recent_lease_holder } from "@/services/sync/pending-suppress";

// ============================================================================
// Two-tier pending queue for missed WS messages (vital events)
//   Redis hash poll:user:{uid}:messages_v2 → 1 week TTL (refreshed per store)
//   PostgreSQL missed_ws_messages          → 30 days (daily cleanup job)
// RC-3 (§13.7 C1) removed the third, per-PROCESS LRU tier: at N>1 an entry
// drained on one worker was re-delivered from another worker's LRU copy.
// Redis is written synchronously by every store, so the LRU never held
// anything Redis did not.
//
// Deduplication — DETERMINISTIC correlation keys (see correlation_key):
// `{user_id}:{event_type}:{natural_id}`. Redis field and DB primary key.
//   • self-compaction — a re-broadcast of the same logical event (duplicate
//     re-ack after a client resend, LWW state like pin/user:update)
//     OVERWRITES its previous pending entry instead of piling up a new copy;
//   • targeted drain — the delivery-ack path computes the exact key a
//     message was stored under and deletes it.
//
// Versions + tombstones (RC-3 §13.7 C2/C3; pending-store-core.ts has the
// why): every store mints `v` (UUIDv7) inside the entry and into the DB row's
// entry_v; every drain is a compare-and-delete "stored v ≤ the v delivered"
// (acks that name a message use "any version"); a drain that may race a
// deferred DB write on ANOTHER worker leaves a short-lived tombstone that the
// writer checks before and after its insert.
// ============================================================================

type CachedPollMessage = PendingEntry;

// --- Constants ---
const DB_RETENTION_DAYS = 30;                 // 1 month
const MAX_MESSAGES_PER_USER = 500;            // cap per-user queue in Redis
const REDIS_TTL_SECONDS = 7 * 24 * 60 * 60;   // 1 week

const pending_redis = create_pending_redis(redis);

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

// Can a deferred DB write for an entry be pending on ANOTHER worker right
// now? Only then do drains leave tombstones and does the writer consult
// Redis (C3). `local` routing (default at N=1) = no: zero added Redis work,
// exactly today's path. `on` with no live sibling = no. `shadow` = yes, so
// the scripts run on prod at N=1 before anything depends on them.
const remote_writers_possible = (): boolean =>
  ROUTING_MODE !== "local" && !(presence_authoritative() && is_sole_worker());

// Tombstones expire per field on Redis ≥ 7.4 (HPEXPIRE). On an older Redis
// nothing but the 500-field cap trim removes them, and an online user's hash
// would collect one per message received; so there they are written only
// when a remote write is REAL (routing `on` with a live sibling), not in
// shadow. Learnt from the first drain that wrote one.
let field_ttl_ok = true;
const tombstones_wanted = (): boolean =>
  remote_writers_possible() && (field_ttl_ok || presence_authoritative());

// The DB tier: written ~10 s after the store unless an ack drains it first
// (pending-store-core create_deferred_writer has the rules).
const db_writer = create_deferred_writer({
  redis: pending_redis,
  upsert: (rows) => {
    // §3.13: DB writes for proto-2 lease holders should be ≈ 0 once their
    // derivable events are no longer stored (pending-suppress.ts); what is
    // left is the non-derivable residue. A recent-holder hint, no lookup.
    let v2 = 0;
    for (const r of rows) if (was_recent_lease_holder(r.user_id)) v2++;
    if (v2 > 0) count("POLL", "v2_undrained_db_writes", v2);
    return db_upsert_entries(pg_client, rows);
  },
  delete_exact: (items) => db_delete_exact(pg_client, items),
  guarded: remote_writers_possible,
  count: (name, n) => count("POLL", name, n),
  track,
});

// ============================================================================
// WRITE PATH — store a missed WS message
// ============================================================================

// --- trim a user's Redis hash back to cap (rare path) ---
// Tombstones past their window go first (on Redis < 7.4 nothing else expires
// them); then the oldest real entries beyond the cap. Trimmed entries keep
// their deferred DB write: the DB is then their only copy.
const trim_redis_queue = async (user_id: string): Promise<void> => {
  try {
    const key = redis_entries_key(user_id);
    const all = await redis.hgetall(key);
    const now = Date.now();
    const entries: [string, number][] = [];
    const to_delete: string[] = [];
    for (const [field, raw] of Object.entries(all)) {
      const parsed = parse_value(raw);
      if (!parsed) continue;
      if (parsed.kind === "tomb") {
        const t = uuid7_ms(parsed.v);
        if (t === undefined || now - t >= TOMBSTONE_WINDOW_MS) to_delete.push(field);
        continue;
      }
      entries.push([field, parsed.entry.created_at]);
    }
    if (entries.length > MAX_MESSAGES_PER_USER) {
      entries.sort((a, b) => a[1] - b[1]);
      for (const [field] of entries.slice(0, entries.length - MAX_MESSAGES_PER_USER)) to_delete.push(field);
    }
    if (to_delete.length > 0) {
      await redis.hdel(key, ...to_delete);
    }
  } catch (err) {
    console.error(`[POLL-CACHE] Redis trim error for user ${user_id}:`, err);
  }
};

async function store_pending_message(
  user_id: string,
  ws_message: VitalWSMessage,
): Promise<void> {
  await store_pending_message_for_users([user_id], ws_message);
}

// Store for multiple users at once — THE fan-out path (broadcast_message).
// One Redis pipeline covers the entire recipient list: hset + expire + hlen
// per user, single round trip. The DB write is queued locally (no I/O here).
async function store_pending_message_for_users(
  user_ids: string[],
  ws_message: VitalWSMessage,
): Promise<void> {
  if (user_ids.length === 0 || !is_allowed_event(ws_message.type)) return;
  // One copy per recipient, in Redis (noeviction) and missed_ws_messages:
  // inline thumbs (§14.7 item 5) stay out of it, the app takes them from
  // history / sync. Identity for every message without one.
  ws_message = strip_ws_thumbs(ws_message);

  const now = Date.now();
  // One version per store call: it only has to order versions of ONE field,
  // and every recipient's field is distinct.
  const v = randomUUIDv7();
  const pipeline = redis.pipeline();
  const users: string[] = [];
  const keys: string[] = [];

  for (const user_id of user_ids) {
    const entry: PendingEntry = {
      v,
      message_id: correlation_key(user_id, ws_message),
      ws_message,
      created_at: now,
    };
    users.push(user_id);
    keys.push(entry.message_id);
    db_writer.schedule(user_id, entry);

    const key = redis_entries_key(user_id);
    pipeline.hset(key, entry.message_id, encode_entry(entry));
    pipeline.expire(key, REDIS_TTL_SECONDS);
    pipeline.hlen(key);
  }

  try {
    const results = await pipeline.exec();
    // Per user: hset (1 = the field is new → its drain may skip the PG
    // DELETE, see mark_fresh), expire, hlen (trim the rare over-cap queues).
    for (let i = 0; i < users.length; i++) {
      const hset_result = results?.[i * 3];
      if (hset_result && !hset_result[0] && hset_result[1] === 1) {
        db_writer.mark_fresh(users[i], keys[i], v);
      }
      const hlen_result = results?.[i * 3 + 2];
      const hash_len = typeof hlen_result?.[1] === "number" ? hlen_result[1] : 0;
      if (hash_len > MAX_MESSAGES_PER_USER) {
        await trim_redis_queue(users[i]);
      }
    }
  } catch (err) {
    console.error(`[POLL-CACHE] Redis pipeline write error (${user_ids.length} users):`, err);
  }
  debug_log("PENDING", () =>
    `store type=${ws_message.type} id=${natural_event_id(ws_message) ?? "-"} users=${user_ids.length} v=${v}`,
  );
}

// ============================================================================
// READ PATH — fetch pending messages for a user (Redis ∪ DB)
//
// SYNC_V2 R0: both tiers are read on every poll and merged (a fallthrough
// let a non-empty upper tier shadow entries that existed only below it).
// RC-3: merged by key keeping the NEWEST version (v), not "Redis wins".
//
// SYNC_V2 R0.1 (field bug F2-1): no delete-on-read for message:new. Returned
// entries the client acks stay queued until the delivered ack drains them
// (re-sent with a growing hold meanwhile, expired 7 days after the FIRST
// return); every other type is still deleted once returned — compare-and-
// delete on the version returned, so a newer version stored meanwhile
// survives. See poll-ack-drain.utils for the rules and why.
// ============================================================================

// [POLL] cursor_would_drop counter (per process, since start).
let cursor_would_drop_total = 0;

// Of the message ids about to be RE-sent, the ones still live (not deleted,
// not expired). A re-send happens when an earlier response was lost; if that
// response also carried the message:delete (delete-on-read, gone now), a
// blind re-send would bring a deleted message back on the phone. Only runs
// when something is being re-sent (rare). null = lookup failed → keep all.
async function live_message_ids(ids: string[]): Promise<Set<string> | null> {
  const valid = ids.filter(is_uuid);
  if (valid.length === 0) return new Set();
  try {
    const rows = await db
      .select({ id: message_model.id })
      .from(message_model)
      .where(and(
        inArray(message_model.id, valid),
        isNull(message_model.deleted_at),
        or(isNull(message_model.expires_at), gt(message_model.expires_at, new Date())),
      ));
    // Lower-cased both sides: Postgres returns uuids lower-case, a client
    // may have minted its id upper-case, and a miss here DROPS the entry.
    return new Set(rows.map(r => r.id.toLowerCase()));
  } catch (err) {
    console.error(`[POLL-CACHE] live-message check failed (${valid.length} ids):`, err);
    return null;
  }
}

async function fetch_pending_messages(
  user_id: string,
  after_message_id?: string,
  for_sync: boolean = false,
): Promise<CachedPollMessage[]> {

  // Map<key, entry> for dedup across tiers, newest version per key.
  const messages = new Map<string, CachedPollMessage>();

  // Entries and return meta in ONE round trip. meta_ok=false (meta unread)
  // disables every meta write below: writing without having read would reset
  // first-return times, i.e. push expiry out.
  const redis_read = (async () => {
    const out: [string, CachedPollMessage][] = [];
    const meta = new Map<string, ReturnMeta>();
    let entries_ok = false;
    let meta_ok = false;
    try {
      const results = await redis
        .pipeline()
        .hgetall(redis_entries_key(user_id))
        .hgetall(redis_return_meta_key(user_id))
        .exec();
      const [entries_err, raw_hash] = results?.[0] ?? [new Error("no result"), null];
      const [meta_err, raw_meta] = results?.[1] ?? [new Error("no result"), null];
      if (entries_err) {
        console.error(`[POLL-CACHE] Redis read error for user ${user_id}:`, entries_err);
      } else {
        entries_ok = true;
        for (const [key, str] of Object.entries((raw_hash ?? {}) as Record<string, string>)) {
          const parsed = parse_value(str);
          if (parsed?.kind === "entry") out.push([key, parsed.entry]);
          else if (!parsed) console.error(`[POLL-CACHE] unparsable pending entry for user ${user_id} key=${key}`);
          // tombstones: drained, skip
        }
      }
      if (meta_err) {
        console.error(`[POLL-CACHE] Redis return-meta read error for user ${user_id}:`, meta_err);
      } else {
        meta_ok = true;
        for (const [key, raw] of Object.entries((raw_meta ?? {}) as Record<string, string>)) {
          const m = parse_return_meta(raw);
          if (m) meta.set(key, m);
        }
      }
    } catch (err) {
      console.error(`[POLL-CACHE] Redis read error for user ${user_id}:`, err);
    }
    return { out, meta, entries_ok, meta_ok };
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
          v: row.entry_v ?? "",
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

  const [redis_res, db_entries] = await Promise.all([redis_read, db_read]);
  const { meta, meta_ok } = redis_res;

  // DB first, then Redis: on equal versions (both legacy "") Redis wins, as
  // before; otherwise the newer version wins whichever tier holds it.
  for (const [id, msg] of db_entries) messages.set(id, msg);
  for (const [id, msg] of redis_res.out) {
    const prev = messages.get(id);
    messages.set(id, prev ? newer_pending_entry(prev, msg) : msg);
  }

  // Replay order: created_at, with conversation:new first on a same-ms tie
  // (see pending-order.utils — e.g. a new DM's conversation:new and its first
  // message:new).
  const sorted = sort_pending_for_replay(Array.from(messages.values()));

  const now = Date.now();
  const classified = classify_pending_read(user_id, sorted, meta, now, for_sync);

  // Re-sends whose message was deleted / expired meanwhile are dropped for
  // good instead of re-sent (see live_message_ids).
  let candidates = classified.candidates;
  const dead_keys: string[] = [];
  if (classified.resend_keys.size > 0) {
    const resend_ids = candidates
      .filter(e => classified.resend_keys.has(e.message_id))
      .map(e => message_id_of(e))
      .filter((id): id is string => !!id);
    const live = await live_message_ids(resend_ids);
    if (live) {
      candidates = candidates.filter(e => {
        if (!classified.resend_keys.has(e.message_id)) return true;
        const id = message_id_of(e);
        if (!id || !is_uuid(id) || live.has(id.toLowerCase())) return true;
        dead_keys.push(e.message_id);
        return false;
      });
    }
  }

  // Cap one response at MAX_MESSAGES_PER_USER, oldest first: the tier union
  // can reach ~1000 entries, and a big response is the one most likely to be
  // lost mid-transfer on flaky Wi-Fi. The rest stays queued for the next poll.
  const plan = finalize_pending_read(user_id, candidates, meta, MAX_MESSAGES_PER_USER, now);
  const result = plan.result;
  if (result.length < candidates.length) {
    console.log(
      `[POLL] capped user=${user_id} returned=${result.length} remaining=${candidates.length - result.length}`,
    );
  }

  if (plan.resent > 0) count("POLL", "resend_unacked", plan.resent);
  if (classified.held > 0) count("POLL", "held_unacked", classified.held);
  if (dead_keys.length > 0) count("POLL", "dropped_deleted", dead_keys.length);
  if (classified.expired_keys.length > 0) {
    count("POLL", "expired_unacked", classified.expired_keys.length);
    // Rare and the one way this path still drops a message: always logged.
    console.warn(
      `[POLL] expired_unacked user=${user_id} n=${classified.expired_keys.length}`,
    );
  }
  debug_log("PENDING", () =>
    `read user=${user_id} union=${sorted.length} returned=${result.length} ` +
    `deleted_on_read=${plan.delete_keys.length} resent=${plan.resent} held=${classified.held} ` +
    `expired=${classified.expired_keys.length} dead=${dead_keys.length}`,
  );

  // Writes, in parallel, all awaited before the response so a second poll
  // racing this one (reconnect sync GET + first _poll fire within ~1 s) sees
  // the return marks and holds instead of re-sending.
  //   - delete-on-read types that were returned, plus expired / dead
  //     ack-drained entries: compare-and-delete on the version read here;
  //   - return marks for the ack-drained entries returned now, and cleanup
  //     of marks whose entry is gone.
  const to_remove: DrainItem[] = [...plan.delete_keys, ...classified.expired_keys, ...dead_keys]
    .map((key) => ({ key, v: messages.get(key)?.v ?? "" }));
  const writes: Promise<unknown>[] = [drain_pending(user_id, to_remove)];
  if (meta_ok && redis_res.entries_ok) {
    const stale = stale_meta_keys(meta, new Set(messages.keys()));
    if (plan.meta_updates.size > 0 || stale.length > 0) {
      const key = redis_return_meta_key(user_id);
      const pipe = redis.pipeline();
      if (plan.meta_updates.size > 0) {
        const fields: Record<string, string> = {};
        for (const [k, m] of plan.meta_updates) fields[k] = format_return_meta(m);
        pipe.hset(key, fields);
        pipe.expire(key, RETURN_META_TTL_SECONDS);
      }
      if (stale.length > 0) pipe.hdel(key, ...stale);
      writes.push(
        pipe.exec().catch(err =>
          console.error(`[POLL-CACHE] Redis return-meta write error for user ${user_id}:`, err),
        ),
      );
    }
  }
  await Promise.all(writes);

  // Cursor (after_message_id): NO slicing (SYNC_V2 R0). Slicing "after the
  // cursor" dropped the entries at/before it for good (they had just been
  // deleted). The cursor entry can only still be in the queue because it was
  // RE-STORED after the client saw it (a self-compacting key such as
  // message:pin / message:react / user:update overwritten with a newer state,
  // a sibling worker's deferred DB write) or, since R0.1, because it is an
  // un-acked message:new being re-sent — so it and the entries sorted before
  // it are new to the client or harmless repeats. Return them all; client
  // handlers are idempotent per id. Counted so the old loss is visible (a
  // re-sent cursor entry did not exist under delete-on-read: not counted).
  if (after_message_id && !classified.resend_keys.has(after_message_id)) {
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

// ============================================================================
// POLL V2 (R3) — the Redis tier read and the return marks
// ============================================================================
// Poll v2 reads the DB tier inside its single statement (poll-queries.ts)
// and plans the response itself (poll-core plan_pending_v2); these are its
// Redis halves. Nothing here deletes: v2 never deletes on read, its acks and
// expiries go through drain_pending with explicit versions.

type PendingRedisRead = {
  entries: PendingEntry[];
  meta: Map<string, ReturnMeta>;
  entries_ok: boolean;
  meta_ok: boolean;
};

// Entries (tombstones skipped) and return marks, ONE round trip.
async function read_pending_redis(user_id: string): Promise<PendingRedisRead> {
  const out: PendingRedisRead = { entries: [], meta: new Map(), entries_ok: false, meta_ok: false };
  try {
    const results = await redis
      .pipeline()
      .hgetall(redis_entries_key(user_id))
      .hgetall(redis_return_meta_key(user_id))
      .exec();
    const [entries_err, raw_hash] = results?.[0] ?? [new Error("no result"), null];
    const [meta_err, raw_meta] = results?.[1] ?? [new Error("no result"), null];
    if (!entries_err) {
      out.entries_ok = true;
      for (const [key, str] of Object.entries((raw_hash ?? {}) as Record<string, string>)) {
        const parsed = parse_value(str);
        if (parsed?.kind === "entry") out.entries.push({ ...parsed.entry, message_id: key });
        else if (!parsed) console.error(`[POLL-CACHE] unparsable pending entry for user ${user_id} key=${key}`);
      }
    } else {
      console.error(`[POLL-CACHE] Redis read error for user ${user_id}:`, entries_err);
    }
    if (!meta_err) {
      out.meta_ok = true;
      for (const [key, raw] of Object.entries((raw_meta ?? {}) as Record<string, string>)) {
        const m = parse_return_meta(raw);
        if (m) out.meta.set(key, m);
      }
    }
  } catch (err) {
    console.error(`[POLL-CACHE] Redis read error for user ${user_id}:`, err);
  }
  return out;
}

// Record what a v2 response handed out (holds / expiry, F's ret_v1 hash with
// the returned version) and prune marks whose entry is gone. One pipeline;
// awaited by the caller before it answers, so the client's very next request
// already sees the holds. Never throws.
async function write_return_meta(
  user_id: string,
  updates: Map<string, ReturnMeta>,
  stale: string[],
): Promise<void> {
  if (updates.size === 0 && stale.length === 0) return;
  const key = redis_return_meta_key(user_id);
  const pipe = redis.pipeline();
  if (updates.size > 0) {
    const fields: Record<string, string> = {};
    for (const [k, m] of updates) fields[k] = format_return_meta(m);
    pipe.hset(key, fields);
    pipe.expire(key, RETURN_META_TTL_SECONDS);
  }
  if (stale.length > 0) pipe.hdel(key, ...stale);
  try {
    await pipe.exec();
  } catch (err) {
    console.error(`[POLL-CACHE] Redis return-meta write error for user ${user_id}:`, err);
  }
}

// ============================================================================
// DRAIN — compare-and-delete from every tier (RC-3 C2/C3)
// ============================================================================
// THE removal path: the poll read (delete-on-read types, expired / dead
// entries; with the version it read), drain-on-ack (handle_message_status_ack
// / mark_message_delivered; any version — the ack names a message, and every
// version of a message:new / sent:ack key is the same message) and, from R3,
// the poll v2 ack {key, v}. Keys that don't exist miss harmlessly.
//
//   1. local deferred writes: a queued one for a drained version is
//      cancelled; one being written right now is marked, and its writer
//      deletes its own row after the insert;
//   2. Redis: PENDING_DRAIN (+ the return marks), tombstones only while a
//      write on another worker is possible;
//   3. Postgres: delete rows whose version is ≤ the drained one. Skipped
//      when every item was a message:new / sent:ack whose FIRST version
//      (the store created the Redis field) was still queued here: no
//      version of that key was ever written to the DB. A re-store over an
//      older version keeps the DELETE (a flushed 500 sent-ack refusal must
//      not outlive the retry's success). That skip is what keeps an online
//      recipient's ack free of a DELETE on RDS.
// Never throws.
// Drain listeners: every drained key, as it is drained, synchronously (the
// FCM ack fallback cancels its deadline for `{uid}:message:new:{id}` — every
// delivered / read ack path ends here). A listener must be cheap and must
// not throw into the drain.
type DrainListener = (user_id: string, keys: string[]) => void;
const drain_listeners: DrainListener[] = [];
function on_pending_drain(fn: DrainListener): () => void {
  drain_listeners.push(fn);
  return () => {
    const i = drain_listeners.indexOf(fn);
    if (i >= 0) drain_listeners.splice(i, 1);
  };
}

async function drain_pending(user_id: string, items: DrainItem[]): Promise<void> {
  if (items.length === 0) return;
  debug_log("PENDING", () => `drain user=${user_id} n=${items.length}`);
  if (drain_listeners.length > 0) {
    const keys = items.map((i) => i.key);
    for (const fn of drain_listeners) {
      try {
        fn(user_id, keys);
      } catch (err) {
        console.error("[POLL-CACHE] drain listener failed:", err);
      }
    }
  }

  const pg_unneeded = db_writer.note_drain(user_id, items);

  const tomb = tombstones_wanted();
  const redis_p = pending_redis
    .drain([{ user_id, items, tomb }])
    .then(({ drained: [n], field_ttl_refused }) => {
      if (field_ttl_refused && field_ttl_ok) {
        field_ttl_ok = false;
        console.warn("[POLL-CACHE] Redis refused HPEXPIRE (< 7.4): tombstones only with live siblings in routing mode `on`");
      }
      if (n < 0) throw new Error("drain script failed");
    })
    .catch((err) => console.error(`[POLL-CACHE] Redis drain error for user ${user_id}:`, err));

  let db_p: Promise<unknown> = Promise.resolve();
  if (pg_unneeded) {
    count("POLL", "drain_pg_skipped");
  } else {
    // With tombstones (a remote deferred write may race us) the PG DELETE
    // goes out only after the tombstone is in Redis: a writer whose
    // post-insert re-check missed the tombstone then read Redis before it
    // existed, so its insert committed before our DELETE runs, and the
    // DELETE removes it. Sent in parallel, our DELETE could reach RDS
    // before its INSERT committed AND our tombstone land after its re-check:
    // the row would survive and be re-delivered. One extra Redis RTT, in
    // guarded mode only (never in `local`).
    if (tomb) await redis_p;
    db_p = db_delete_versions(pg_client, user_id, items).catch((err) =>
      console.error(`[POLL-CACHE] DB drain error for user ${user_id}:`, err),
    );
  }
  await Promise.all([redis_p, db_p]);
}

// Drain by key, any version — the pre-RC-3 API, kept for the ack paths
// (message-status.service, socket.service).
async function remove_pending_messages_batch(user_id: string, message_ids: string[]): Promise<void> {
  await drain_pending(user_id, message_ids.map((key) => ({ key })));
}

async function remove_pending_message(user_id: string, message_id: string): Promise<void> {
  await drain_pending(user_id, [{ key: message_id }]);
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

// Drain (SYNC_V2 §13.9.3, §13.7 C3): drop the deferred DB writes that have
// not been flushed and stop queueing new ones. Returns how many were dropped
// (also counted as [POLL] db_writes_dropped). The entries stay in Redis
// (7-day TTL), so the poll / reconnect replay still finds them — only the
// 30-day DB backstop copy is skipped. Writing them early instead would race
// the recipients' ack drains. A flush already running finishes (tracked).
function drop_pending_db_timers(): number {
  return db_writer.drop();
}

// Stops asking; a run already in flight is awaited by the drain via track()
// and itself stops between batches once draining.
function stop_cleanup_cron() {
  if (cleanup_interval) {
    clearInterval(cleanup_interval);
    cleanup_interval = null;
  }
}

// Diagnostics for the admin / debug paths.
function pending_db_write_stats() {
  return db_writer.stats();
}

function log_current_cache_state(user_id: string) {
  redis.hlen(redis_entries_key(user_id)).then(count => {
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
  read_pending_redis,
  write_return_meta,
  drain_pending,
  on_pending_drain,
  remove_pending_message,
  remove_pending_messages_batch,
  cleanup_expired_messages,
  start_cleanup_cron,
  stop_cleanup_cron,
  drop_pending_db_timers,
  pending_db_write_stats,
  is_allowed_event,
  log_current_cache_state,
  type CachedPollMessage,
};
export type { DrainItem, PendingEntry, PendingRedisRead };
