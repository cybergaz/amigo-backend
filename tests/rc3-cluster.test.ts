// RC-3 cluster state (SYNC_V2 §13.6.6, §13.7 D3 / E1–E3): the dead-worker
// reaper, the fenced lease + leased FCM broadcast waves (real redis-server),
// and the per-key epoch guard (pure). Redis parts are skipped without
// REDIS_SERVER_BIN / redis-server on PATH; never touches the project's Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { k } from "@/cluster/keys";
import { create_presence } from "@/cluster/presence-store";
import { create_reaper } from "@/cluster/reaper-core";
import { create_lease_client } from "@/cluster/lease-core";
import { EpochGuard } from "@/cache-management/cache-epoch";
import { run_leased_waves, type WaveRow } from "@/services/fcm-broadcast-waves";

const BIN = process.env.REDIS_SERVER_BIN || Bun.which("redis-server") || "";

describe("EpochGuard (E1–E3)", () => {
  test("a read that overlapped an invalidation of its key may not fill", () => {
    const g = new EpochGuard();
    const snap = g.snapshot();
    g.bump("chat1");
    expect(g.may_set("chat1", snap)).toBe(false);
    expect(g.may_set("chat2", snap)).toBe(true); // other keys unaffected
    const after = g.snapshot();
    expect(g.may_set("chat1", after)).toBe(true); // a read started after it may
  });

  test("bump_all (bus resync) refuses every read in flight", () => {
    const g = new EpochGuard();
    const snap = g.snapshot();
    g.bump_all();
    expect(g.may_set("anything", snap)).toBe(false);
    expect(g.may_set("anything", g.snapshot())).toBe(true);
  });

  test("bounded: past max_keys the map is dropped and a floor refuses older reads", () => {
    const g = new EpochGuard(3);
    const snap = g.snapshot();
    for (const key of ["a", "b", "c", "d"]) g.bump(key);
    expect(g.size()).toBe(0);
    expect(g.may_set("zzz", snap)).toBe(false);
    expect(g.may_set("zzz", g.snapshot())).toBe(true);
  });
});

let server: Subprocess | null = null;
let client: Redis;

