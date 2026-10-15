import type Redis from "ioredis";
import type postgres from "postgres";
import type { VitalWSMessage } from "@/types/socket.types";

// =============================================================================
// Pending store: versioned entries, compare-and-delete, ack tombstones
// (SYNC_V2 §13.7 C2 / C3, the Redis side of §3.11.2 pulled forward)
// =============================================================================
// Pure: no config import, so tests run the real Lua against an ephemeral
// redis-server and the PGlite harness runs the real SQL. polling.cache.ts
// binds it to the app's connections.
//
// Why versions. Entries live under DETERMINISTIC keys (polling.cache
// correlation_key): a self-compacting event (pin, react, user:update, …)
// re-stored for the same user OVERWRITES its field. Draining by field alone
// (HDEL key) therefore had a lost-update race: a poll that read version 1,
// then deleted "the key", also deleted a version 2 written in between, which
// the client never saw. Each store now mints `v` (UUIDv7, time-ordered, so
// string order = store order) and every drain deletes only versions the
// reader actually had: "stored v ≤ the v I delivered".
//
// Why tombstones. The DB tier is written ~10 s after the store (so entries
// acked quickly never reach Postgres). At N>1 that deferred write can sit on
// ANOTHER worker than the drain: worker A schedules it, the recipient's ack
// lands on worker B, B deletes Redis + PG (nothing in PG yet), then A's write
// resurrects the entry in PG and the next poll re-delivers it. A drain that
// may race a remote write therefore leaves `~{v}` in the entry's field
// instead of deleting it, and the deferred writer checks the field before
// inserting (and again after, deleting its own row if a tombstone appeared
// meanwhile). The tombstone shares the entry's key, so every script here is
// SINGLE-key (shard-safe, V15) and the existing key names are unchanged.
//
// Field value forms in `poll:user:{uid}:messages_v2` (field = correlation key):
//   entry   {"v":"<uuidv7>","message_id":…,"ws_message":…,"created_at":…}
//           v is FIRST so Lua reads it with one anchored match, no JSON parse
//   legacy  the same JSON without "v" (written by builds before RC-3) → v ""
//   tomb    "~<v>"  — drained version v; readers skip it, a store overwrites it

type PendingEntry = {
  v: string; // "" for a legacy entry (no version)
  message_id: string; // the correlation key (historical name)
  ws_message: VitalWSMessage;
  created_at: number; // epoch ms of the store
};

// Drain item: delete the field when its stored version is ≤ `v`
// (string order). `v` omitted / ANY_VERSION = whatever version is stored —
// the legacy delivered acks, which name a message, not a version.
type DrainItem = { key: string; v?: string };

const ANY_VERSION = "*";
const TOMB_PREFIX = "~";

// A tombstone is needed only while a deferred DB write for that version can
// still be pending somewhere: DB_WRITE_DELAY (10 s) + flush slack. Older
// entries are simply deleted. Also the field TTL where Redis supports
// per-field expiry (≥ 7.4); elsewhere the cap trim prunes them.
const TOMBSTONE_WINDOW_MS = 120_000;

// ---- entry codec --------------------------------------------------------------

const encode_entry = (e: PendingEntry): string =>
  // Key order matters (Lua anchors on `{"v":"`): build the object v-first.
  JSON.stringify({ v: e.v, message_id: e.message_id, ws_message: e.ws_message, created_at: e.created_at });

type ParsedValue = { kind: "entry"; entry: PendingEntry } | { kind: "tomb"; v: string };

const parse_value = (raw: string | null | undefined): ParsedValue | null => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith(TOMB_PREFIX)) return { kind: "tomb", v: raw.slice(TOMB_PREFIX.length) };
  try {
    const o = JSON.parse(raw) as Partial<PendingEntry> & Record<string, unknown>;
    if (!o || typeof o !== "object" || !o.ws_message || typeof o.message_id !== "string") return null;
    return {
      kind: "entry",
      entry: {
        v: typeof o.v === "string" ? o.v : "",
        message_id: o.message_id,
        ws_message: o.ws_message as VitalWSMessage,
        created_at: typeof o.created_at === "number" ? o.created_at : Number(o.created_at) || 0,
      },
    };
  } catch {
    return null;
  }
};

