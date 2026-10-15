// RC-3 pending store (SYNC_V2 §13.7 C2/C3): versioned entries, the Lua
// compare-and-delete drain, ack tombstones and the deferred DB writer's
// guard, against a REAL redis-server. The DB side here is an in-memory
// stand-in with the same conditional-upsert semantics; the real SQL runs on
// the PGlite harness (scratchpad pglite/pending.ts).
// Needs REDIS_SERVER_BIN (or redis-server on PATH); skipped otherwise. It
// never touches the project's Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { randomUUIDv7 } from "bun";
import {
  ANY_VERSION,
  STALE_WRITE_MS,
  TOMBSTONE_WINDOW_MS,
  create_deferred_writer,
  create_pending_redis,
  encode_entry,
  is_immutable_key,
  parse_value,
  redis_entries_key,
  redis_return_meta_key,
  uuid7_ms,
  version_le,
  type DbRow,
  type DrainItem,
  type PendingEntry,
  type PendingRedis,
} from "@/cache-management/pending-store-core";
import { newer_pending_entry } from "@/utils/poll-ack-drain.utils";
import Snowflake from "@/utils/snowflake.utils";

const BIN = process.env.REDIS_SERVER_BIN || Bun.which("redis-server") || "";

// A UUIDv7 whose timestamp is `ms` (the rest random), for "old" versions.
const uuid7_at = (ms: number): string => {
  const hex = ms.toString(16).padStart(12, "0");
  const r = randomUUIDv7();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}${r.slice(13)}`;
};

const msg = (id: string, sender = "s") => ({
  type: "message:new" as const,
  payload: { id, conv_id: "c", sender_id: sender, body: "hi" },
  ws_timestamp: new Date(0).toISOString(),
});
const entry = (key: string, v: string, id = "m1"): PendingEntry => ({
  v,
  message_id: key,
  ws_message: msg(id) as any,
  created_at: Date.now(),
});

describe("pending-store codec (pure)", () => {
  test("entry JSON is v-first, round-trips, and old (unversioned) JSON reads as v ''", () => {
    const v = randomUUIDv7();
    const raw = encode_entry(entry("u:message:new:m1", v));
    expect(raw.startsWith(`{"v":"${v}"`)).toBe(true);
    const p = parse_value(raw);
    expect(p?.kind).toBe("entry");
    expect(p?.kind === "entry" && p.entry.v).toBe(v);
    const legacy = JSON.stringify({ message_id: "k", ws_message: msg("m1"), created_at: 5 });
    const pl = parse_value(legacy);
    expect(pl?.kind === "entry" && pl.entry.v).toBe("");
    expect(parse_value("~" + v)).toEqual({ kind: "tomb", v });
    expect(parse_value("not json")).toBeNull();
  });

  test("uuid7_ms reads the store time; non-v7 → undefined", () => {
    const t = Date.now();
    const ms = uuid7_ms(randomUUIDv7())!;
    expect(Math.abs(ms - t)).toBeLessThan(2_000);
    expect(uuid7_ms(uuid7_at(1_000_000))).toBe(1_000_000);
    expect(uuid7_ms("")).toBeUndefined();
    expect(uuid7_ms(crypto.randomUUID())).toBeUndefined(); // v4
  });

  test("version_le / newer_pending_entry / is_immutable_key", () => {
    const a = randomUUIDv7();
    const b = randomUUIDv7();
    expect(a < b).toBe(true); // bun's v7 is monotonic within a process
    expect(version_le(a, b)).toBe(true);
    expect(version_le(b, a)).toBe(false);
    expect(version_le(b, undefined)).toBe(true);
    expect(version_le(b, ANY_VERSION)).toBe(true);
    expect(version_le("", a)).toBe(true);
    expect(version_le(a, "")).toBe(false);
    expect(newer_pending_entry({ v: a, t: 1 }, { v: b, t: 2 }).t).toBe(2);
    expect(newer_pending_entry({ v: b, t: 1 }, { v: a, t: 2 }).t).toBe(1);
    expect(newer_pending_entry({ v: "", t: 1 }, { v: "", t: 2 }).t).toBe(2); // tie: second (Redis) wins
    expect(is_immutable_key(Snowflake.correlationId("u", "message:new", "m"))).toBe(true);
    expect(is_immutable_key(Snowflake.correlationId("u", "message:sent:ack", "m"))).toBe(true);
    expect(is_immutable_key(Snowflake.correlationId("u", "message:pin", "c"))).toBe(false);
  });
});

let server: Subprocess | null = null;
let client: Redis;
let pr: PendingRedis;

const wait_for = async (fn: () => Promise<boolean>, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await fn()) return true;
    } catch { }
    await Bun.sleep(50);
  }
  return false;
};

// In-memory stand-in for missed_ws_messages with the SQL's semantics:
// upsert replaces only with a NEWER version; delete_versions = "≤ v / any";
// delete_exact = that version only.
class FakeDb {
  rows = new Map<string, { user_id: string; v: string | null }>();
  upserts = 0;
  before_upsert: (() => Promise<void>) | null = null;
  async upsert(rows: DbRow[]): Promise<string[]> {
    if (this.before_upsert) await this.before_upsert();
    this.upserts++;
    const out: string[] = [];
    for (const r of rows) {
      const cur = this.rows.get(r.id);
      if (!cur || cur.v === null || cur.v < r.entry_v) {
        this.rows.set(r.id, { user_id: r.user_id, v: r.entry_v });
        out.push(r.id);
      }
    }
    return out;
  }
  async delete_versions(user_id: string, items: DrainItem[]): Promise<number> {
    let n = 0;
    for (const it of items) {
      const cur = this.rows.get(it.key);
      if (!cur || cur.user_id !== user_id) continue;
      if (it.v === undefined || it.v === ANY_VERSION || cur.v === null || cur.v <= it.v) {
        this.rows.delete(it.key);
        n++;
      }
    }
    return n;
  }
  async delete_exact(items: { id: string; v: string }[]): Promise<number> {
    let n = 0;
    for (const it of items) {
      if (this.rows.get(it.id)?.v === it.v) {
        this.rows.delete(it.id);
        n++;
      }
    }
    return n;
  }
}

describe.skipIf(!BIN)("pending store Lua + deferred writer on redis-server", () => {
  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    server = Bun.spawn(
      [BIN, "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", tmpdir()],
      { stdout: "ignore", stderr: "ignore" },
    );
    client = new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1 });
    client.on("error", () => { });
    const up = await wait_for(async () => {
      if (client.status !== "ready") await client.connect().catch(() => { });
      return (await client.ping()) === "PONG";
    }, 5_000);
    if (!up) throw new Error("redis-server did not start");
    pr = create_pending_redis(client);
  });

  afterAll(async () => {
    try {
      await client?.quit();
    } catch { }
    server?.kill();
  });

  beforeEach(async () => {
    await client.flushall();
  });

  const U = "11111111-1111-4111-8111-111111111111";
  const KEY_PIN = Snowflake.correlationId(U, "message:pin", "chat1");
  const KEY_NEW = Snowflake.correlationId(U, "message:new", "m1");
  const put = (key: string, e: PendingEntry) => client.hset(redis_entries_key(U), key, encode_entry(e));
  const field = (key: string) => client.hget(redis_entries_key(U), key);

  // ---- C2: compare-and-delete --------------------------------------------------

  test("C2: a poll that read v1 does not delete a v2 stored meanwhile (the lost-update race)", async () => {
    const v1 = randomUUIDv7();
    await put(KEY_PIN, entry(KEY_PIN, v1));
    // poll reads v1 … meanwhile a newer pin state is stored under the same key
    const v2 = randomUUIDv7();
    await put(KEY_PIN, entry(KEY_PIN, v2));
    // … then the poll's delete-on-read lands with the version it returned
    const { drained: [n] } = await pr.drain([{ user_id: U, items: [{ key: KEY_PIN, v: v1 }], tomb: false }]);
    expect(n).toBe(0);
    const left = parse_value(await field(KEY_PIN));
    expect(left?.kind === "entry" && left.entry.v).toBe(v2);
    // the next poll returns v2 and its drain removes it
    const { drained: [n2] } = await pr.drain([{ user_id: U, items: [{ key: KEY_PIN, v: v2 }], tomb: false }]);
    expect(n2).toBe(1);
    expect(await field(KEY_PIN)).toBeNull();
  });

  test("C2: drain of an OLDER-or-equal stored version deletes it; 'any' deletes whatever is there", async () => {
    const v1 = randomUUIDv7();
    const v2 = randomUUIDv7();
    await put(KEY_PIN, entry(KEY_PIN, v1));
    expect((await pr.drain([{ user_id: U, items: [{ key: KEY_PIN, v: v2 }], tomb: false }])).drained[0]).toBe(1);
    await put(KEY_NEW, entry(KEY_NEW, v2));
    expect((await pr.drain([{ user_id: U, items: [{ key: KEY_NEW }], tomb: false }])).drained[0]).toBe(1);
    expect(await client.hlen(redis_entries_key(U))).toBe(0);
  });

  test("C2: legacy (unversioned) entries: drained by '' and by any; a versioned entry survives a '' drain", async () => {
    const legacy = JSON.stringify({ message_id: KEY_PIN, ws_message: msg("x"), created_at: 1 });
    await client.hset(redis_entries_key(U), KEY_PIN, legacy);
    expect((await pr.drain([{ user_id: U, items: [{ key: KEY_PIN, v: "" }], tomb: false }])).drained[0]).toBe(1);
    await client.hset(redis_entries_key(U), KEY_PIN, legacy);
    expect((await pr.drain([{ user_id: U, items: [{ key: KEY_PIN }], tomb: false }])).drained[0]).toBe(1);
    const v = randomUUIDv7();
    await put(KEY_PIN, entry(KEY_PIN, v));
    expect((await pr.drain([{ user_id: U, items: [{ key: KEY_PIN, v: "" }], tomb: false }])).drained[0]).toBe(0);
    expect(await field(KEY_PIN)).not.toBeNull();
  });

  test("C2: the return mark goes with the drain; missing keys miss harmlessly", async () => {
    await put(KEY_NEW, entry(KEY_NEW, randomUUIDv7()));
    await client.hset(redis_return_meta_key(U), KEY_NEW, "1:2:1");
    const r = await pr.drain([
      { user_id: U, items: [{ key: KEY_NEW }, { key: "nope" }], tomb: false },
      { user_id: "other", items: [], tomb: false },
    ]);
    expect(r).toEqual({ drained: [1, 0], field_ttl_refused: false });
    expect(await client.hexists(redis_return_meta_key(U), KEY_NEW)).toBe(0);
  });

  test("C2: concurrent drains of one version: exactly one wins", async () => {
    const v = randomUUIDv7();
    await put(KEY_PIN, entry(KEY_PIN, v));
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => pr.drain([{ user_id: U, items: [{ key: KEY_PIN, v }], tomb: true }])),
    );
    expect(rs.reduce((a, r) => a + r.drained[0]!, 0)).toBe(1);
  });

  // ---- C3: tombstones --------------------------------------------------------

  test("C3: a tomb drain of a young entry leaves '~v' with a field TTL; an old one is deleted", async () => {
    const v = randomUUIDv7();
    await put(KEY_NEW, entry(KEY_NEW, v));
    await pr.drain([{ user_id: U, items: [{ key: KEY_NEW }], tomb: true }]);
    expect(await field(KEY_NEW)).toBe("~" + v);
    const ttl = (await client.call("HPTTL", redis_entries_key(U), "FIELDS", "1", KEY_NEW)) as number[];
    expect(ttl[0]).toBeGreaterThan(0);
    expect(ttl[0]).toBeLessThanOrEqual(TOMBSTONE_WINDOW_MS);
    // a second drain of the tombstone is a no-op
    expect((await pr.drain([{ user_id: U, items: [{ key: KEY_NEW }], tomb: true }])).drained[0]).toBe(0);

    const old = uuid7_at(Date.now() - TOMBSTONE_WINDOW_MS - 1_000);
    await put(KEY_PIN, entry(KEY_PIN, old));
    await pr.drain([{ user_id: U, items: [{ key: KEY_PIN }], tomb: true }]);
    expect(await field(KEY_PIN)).toBeNull();
  });

  test("C3: on a Redis without per-field TTL (< 7.4) the drain still works and says so", async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const old = Bun.spawn(
      [BIN, "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", tmpdir(),
        "--rename-command", "HPEXPIRE", ""],
      { stdout: "ignore", stderr: "ignore" },
    );
    const c2 = new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1 });
    c2.on("error", () => { });
    try {
      expect(await wait_for(async () => {
        if (c2.status !== "ready") await c2.connect().catch(() => { });
        return (await c2.ping()) === "PONG";
      }, 5_000)).toBe(true);
      const p2 = create_pending_redis(c2);
      const v = randomUUIDv7();
      await c2.hset(redis_entries_key(U), KEY_NEW, encode_entry(entry(KEY_NEW, v)));
      const r = await p2.drain([{ user_id: U, items: [{ key: KEY_NEW }], tomb: true }]);
      expect(r).toEqual({ drained: [1], field_ttl_refused: true });
      expect(await c2.hget(redis_entries_key(U), KEY_NEW)).toBe("~" + v);
      // no tomb requested → no TTL attempted → nothing to report
      await c2.hset(redis_entries_key(U), KEY_PIN, encode_entry(entry(KEY_PIN, randomUUIDv7())));
      expect(await p2.drain([{ user_id: U, items: [{ key: KEY_PIN }], tomb: false }])).toEqual({ drained: [1], field_ttl_refused: false });
    } finally {
      c2.disconnect();
      old.kill();
    }
  });

  test("C3: a new store overwrites a tombstone (and its field TTL)", async () => {
    const v1 = randomUUIDv7();
    await put(KEY_PIN, entry(KEY_PIN, v1));
    await pr.drain([{ user_id: U, items: [{ key: KEY_PIN }], tomb: true }]);
    const v2 = randomUUIDv7();
    await put(KEY_PIN, entry(KEY_PIN, v2));
    const ttl = (await client.call("HPTTL", redis_entries_key(U), "FIELDS", "1", KEY_PIN)) as number[];
    expect(ttl[0]).toBe(-1);
    const p = parse_value(await field(KEY_PIN));
    expect(p?.kind === "entry" && p.entry.v).toBe(v2);
  });

  test("C3: PENDING_DB_GUARD verdicts", async () => {
    const v1 = randomUUIDv7();
    const v2 = randomUUIDv7();
    const v3 = randomUUIDv7();
    const K = (s: string) => Snowflake.correlationId(U, "message:pin", s);
    await put(K("same"), entry(K("same"), v2));
    await put(K("newer"), entry(K("newer"), v3));
    await client.hset(redis_entries_key(U), K("tomb_eq"), "~" + v2);
    await client.hset(redis_entries_key(U), K("tomb_old"), "~" + v1);
    await client.hset(redis_entries_key(U), K("legacy"), JSON.stringify({ message_id: "x", ws_message: msg("x"), created_at: 1 }));
    const { allowed, failed } = await pr.guard([{
      user_id: U,
      items: ["same", "newer", "tomb_eq", "tomb_old", "missing", "legacy"].map((s) => ({ key: K(s), v: v2 })),
    }]);
    expect(failed).toBe(0);
    // same → write; newer entry → skip (its own write carries it); tombstone at
    // or past mine → skip; an older tombstone → write; missing (trimmed) → write.
    expect(allowed[0]).toEqual([true, false, false, true, true, true]);
    const { missing } = await pr.guard([{ user_id: U, items: ["same", "missing"].map((s) => ({ key: K(s), v: v2 })) }]);
    expect(missing[0]).toEqual([false, true]);
  });

  test("writer (cluster): after a stall past the tombstone window, a MISSING field is read as drained (no LWW resurrection)", async () => {
    const db = new FakeDb();
    let t = Date.now();
    const counts = new Map<string, number>();
    const a = create_deferred_writer({
      redis: pr,
      upsert: (rows) => db.upsert(rows),
      delete_exact: (items) => db.delete_exact(items),
      guarded: () => true,
      count: (name, n = 1) => counts.set(name, (counts.get(name) ?? 0) + n),
      log_error: () => { },
      delay_ms: 0,
      auto: false,
      now: () => t,
    });
    const old = { ...entry(KEY_PIN, randomUUIDv7()), created_at: t };
    a.schedule(U, old); // queued on A, never in Redis (its field was drained and the tombstone expired)
    const young = { ...entry(KEY_NEW, randomUUIDv7()), created_at: t + STALE_WRITE_MS };
    t += STALE_WRITE_MS;
    a.schedule(U, young); // missing too, but young: a cap-trimmed entry keeps its DB copy
    await a.flush_due();
    expect(db.rows.has(KEY_PIN)).toBe(false);
    expect(db.rows.has(KEY_NEW)).toBe(true);
    expect(counts.get("db_write_skipped_stale")).toBe(1);
  });

  // ---- C3: the deferred writer ---------------------------------------------------

  type Worker = { w: ReturnType<typeof create_deferred_writer>; counts: Map<string, number> };
  const mk_worker = (db: FakeDb, guarded: boolean, redis: Pick<PendingRedis, "guard"> = pr): Worker => {
    const counts = new Map<string, number>();
    const w = create_deferred_writer({
      redis,
      upsert: (rows) => db.upsert(rows),
      delete_exact: (items) => db.delete_exact(items),
      guarded: () => guarded,
      count: (name, n = 1) => counts.set(name, (counts.get(name) ?? 0) + n),
      log_error: () => { },
      delay_ms: 0,
      auto: false,
    });
    return { w, counts };
  };
  // What polling.cache.drain_pending does, against these stand-ins.
  const drain = async (wk: Worker, db: FakeDb, items: DrainItem[], tomb: boolean) => {
    const pg_unneeded = wk.w.note_drain(U, items);
    await pr.drain([{ user_id: U, items, tomb }]);
    if (!pg_unneeded) await db.delete_versions(U, items);
    return pg_unneeded;
  };
  // As store_pending_message_for_users: schedule, HSET, then mark_fresh
  // when the HSET created the field.
  const store = async (wk: Worker, key: string, v = randomUUIDv7(), e = entry(key, v)) => {
    wk.w.schedule(U, e);
    if ((await put(key, e)) === 1) wk.w.mark_fresh(U, key, e.v);
    return e;
  };

  test("writer: a local ack before the flush cancels the write; PG delete skipped for an immutable key", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, false);
    await store(a, KEY_NEW);
    const pg_unneeded = await drain(a, db, [{ key: KEY_NEW }], false);
    expect(pg_unneeded).toBe(true);
    await a.w.flush_due();
    expect(db.upserts).toBe(0);
    expect(db.rows.size).toBe(0);
    // an LWW key still gets the PG delete (an older version may be there)
    await store(a, KEY_PIN);
    expect(await drain(a, db, [{ key: KEY_PIN }], false)).toBe(false);
  });

  test("writer: a sent-ack refusal flushed to PG, then the retry's success acked before ITS flush → PG DELETE still runs", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, false);
    const KEY_ACK = Snowflake.correlationId(U, "message:sent:ack", "m1");
    const refusal = { ...entry(KEY_ACK, randomUUIDv7()), ws_message: { type: "message:sent:ack", payload: { msg_id: "m1", is_sent: false, error_code: 500 } } as any };
    await store(a, KEY_ACK, refusal.v, refusal);
    await a.w.flush_due();
    expect(db.rows.has(KEY_ACK)).toBe(true);
    const ok = { ...entry(KEY_ACK, randomUUIDv7()), ws_message: { type: "message:sent:ack", payload: { msg_id: "m1", is_sent: true } } as any };
    await store(a, KEY_ACK, ok.v, ok); // overwrites the field → not fresh
    expect(await drain(a, db, [{ key: KEY_ACK }], false)).toBe(false);
    expect(db.rows.has(KEY_ACK)).toBe(false);
    await a.w.flush_due();
    expect(db.rows.has(KEY_ACK)).toBe(false);
  });

  test("writer: unacked entries are written in ONE upsert; a re-store replaces the queued version", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, false);
    await store(a, KEY_NEW);
    await store(a, KEY_PIN);
    const e2 = await store(a, KEY_PIN); // newer pin state before the flush
    await a.w.flush_due();
    expect(db.upserts).toBe(1);
    expect(db.rows.get(KEY_PIN)?.v).toBe(e2.v);
    expect(db.rows.size).toBe(2);
    expect(a.counts.get("db_writes")).toBe(2);
  });

  test("writer (cluster): an ack on worker B before A's flush → B leaves a tombstone, A's guard skips the write", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, true);
    const b = mk_worker(db, true);
    await store(a, KEY_NEW);
    await drain(b, db, [{ key: KEY_NEW }], true); // B has nothing queued → PG delete (no-op)
    await a.w.flush_due();
    expect(db.upserts).toBe(0);
    expect(db.rows.size).toBe(0);
    expect(a.counts.get("db_write_skipped_tomb")).toBe(1);
  });

  test("writer (cluster): ack lands between A's guard and its insert → post-insert re-check deletes A's row", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, true);
    const b = mk_worker(db, true);
    const e = await store(a, KEY_NEW);
    // B's whole drain (Redis tombstone + a PG delete that finds nothing) runs
    // after A's pre-insert guard passed and before A's row is in.
    db.before_upsert = async () => {
      db.before_upsert = null;
      await drain(b, db, [{ key: KEY_NEW }], true);
    };
    await a.w.flush_due();
    expect(db.upserts).toBe(1);
    expect(db.rows.has(KEY_NEW)).toBe(false);
    expect(a.counts.get("db_write_compensated")).toBe(1);
    expect(await field(KEY_NEW)).toBe("~" + e.v);
  });

  test("writer (cluster): WITHOUT the tombstone that same race resurrects the entry (why C3 exists)", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, true);
    const b = mk_worker(db, true);
    await store(a, KEY_NEW);
    db.before_upsert = async () => {
      db.before_upsert = null;
      await drain(b, db, [{ key: KEY_NEW }], false); // plain HDEL
    };
    await a.w.flush_due();
    expect(db.rows.has(KEY_NEW)).toBe(true);
  });

  test("writer (cluster): a newer version stored elsewhere → the older write is skipped", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, true);
    const b = mk_worker(db, true);
    await store(a, KEY_PIN);
    const e2 = await store(b, KEY_PIN);
    await a.w.flush_due();
    expect(db.rows.size).toBe(0);
    await b.w.flush_due();
    expect(db.rows.get(KEY_PIN)?.v).toBe(e2.v);
  });

  test("writer (local): a drain while the batch is being written → its row is deleted after the insert, no Redis", async () => {
    const db = new FakeDb();
    let guard_calls = 0;
    const counting = { guard: async (...args: Parameters<PendingRedis["guard"]>) => { guard_calls++; return pr.guard(...args); } };
    const a = mk_worker(db, false, counting);
    await store(a, KEY_NEW);
    db.before_upsert = async () => {
      db.before_upsert = null;
      expect(await drain(a, db, [{ key: KEY_NEW }], false)).toBe(false); // in flight → PG delete too
    };
    await a.w.flush_due();
    expect(db.rows.has(KEY_NEW)).toBe(false);
    expect(a.counts.get("db_write_compensated")).toBe(1);
    expect(guard_calls).toBe(0);
  });

  test("writer: Redis down → the guard fails open and the DB backstop is written", async () => {
    const db = new FakeDb();
    const broken = { guard: async () => { throw new Error("ECONNREFUSED"); } };
    const a = mk_worker(db, true, broken as any);
    await store(a, KEY_NEW);
    await a.w.flush_due();
    expect(db.rows.has(KEY_NEW)).toBe(true);
    expect(a.counts.get("db_guard_failed")).toBe(2); // pre and post
  });

  test("writer: drop() (SIGTERM) discards queued writes, counts them, and stops queueing", async () => {
    const db = new FakeDb();
    const a = mk_worker(db, false);
    await store(a, KEY_NEW);
    await store(a, KEY_PIN);
    expect(a.w.drop()).toBe(2);
    expect(a.counts.get("db_writes_dropped")).toBe(2);
    await store(a, Snowflake.correlationId(U, "message:new", "m2"));
    expect(a.w.stats().queued).toBe(0);
    await a.w.flush_due();
    expect(db.upserts).toBe(0);
  });

  test("writer: auto mode flushes on its own timer", async () => {
    const db = new FakeDb();
    const w = create_deferred_writer({
      redis: pr,
      upsert: (rows) => db.upsert(rows),
      delete_exact: (items) => db.delete_exact(items),
      guarded: () => false,
      delay_ms: 20,
    });
    const e = entry(KEY_NEW, randomUUIDv7());
    w.schedule(U, e);
    expect(await wait_for(async () => db.rows.has(KEY_NEW), 2_000)).toBe(true);
    expect(w.stats()).toEqual({ queued: 0, inflight: 0, stopped: false });
  });
});