describe.skipIf(!BIN)("reaper + lease on redis-server", () => {
  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    server = Bun.spawn(
      [BIN, "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", tmpdir()],
      { stdout: "ignore", stderr: "ignore" },
    );
    client = new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1 });
    client.on("error", () => { });
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      try {
        if (client.status !== "ready") await client.connect().catch(() => { });
        if ((await client.ping()) === "PONG") break;
      } catch { }
      await Bun.sleep(50);
    }
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

  // ---- reaper -------------------------------------------------------------------

  const A = "host:1:aaaaaaaa"; // dies
  const B = "host:2:bbbbbbbb"; // survivor, reaps
  const C = "host:3:cccccccc"; // second survivor

  const beat = (wid: string, alive: boolean, now = Date.now()) =>
    client.pipeline().zadd(k.workers(), now, wid).set(k.worker(wid), "{}", "EX", alive ? 15 : 1).exec();

  test("reaps a dead worker once: releases only its keys, reports only users present nowhere", async () => {
    const pa = create_presence(client, A);
    const pb = create_presence(client, B);
    await pa.claim("gone", "c1", false); // only on A → offline
    await pa.claim("moved", "c2", false); // reconnected to B since
    await pb.claim("moved", "c3", false);
    await pa.claim("polling", "c4", false); // fell back to long-poll
    await pb.touch_poll("polling", null, false);
    await beat(A, true);
    await beat(B, true);
    await client.del(k.worker(A)); // A stops beating: its key expired

    const rb = create_reaper(client, B, pb, undefined, { confirm_ms: 0 });
    const rc = create_reaper(client, C, create_presence(client, C), undefined, { confirm_ms: 0 });
    const [r1, r2] = await Promise.all([rb.reap_once(), rc.reap_once()]);
    const results = [...r1, ...r2];
    expect(results.length).toBe(1); // exactly one reaper acted (reap:{wid} NX)
    const r = results[0]!;
    expect(r.wid).toBe(A);
    expect(r.released.sort()).toEqual(["gone", "polling"]);
    expect(r.offline).toEqual(["gone"]);
    expect(await client.get(k.presence_ws("moved"))).toBe(`${B}|c3|0`); // untouched
    expect(await client.exists(k.presence_ws("gone"))).toBe(0);
    expect(await client.exists(k.presence_by_worker(A))).toBe(0);
    expect(await client.zscore(k.workers(), A)).toBeNull();
    // never again
    expect(await rb.reap_once()).toEqual([]);
  });

  test("reaps only after two dead observations a beat apart, and never while its own beat is stale", async () => {
    const pa = create_presence(client, A);
    const pb = create_presence(client, B);
    await pa.claim("u", "c1", false);
    await beat(A, true);
    await beat(B, true);
    await client.del(k.worker(A));
    let healthy = false;
    const rb = create_reaper(client, B, pb, undefined, { self_healthy: () => healthy });
    const t0 = Date.now();
    expect(await rb.reap_once(t0)).toEqual([]); // own beat stale → no judgement
    healthy = true;
    expect(await rb.reap_once(t0 + 1_000)).toEqual([]); // first sighting
    // A was only blipped: it beats again before the confirming pass
    await beat(A, true);
    expect(await rb.reap_once(t0 + 7_000)).toEqual([]);
    await client.del(k.worker(A));
    expect(await rb.reap_once(t0 + 8_000)).toEqual([]); // sighting restarts
    expect(await rb.reap_once(t0 + 10_000)).toEqual([]); // < 5 s apart
    const [r] = await rb.reap_once(t0 + 13_000);
    expect(r?.wid).toBe(A);
    expect(r?.offline).toEqual(["u"]);
  });

  test("refresh re-indexes the worker's users (a deleted presence:by_worker set heals)", async () => {
    const pa = create_presence(client, A);
    await pa.claim("long1", "c1", false);
    await pa.claim("long2", "c2", false);
    await client.del(k.presence_by_worker(A)); // e.g. a false reap / Redis blip
    await pa.refresh_many([{ uid: "long1", cid: "c1", bg: false }, { uid: "long2", cid: "c2", bg: false }]);
    expect((await client.smembers(k.presence_by_worker(A))).sort()).toEqual(["long1", "long2"]);
    expect(await client.ttl(k.presence_by_worker(A))).toBeGreaterThan(0);
  });

  test("never reaps self, a live worker, or one that beat too long ago", async () => {
    const pb = create_presence(client, B);
    await beat(B, true);
    await beat(C, true);
    await client.zadd(k.workers(), Date.now() - 10 * 60_000, A); // ancient entry
    await create_presence(client, A).claim("u", "c", false);
    const rb = create_reaper(client, B, pb);
    expect(await rb.find_dead(Date.now())).toEqual([]);
    expect(await rb.reap_once()).toEqual([]);
    expect(await client.exists(k.presence_ws("u"))).toBe(1);
  });

  // ---- lease (D3) ------------------------------------------------------------------

  test("lease: one holder at a time; fences only grow; a lost lease cannot write", async () => {
    const l1 = create_lease_client(client, "w1", k);
    const l2 = create_lease_client(client, "w2", k);
    const a = await l1.acquire("job", 60_000);
    expect(a).not.toBeNull();
    expect(await l2.acquire("job", 60_000)).toBeNull();
    expect(await a!.set_cursor("p1", 60)).toBe(true);
    expect(await l2.acquire("job", 60_000)).toBeNull();

    // a's lease expires (e.g. a GC pause past the TTL); b takes over
    await client.del(k.lease("job"));
    const b = await l2.acquire("job", 60_000);
    expect(b!.fence).toBeGreaterThan(a!.fence);
    expect(await b!.get_cursor()).toBe("p1"); // progress carries over
    expect(await a!.set_cursor("stale", 60)).toBe(false); // fenced out
    expect(await a!.renew()).toBe(false);
    await a!.release(); // not a's any more: no-op
    expect(await client.exists(k.lease("job"))).toBe(1);
    expect(await b!.set_cursor("p2", 60)).toBe(true);
    expect(await b!.clear_cursor()).toBe(true);
    expect(await client.exists(k.lease_cursor("job"))).toBe(0);
    await b!.release();
    expect(await client.exists(k.lease("job"))).toBe(0);
  });

  test("lease keys share a hash slot (two-key scripts stay single-slot)", async () => {
    const slot = async (key: string) => (await client.call("CLUSTER", "KEYSLOT", key).catch(() => null)) as number | null;
    const s1 = await slot(k.lease("fcm_broadcast"));
    if (s1 === null) return; // CLUSTER commands disabled on this build
    expect(await slot(k.lease_fence("fcm_broadcast"))).toBe(s1);
    expect(await slot(k.lease_cursor("fcm_broadcast"))).toBe(s1);
  });

  // ---- leased FCM waves (D3) ---------------------------------------------------------

  const users: WaveRow[] = Array.from({ length: 23 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    fcm_token: `t${i}`,
  }));
  const fetch_page = async (after: string | null, limit: number) =>
    users.filter((u) => after === null || u.id > after).slice(0, limit);

  test("waves: everyone once, paged, cursor cleared at the end", async () => {
    const lc = create_lease_client(client, "w1", k);
    const sent: string[] = [];
    const r = await run_leased_waves(
      {
        acquire: () => lc.acquire("fcm_broadcast", 60_000),
        fetch_page,
        send: async (row) => {
          sent.push(row.id);
          return row.fcm_token !== "t3";
        },
        log: () => { },
      },
      { run_id: "r1", concurrency: 5, delay_ms: 0, page_size: 10 },
    );
    expect(sent).toEqual(users.map((u) => u.id));
    expect(r).toEqual({ recipients: 23, sent: 22, failed: 1, waves: 5 }); // pages 10+10+3, waves of ≤5
    expect(await client.exists(k.lease_cursor("fcm_broadcast"))).toBe(0);
    expect(await client.exists(k.lease("fcm_broadcast"))).toBe(0);
  });

  test("waves: a concurrent second run is refused (busy), nobody is pushed twice", async () => {
    const sent: string[] = [];
    let release_first!: () => void;
    const gate = new Promise<void>((r) => (release_first = r));
    const first = run_leased_waves(
      {
        acquire: () => create_lease_client(client, "w1", k).acquire("fcm_broadcast", 60_000),
        fetch_page,
        send: async (row) => {
          await gate;
          sent.push(row.id);
          return true;
        },
        log: () => { },
      },
      { run_id: "r1", concurrency: 50, delay_ms: 0 },
    );
    await Bun.sleep(20);
    const second = await run_leased_waves(
      {
        acquire: () => create_lease_client(client, "w2", k).acquire("fcm_broadcast", 60_000),
        fetch_page,
        send: async (row) => {
          sent.push(row.id);
          return true;
        },
        log: () => { },
      },
      { run_id: "r1", concurrency: 50, delay_ms: 0 },
    );
    expect(second.skipped).toBe("busy");
    release_first();
    expect((await first).sent).toBe(23);
    expect(new Set(sent).size).toBe(sent.length);
  });

  test("waves: a run killed mid-way is resumed after its cursor by the same run_id", async () => {
    const sent: string[] = [];
    // A run whose process vanished after 2 waves of 5: its fenced cursor
    // stays (1 day), its lease runs out.
    const lc_dead = create_lease_client(client, "dead", k);
    const dead = await lc_dead.acquire("fcm_broadcast", 60_000);
    await dead!.set_cursor(JSON.stringify({ run_id: "r1", after_id: users[9]!.id, recipients: 10, sent: 10, failed: 0, waves: 2 }), 60);
    await client.del(k.lease("fcm_broadcast")); // TTL ran out

    const r = await run_leased_waves(
      {
        acquire: () => create_lease_client(client, "w2", k).acquire("fcm_broadcast", 60_000),
        fetch_page,
        send: async (row) => {
          sent.push(row.id);
          return true;
        },
        log: () => { },
      },
      { run_id: "r1", concurrency: 5, delay_ms: 0 },
    );
    expect(sent).toEqual(users.slice(10).map((u) => u.id)); // the first 10 are not pushed again
    expect(r).toEqual({ recipients: 23, sent: 23, failed: 0, waves: 5, resumed: true });

    // a DIFFERENT notification ignores a stale cursor and starts from the top
    await dead!.set_cursor("x", 60); // fenced out: dead's lease is long gone
    const lc3 = create_lease_client(client, "w3", k);
    const l3 = await lc3.acquire("fcm_broadcast", 60_000);
    await l3!.set_cursor(JSON.stringify({ run_id: "old", after_id: users[20]!.id, recipients: 0, sent: 0, failed: 0, waves: 0 }), 60);
    await l3!.release();
    sent.length = 0;
    const r2 = await run_leased_waves(
      { acquire: () => lc3.acquire("fcm_broadcast", 60_000), fetch_page, send: async (row) => (sent.push(row.id), true), log: () => { } },
      { run_id: "r2", concurrency: 50, delay_ms: 0 },
    );
    expect(sent.length).toBe(23);
    expect(r2.resumed).toBeUndefined();
  });

  test("waves: losing the lease mid-run stops at the next wave", async () => {
    const sent: string[] = [];
    const lc = create_lease_client(client, "w1", k);
    const r = await run_leased_waves(
      {
        acquire: () => lc.acquire("fcm_broadcast", 60_000),
        fetch_page,
        send: async (row) => {
          sent.push(row.id);
          if (sent.length === 5) {
            // our lease expires and someone else takes it during wave 1
            await client.del(k.lease("fcm_broadcast"));
            await create_lease_client(client, "w2", k).acquire("fcm_broadcast", 60_000);
          }
          return true;
        },
        log: () => { },
      },
      { run_id: "r1", concurrency: 5, delay_ms: 0 },
    );
    expect(r.aborted).toBe("lease_lost");
    expect(sent.length).toBe(5);
    expect(await client.get(k.lease("fcm_broadcast"))).toMatch(/^w2\|/); // w2's lease untouched by w1's release
  });
});