// The store time encoded in a UUIDv7 (first 48 bits, ms). undefined for "" /
// anything that is not one.
const uuid7_ms = (v: string): number | undefined => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(v)) return undefined;
  const ms = parseInt(v.slice(0, 8) + v.slice(9, 13), 16);
  return Number.isFinite(ms) ? ms : undefined;
};

// ---- Lua ----------------------------------------------------------------------

// Shared helper: the version of a field value; nil for a tombstone.
const LUA_VER = `
local function ver(raw)
  if string.sub(raw, 1, 1) == '~' then return nil end
  return string.match(raw, '^{"v":"([^"]*)"') or ''
end
`;

// PENDING_DRAIN  KEYS[1]=poll:user:{uid}:messages_v2
// ARGV[1]=now ms  ARGV[2]=tombstone window ms
// ARGV[3..] = triples (field, want "*"|v, tomb "1"|"0")
// Deletes each field whose stored version is ≤ want ("*" = any). With tomb
// "1" and a version younger than the window, leaves "~v" instead (C3), with a
// best-effort field TTL (pcall: HPEXPIRE is unknown before Redis 7.4 and must
// not fail the script). Returns {drained, 1 if a field TTL was refused}.
const LUA_PENDING_DRAIN = `${LUA_VER}
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local n = 0
local no_ttl = 0
for i = 3, #ARGV, 3 do
  local f, want, tomb = ARGV[i], ARGV[i + 1], ARGV[i + 2]
  local cur = redis.call('HGET', KEYS[1], f)
  if cur then
    local v = ver(cur)
    if v and (want == '*' or v <= want) then
      local t = nil
      if tomb == '1' and string.match(v, '^%x%x%x%x%x%x%x%x%-%x%x%x%x%-7') then
        t = tonumber(string.sub(v, 1, 8) .. string.sub(v, 10, 13), 16)
      end
      if t and now - t < win then
        redis.call('HSET', KEYS[1], f, '~' .. v)
        local r = redis.pcall('HPEXPIRE', KEYS[1], win, 'FIELDS', 1, f)
        if type(r) == 'table' and r.err then no_ttl = 1 end
      else
        redis.call('HDEL', KEYS[1], f)
      end
      n = n + 1
    end
  end
end
return {n, no_ttl}
`;

// PENDING_DB_GUARD  KEYS[1]=poll:user:{uid}:messages_v2
// ARGV = pairs (field, my v). Per pair 1 = "my version may be in PG", 0 =
// "do not insert / delete my row": a tombstone at or past my version (it was
// drained), or a NEWER entry (its own deferred write carries it). 2 = the
// field is MISSING: allowed for a young write (the per-user cap trim drops
// entries from Redis on purpose and the DB copy is then the only one left),
// but not for one older than the tombstone window (the writer decides,
// create_deferred_writer: its tombstone may have expired meanwhile).
// The same script is the pre-insert check and the post-insert re-check.
const LUA_PENDING_DB_GUARD = `${LUA_VER}
local out = {}
for i = 1, #ARGV, 2 do
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  local ok = 2
  if cur then
    ok = 1
    local v = ver(cur)
    if v == nil then
      if string.sub(cur, 2) >= ARGV[i + 1] then ok = 0 end
    elseif v > ARGV[i + 1] then
      ok = 0
    end
  end
  out[#out + 1] = ok
end
return out
`;

const SCRIPTS = {
  amigo_pending_drain: { numberOfKeys: 1, lua: LUA_PENDING_DRAIN },
  amigo_pending_db_guard: { numberOfKeys: 1, lua: LUA_PENDING_DB_GUARD },
} as const;

type ScriptClient = Record<string, (...args: (string | number)[]) => Promise<unknown>>;
type PipelineResult = [Error | null, unknown][] | null;

const redis_entries_key = (user_id: string) => `poll:user:${user_id}:messages_v2`;
const redis_return_meta_key = (user_id: string) => `poll:user:${user_id}:ret_v1`;

type DrainBatch = { user_id: string; items: DrainItem[]; tomb: boolean };
type GuardBatch = { user_id: string; items: { key: string; v: string }[] };

/**
 * The Redis half of the pending store, bound to one ioredis connection.
 * Each call is ONE round trip (a pipeline); every script touches one key.
 */
const create_pending_redis = (client: Redis, now: () => number = Date.now) => {
  for (const [name, def] of Object.entries(SCRIPTS)) {
    if (typeof (client as unknown as ScriptClient)[name] !== "function") client.defineCommand(name, def);
  }

  // Drain items for several users. The return marks (ret_v1) go with their
  // entries in the same pipeline, unconditionally: they exist only for
  // message:new, whose versions are the same message. Returns the drained
  // count per batch (-1 where that user's script failed) and whether Redis
  // refused a per-field TTL (< 7.4: tombstones then live until the cap trim).
  const drain = async (batches: DrainBatch[]): Promise<{ drained: number[]; field_ttl_refused: boolean }> => {
    const work = batches.filter((b) => b.items.length > 0);
    if (work.length === 0) return { drained: batches.map(() => 0), field_ttl_refused: false };
    const p = client.pipeline() as unknown as ScriptClient & {
      hdel: (key: string, ...f: string[]) => unknown;
      exec: () => Promise<PipelineResult>;
    };
    const t = now();
    for (const b of work) {
      const argv: (string | number)[] = [t, TOMBSTONE_WINDOW_MS];
      for (const it of b.items) argv.push(it.key, it.v ?? ANY_VERSION, b.tomb ? "1" : "0");
      p.amigo_pending_drain(redis_entries_key(b.user_id), ...argv);
      p.hdel(redis_return_meta_key(b.user_id), ...b.items.map((it) => it.key));
    }
    const res = await p.exec();
    if (!res) throw new Error("pending drain: pipeline returned no result");
    const per = new Map<DrainBatch, number>();
    let field_ttl_refused = false;
    work.forEach((b, i) => {
      const [err, val] = res[i * 2] ?? [new Error("missing"), null];
      if (err || !Array.isArray(val)) {
        per.set(b, -1);
        return;
      }
      per.set(b, Number(val[0]) || 0);
      if (Number(val[1]) === 1) field_ttl_refused = true;
    });
    return { drained: batches.map((b) => per.get(b) ?? 0), field_ttl_refused };
  };

  // Pre-insert check / post-insert re-check for the deferred DB writer.
  // Aligned with the input: allowed[i][j] for batches[i].items[j] (missing
  // fields count as allowed; `missing` flags them); a user whose script
  // failed reads as all-allowed, none missing (fail open = today's insert).
  const guard = async (batches: GuardBatch[]): Promise<{ allowed: boolean[][]; missing: boolean[][]; failed: number }> => {
    const p = client.pipeline() as unknown as ScriptClient & { exec: () => Promise<PipelineResult> };
    for (const b of batches) {
      const argv: string[] = [];
      for (const it of b.items) argv.push(it.key, it.v);
      p.amigo_pending_db_guard(redis_entries_key(b.user_id), ...argv);
    }
    const res = batches.length > 0 ? await p.exec() : [];
    if (!res) throw new Error("pending guard: pipeline returned no result");
    let failed = 0;
    const missing: boolean[][] = [];
    const allowed = batches.map((b, i) => {
      const [err, val] = res[i] ?? [new Error("missing"), null];
      if (err || !Array.isArray(val)) {
        failed++;
        missing.push(b.items.map(() => false));
        return b.items.map(() => true);
      }
      missing.push(b.items.map((_, j) => Number(val[j]) === 2));
      return b.items.map((_, j) => Number(val[j]) !== 0);
    });
    return { allowed, missing, failed };
  };

  return { drain, guard };
};

type PendingRedis = ReturnType<typeof create_pending_redis>;

// ---- SQL (postgres-js; the app's drizzle-patched pg_client or a plain one) ----
// JSON goes as ::text::jsonb and versions compare with COLLATE "C" (byte
// order = UUIDv7 time order whatever the database collation is).

type DbRow = { id: string; user_id: string; event_type: string; ws_message: unknown; entry_v: string; created_at: number };

/**
 * Deferred DB write: one multi-row upsert. A row is only ever replaced by a
 * NEWER version, so two deferred writes of one key landing out of order
 * (two workers, or a slow first one) can never put the older one back.
 * Rows whose user no longer exists are skipped (FK) instead of failing the
 * whole statement. Returns the ids written.
 */
const db_upsert_entries = async (sql: postgres.Sql<{}> | postgres.TransactionSql<{}>, rows: DbRow[]): Promise<string[]> => {
  if (rows.length === 0) return [];
  const payload = JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      event_type: r.event_type,
      ws_message: r.ws_message,
      entry_v: r.entry_v,
      created_at: new Date(r.created_at).toISOString(),
    })),
  );
  const out = await sql<{ id: string }[]>`
    INSERT INTO missed_ws_messages AS m (id, user_id, event_type, ws_message, entry_v, created_at)
    SELECT r.id, r.user_id, r.event_type, r.ws_message, r.entry_v, r.created_at
      FROM jsonb_to_recordset(${payload}::text::jsonb)
           AS r(id text, user_id uuid, event_type varchar, ws_message jsonb, entry_v text, created_at timestamptz)
      JOIN users u ON u.id = r.user_id
    ON CONFLICT (id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           event_type = EXCLUDED.event_type,
           ws_message = EXCLUDED.ws_message,
           entry_v = EXCLUDED.entry_v
     WHERE m.entry_v IS NULL OR m.entry_v COLLATE "C" < EXCLUDED.entry_v COLLATE "C"
    RETURNING m.id`;
  return out.map((r) => r.id);
};

/**
 * The PG half of a drain: delete rows whose version is ≤ the drained one
 * (NULL = a row from an older build = oldest), or any version for "*".
 */
const db_delete_versions = async (sql: postgres.Sql<{}> | postgres.TransactionSql<{}>, user_id: string, items: DrainItem[]): Promise<number> => {
  if (items.length === 0) return 0;
  const ids = items.map((i) => i.key);
  const vs = items.map((i) => i.v ?? ANY_VERSION);
  const out = await sql`
    DELETE FROM missed_ws_messages m
     USING unnest(${sql.array(ids)}::text[], ${sql.array(vs)}::text[]) AS d(id, v)
     WHERE m.id = d.id AND m.user_id = ${user_id}::uuid
       AND (d.v = '*' OR m.entry_v IS NULL OR m.entry_v COLLATE "C" <= d.v COLLATE "C")`;
  return out.count;
};

/** Post-insert compensation: delete exactly the versions this writer inserted. */
const db_delete_exact = async (sql: postgres.Sql<{}> | postgres.TransactionSql<{}>, items: { id: string; v: string }[]): Promise<number> => {
  if (items.length === 0) return 0;
  const out = await sql`
    DELETE FROM missed_ws_messages m
     USING unnest(${sql.array(items.map((i) => i.id))}::text[], ${sql.array(items.map((i) => i.v))}::text[]) AS d(id, v)
     WHERE m.id = d.id AND m.entry_v = d.v`;
  return out.count;
};

// ---- deferred DB writer (C3) ---------------------------------------------------
// The DB tier is written DB_WRITE_DELAY_MS after the store, so an ack within
// that window cancels it and recipients that are online never touch
// Postgres. Queued per process; one flush writes every due entry in ONE
// multi-row upsert (it used to be one timer and one INSERT per recipient: a
// 150-member group message = 150 statements on RDS). Lost on a crash, dropped
// and counted on a drain: the entry is still in Redis for 7 days, only the
// 30-day DB copy is skipped.
//
// When a write may race a drain on ANOTHER worker (`guarded()`), the flush
// asks Redis first (PENDING_DB_GUARD: tombstone / newer version → skip) and
// again after the insert (a tombstone that appeared meanwhile → delete
// exactly the version it wrote). Drains on THIS worker need no Redis: they
// cancel the queued write, or mark the one being written so the flush
// deletes its row afterwards.

type WriterDeps = {
  redis: Pick<PendingRedis, "guard">;
  upsert: (rows: DbRow[]) => Promise<string[]>;
  delete_exact: (items: { id: string; v: string }[]) => Promise<number>;
  // Can a drain on another worker race this write right now?
  guarded: () => boolean;
  count?: (name: string, n?: number) => void;
  log_error?: (msg: string) => void;
  // Drain-aware tracking (lifecycle.track) of a flush in flight.
  track?: <T>(p: Promise<T>) => Promise<T>;
  delay_ms?: number;
  max_rows?: number;
  now?: () => number;
  // false in tests: flushes run only when flush_due() is called.
  auto?: boolean;
};

// fresh: the store's HSET created the field (no earlier version of this key
// existed in Redis, hence none can be in Postgres either). Set by
// mark_fresh() once the store pipeline returns; unknown = not fresh.
type QueuedWrite = { user_id: string; entry: PendingEntry; due: number; drained?: boolean; fresh?: boolean };

const DB_WRITE_DELAY_MS = 10_000;
const DB_FLUSH_MAX_ROWS = 500;
// A guarded write this old (store → now) treats a MISSING field as drained,
// not trimmed: a drain's tombstone lives TOMBSTONE_WINDOW_MS from the store,
// so after a writer stall that long a drained entry looks exactly like a
// trimmed one, and writing it would resurrect an old LWW state (pin,
// user:update, …) in PG. Trimmed entries lose only their DB copy, and only
// after such a stall. Margin: the guard / insert round trips.
const STALE_WRITE_MS = TOMBSTONE_WINDOW_MS - 10_000;

// Keys that are normally stored once (a message id, its sent-ack), so a drain
// that cancels the queued write usually leaves nothing in Postgres. NOT
// "every version is the same": a sent-ack key can first hold a refusal
// (is_sent:false, flushed after 10 s) and later the success of the GC retry,
// so the PG skip also needs the cancelled write to be `fresh`.
const is_immutable_key = (key: string): boolean =>
  key.includes(":message:new:") || key.includes(":message:sent:ack:");

// "stored version ≤ wanted" (undefined / "*" = any).
const version_le = (stored: string, want: string | undefined): boolean =>
  want === undefined || want === ANY_VERSION || stored <= want;

const create_deferred_writer = (deps: WriterDeps) => {
  const delay_ms = deps.delay_ms ?? DB_WRITE_DELAY_MS;
  const max_rows = deps.max_rows ?? DB_FLUSH_MAX_ROWS;
  const now = deps.now ?? Date.now;
  const count = deps.count ?? (() => { });
  const log_error = deps.log_error ?? ((m: string) => console.error(m));
  const track = deps.track ?? (<T>(p: Promise<T>) => p);
  const auto = deps.auto ?? true;

  // tk = "user_id\u0000key". Insertion order = due order (constant delay; a
  // re-store deletes and re-inserts, i.e. moves to the end with a new due).
  const queue = new Map<string, QueuedWrite>();
  // The batch currently being written (single-flight).
  const inflight = new Map<string, QueuedWrite>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  const tk_of = (user_id: string, key: string) => `${user_id}\u0000${key}`;

  const arm = (): void => {
    if (!auto || stopped || timer || running || queue.size === 0) return;
    const first = queue.values().next().value as QueuedWrite;
    timer = setTimeout(() => {
      timer = null;
      void flush_due();
    }, Math.max(0, first.due - now()));
  };

  const schedule = (user_id: string, entry: PendingEntry): void => {
    if (stopped) return;
    const tk = tk_of(user_id, entry.message_id);
    queue.delete(tk);
    queue.set(tk, { user_id, entry, due: now() + delay_ms });
    arm();
  };

  // The store's HSET created the field (reply 1): the queued write for
  // version v is the key's first version anywhere. A re-store over an older
  // version (or a tombstone) stays un-fresh, so its drain still deletes in
  // PG: the older version may have been flushed already, by this worker or
  // a sibling (a 500 sent-ack refusal before the retry's success).
  const mark_fresh = (user_id: string, key: string, v: string): void => {
    const q = queue.get(tk_of(user_id, key));
    if (q && q.entry.v === v) q.fresh = true;
  };

  // Local half of a drain. Returns true when Postgres cannot hold a copy
  // this drain must delete: every item was an immutable key whose FRESH
  // write was still queued here (no version of it was ever flushed).
  const note_drain = (user_id: string, items: DrainItem[]): boolean => {
    let pg_unneeded = items.length > 0;
    for (const it of items) {
      const tk = tk_of(user_id, it.key);
      const q = queue.get(tk);
      let cancelled_fresh = false;
      if (q && version_le(q.entry.v, it.v)) {
        queue.delete(tk);
        cancelled_fresh = q.fresh === true;
      }
      const f = inflight.get(tk);
      if (f && version_le(f.entry.v, it.v)) f.drained = true;
      if (!(cancelled_fresh && !f && is_immutable_key(it.key))) pg_unneeded = false;
    }
    return pg_unneeded;
  };

  const by_user = (ws: QueuedWrite[]) => {
    const m = new Map<string, QueuedWrite[]>();
    for (const w of ws) {
      const l = m.get(w.user_id);
      if (l) l.push(w);
      else m.set(w.user_id, [w]);
    }
    return Array.from(m.entries());
  };

  // Fails open (null): an unreachable Redis is exactly when the DB backstop
  // matters, so every write goes ahead.
  const ask_redis = async (ws: QueuedWrite[], phase: string): Promise<Set<QueuedWrite> | null> => {
    const groups = by_user(ws);
    try {
      const { allowed, missing, failed } = await deps.redis.guard(
        groups.map(([user_id, l]) => ({ user_id, items: l.map((w) => ({ key: w.entry.message_id, v: w.entry.v })) })),
      );
      if (failed > 0) count("db_guard_failed", failed);
      const out = new Set<QueuedWrite>();
      const t = now();
      let stale = 0;
      groups.forEach(([, l], i) => l.forEach((w, j) => {
        if (allowed[i]?.[j] === false) return;
        if (missing?.[i]?.[j] === true && t - w.entry.created_at >= STALE_WRITE_MS) {
          stale++;
          return;
        }
        out.add(w);
      }));
      if (stale > 0) count("db_write_skipped_stale", stale);
      return out;
    } catch (err: any) {
      count("db_guard_failed");
      log_error(`[POLL-CACHE] ${phase}-insert guard failed (${ws.length} entries): ${err?.message ?? err}`);
      return null;
    }
  };

  const write = async (batch: QueuedWrite[]): Promise<void> => {
    const guarded = deps.guarded();
    let todo = batch;
    if (guarded) {
      const ok = await ask_redis(batch, "pre");
      if (ok) {
        if (ok.size < batch.length) count("db_write_skipped_tomb", batch.length - ok.size);
        todo = batch.filter((w) => ok.has(w));
      }
    }
    // Drained while the guard ran: nothing to write.
    todo = todo.filter((w) => !w.drained);
    if (todo.length === 0) return;

    const by_id = new Map<string, QueuedWrite>();
    for (const w of todo) by_id.set(w.entry.message_id, w); // the key embeds the uid: unique
    let written: QueuedWrite[];
    try {
      const ids = await deps.upsert(Array.from(by_id.values(), (w) => ({
        id: w.entry.message_id,
        user_id: w.user_id,
        event_type: w.entry.ws_message.type,
        ws_message: w.entry.ws_message,
        entry_v: w.entry.v,
        created_at: w.entry.created_at,
      })));
      written = ids.map((id) => by_id.get(id)).filter((w): w is QueuedWrite => !!w);
      count("db_writes", written.length);
    } catch (err: any) {
      count("db_write_failed", todo.length);
      log_error(`[POLL-CACHE] DB write error (${todo.length} entries): ${err?.message ?? err}`);
      return;
    }
    if (written.length === 0) return;

    // A drain that landed between the check and the insert found nothing to
    // delete in PG; the row just written would resurrect the entry.
    const undo = new Set<QueuedWrite>(written.filter((w) => w.drained));
    if (guarded) {
      const still = await ask_redis(written, "post");
      if (still) for (const w of written) if (!still.has(w)) undo.add(w);
    }
    if (undo.size > 0) {
      try {
        const n = await deps.delete_exact(Array.from(undo, (w) => ({ id: w.entry.message_id, v: w.entry.v })));
        count("db_write_compensated", n);
      } catch (err: any) {
        log_error(`[POLL-CACHE] DB compensation delete failed (${undo.size}): ${err?.message ?? err}`);
      }
    }
  };

  // Write every due entry (≤ max_rows per pass; the next pass is armed at
  // once if more are due). Resolves when this pass is done.
  const flush_due = async (): Promise<void> => {
    if (running) return running;
    if (stopped) return;
    const t = now();
    const batch: [string, QueuedWrite][] = [];
    for (const [tk, w] of queue) {
      if (w.due > t || batch.length >= max_rows) break;
      batch.push([tk, w]);
    }
    if (batch.length === 0) {
      arm();
      return;
    }
    for (const [tk, w] of batch) {
      queue.delete(tk);
      inflight.set(tk, w);
    }
    running = track(write(batch.map(([, w]) => w)))
      .catch((err: any) => log_error(`[POLL-CACHE] deferred DB write failed: ${err?.message ?? err}`))
      .finally(() => {
        for (const [tk, w] of batch) if (inflight.get(tk) === w) inflight.delete(tk);
        running = null;
        arm();
      });
    return running;
  };

  // Drain: drop what is queued and stop queueing. A flush in flight finishes.
  const drop = (): number => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    const n = queue.size;
    queue.clear();
    if (n > 0) count("db_writes_dropped", n);
    return n;
  };

  const stats = () => ({ queued: queue.size, inflight: inflight.size, stopped });

  return { schedule, mark_fresh, note_drain, flush_due, drop, stats };
};

type DeferredWriter = ReturnType<typeof create_deferred_writer>;

export {
  ANY_VERSION,
  TOMB_PREFIX,
  TOMBSTONE_WINDOW_MS,
  LUA_PENDING_DRAIN,
  LUA_PENDING_DB_GUARD,
  encode_entry,
  parse_value,
  uuid7_ms,
  redis_entries_key,
  redis_return_meta_key,
  create_pending_redis,
  db_upsert_entries,
  db_delete_versions,
  db_delete_exact,
  create_deferred_writer,
  is_immutable_key,
  version_le,
  DB_WRITE_DELAY_MS,
  STALE_WRITE_MS,
};
export type { PendingEntry, DrainItem, DrainBatch, GuardBatch, PendingRedis, DbRow, ParsedValue, DeferredWriter, WriterDeps, QueuedWrite };
