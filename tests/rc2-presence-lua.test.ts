// RC-2 presence Lua scripts (SYNC_V2 §13.5) against a REAL redis-server.
// Needs a local redis-server binary: REDIS_SERVER_BIN=/path/to/redis-server,
// or one on PATH. Without it the suite is skipped (it never touches the
// project's Redis — it starts its own on 127.0.0.1 with persistence off).
// Run: `REDIS_SERVER_BIN=$(which redis-server) bun test tests/rc2-presence-lua.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { create_inbox_publisher, create_presence, type PresenceStore } from "@/cluster/presence-store";
import { apply_liveness, bucket_arrays, decode_inbox, new_buckets } from "@/cluster/router-core";
import { k } from "@/cluster/keys";
import {
  PRESENCE_POLL_TTL_S,
  PRESENCE_WS_TTL_S,
  REFRESH_BG_REPAIR,
  REFRESH_GHOST,
  REFRESH_OK,
  REFRESH_SELFHEAL,
} from "@/cluster/presence-core";

const BIN = process.env.REDIS_SERVER_BIN || Bun.which("redis-server") || "";
const A = "host-a:1:aaaaaaaa";
const B = "host-a:2:bbbbbbbb";

let server: Subprocess | null = null;
let client: Redis;
let pa: PresenceStore; // worker A
let pb: PresenceStore; // worker B, same Redis

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

describe.skipIf(!BIN)("presence Lua on redis-server", () => {
  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    server = Bun.spawn(
      [BIN, "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", tmpdir()],
      { stdout: "ignore", stderr: "ignore" },
    );
    client = new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1 });
    client.on("error", () => { }); // connection refused while the server boots
    const up = await wait_for(async () => {
      if (client.status !== "ready") await client.connect().catch(() => { });
      return (await client.ping()) === "PONG";
    }, 5_000);
    if (!up) throw new Error("redis-server did not start");
    pa = create_presence(client, A);
    pb = create_presence(client, B);
  });

  afterAll(async () => {
    try {
      await client?.quit();
    } catch { }
    server?.kill();
  });

  test("CLAIM: fresh edge, takes the key, ends a poll lease, indexes the uid", async () => {
    await pb.touch_poll("u1", true, false);
    const r = await pa.claim("u1", "cid1", false);
    expect(r.old_ws).toBeNull();
    expect(r.old_poll).toEqual({ wid: B, bg: true });
    expect(await client.get(k.presence_ws("u1"))).toBe(`${A}|cid1|0`);
    expect(await client.exists(k.presence_poll("u1"))).toBe(0);
    const ttl = await client.ttl(k.presence_ws("u1"));
    expect(ttl).toBeGreaterThan(PRESENCE_WS_TTL_S - 3);
    expect(await client.sismember(k.presence_by_worker(A), "u1")).toBe(1);
  });

  test("CLAIM on another worker returns the previous owner (→ evict)", async () => {
    const r = await pb.claim("u1", "cid2", true);
    expect(r.old_ws).toEqual({ wid: A, cid: "cid1", bg: false });
    expect(await client.get(k.presence_ws("u1"))).toBe(`${B}|cid2|1`);
  });

  test("RELEASE is compare-and-delete: wrong worker / old cid never deletes a newer socket", async () => {
    expect(await pa.release("u1", "cid1")).toBe(false); // A's old socket closing late
    expect(await pb.release("u1", "cidX")).toBe(false); // right worker, wrong socket
    expect(await client.get(k.presence_ws("u1"))).toBe(`${B}|cid2|1`);
    expect(await pb.release("u1", "cid2")).toBe(true);
    expect(await client.exists(k.presence_ws("u1"))).toBe(0);
    expect(await client.sismember(k.presence_by_worker(B), "u1")).toBe(0);
  });

  test("REFRESH: self-heal, extend, bg repair, ghost", async () => {
    // key gone (expired / lost) → recreated
    let [r] = await pa.refresh_many([{ uid: "u2", cid: "c", bg: false }]);
    expect(r).toBe(REFRESH_SELFHEAL);
    expect(await client.get(k.presence_ws("u2"))).toBe(`${A}|c|0`);
    // same value → TTL extended only
    await client.expire(k.presence_ws("u2"), 5);
    [r] = await pa.refresh_many([{ uid: "u2", cid: "c", bg: false }]);
    expect(r).toBe(REFRESH_OK);
    expect(await client.ttl(k.presence_ws("u2"))).toBeGreaterThan(PRESENCE_WS_TTL_S - 3);
    // a lost SET_BG is repaired
    [r] = await pa.refresh_many([{ uid: "u2", cid: "c", bg: true }]);
    expect(r).toBe(REFRESH_BG_REPAIR);
    expect(await client.get(k.presence_ws("u2"))).toBe(`${A}|c|1`);
    // someone else claimed → ghost, key untouched
    await pb.claim("u2", "newer", false);
    [r] = await pa.refresh_many([{ uid: "u2", cid: "c", bg: true }]);
    expect(r).toBe(REFRESH_GHOST);
    expect(await client.get(k.presence_ws("u2"))).toBe(`${B}|newer|0`);
  });

  test("REFRESH pipelines past one chunk and keeps replies aligned", async () => {
    const entries = Array.from({ length: 600 }, (_, i) => ({ uid: `bulk${i}`, cid: `c${i}`, bg: i % 2 === 0 }));
    await pb.claim("bulk7", "theirs", false); // one ghost in the middle
    const replies = await pa.refresh_many(entries);
    expect(replies.length).toBe(600);
    replies.forEach((r, i) => expect(r).toBe(i === 7 ? REFRESH_GHOST : REFRESH_SELFHEAL));
    expect(await client.get(k.presence_ws("bulk599"))).toBe(`${A}|c599|0`);
  });

  test("SET_BG only on the owner's socket, TTL kept", async () => {
    await pa.claim("u3", "c3", false);
    await client.expire(k.presence_ws("u3"), 20);
    expect(await pa.set_bg("u3", "c3", true)).toBe(true);
    expect(await client.get(k.presence_ws("u3"))).toBe(`${A}|c3|1`);
    const ttl = await client.ttl(k.presence_ws("u3"));
    expect(ttl).toBeLessThanOrEqual(20);
    expect(ttl).toBeGreaterThan(15);
    expect(await pa.set_bg("u3", "other", false)).toBe(false);
    expect(await pb.set_bg("u3", "c3", false)).toBe(false);
    expect(await client.get(k.presence_ws("u3"))).toBe(`${A}|c3|1`);
  });

  test("poll lease: SET EX 12; set_poll_bg flips an existing lease only (XX, KEEPTTL)", async () => {
    await pa.set_poll_bg("p1", true); // no lease → nothing created
    expect(await client.exists(k.presence_poll("p1"))).toBe(0);
    await pa.touch_poll("p1", false, true);
    expect(await client.get(k.presence_poll("p1"))).toBe(`${A}|0`);
    expect(await client.ttl(k.presence_poll("p1"))).toBeGreaterThan(PRESENCE_POLL_TTL_S - 3);
    await client.expire(k.presence_poll("p1"), 4);
    await pa.set_poll_bg("p1", true);
    expect(await client.get(k.presence_poll("p1"))).toBe(`${A}|1`);
    expect(await client.ttl(k.presence_poll("p1"))).toBeLessThanOrEqual(4);
  });

  test("TOUCH_POLL: a flagless poll on another worker keeps the registry's bg (4.2.2 at N>1)", async () => {
    // status=background arrived by POST on worker A (lease + hint written) …
    await pa.touch_poll("q1", null, false);
    await pa.set_poll_bg("q1", true);
    expect(await client.get(k.presence_poll("q1"))).toBe(`${A}|1`);
    // … then a poll WITHOUT bg lands on B, whose own lease still says online.
    expect(await pb.touch_poll("q1", null, false)).toBe(true);
    expect(await client.get(k.presence_poll("q1"))).toBe(`${B}|1`);
    expect(await client.ttl(k.presence_poll("q1"))).toBeGreaterThan(PRESENCE_POLL_TTL_S - 3);
    // An explicit flag (new clients) always wins, and is remembered.
    expect(await pb.touch_poll("q1", false, true)).toBe(false);
    expect(await client.get(k.presence_poll("q1"))).toBe(`${B}|0`);
    expect(await client.get(k.presence_hint("q1"))).toBe("0");
  });

  test("TOUCH_POLL: a new lease starts from the announced hint, else the worker's fallback", async () => {
    // The status frame landed while no lease existed anywhere: only the hint.
    await pb.set_poll_bg("q2", true);
    expect(await client.exists(k.presence_poll("q2"))).toBe(0);
    expect(await client.get(k.presence_hint("q2"))).toBe("1");
    expect(await pa.touch_poll("q2", null, false)).toBe(true);
    expect(await client.get(k.presence_poll("q2"))).toBe(`${A}|1`);
    // No hint at all → this worker's belief.
    expect(await pa.touch_poll("q3", null, true)).toBe(true);
    expect(await pa.touch_poll("q4", null, false)).toBe(false);
    // A WS open is an announcement too: a foreground open clears the hint.
    await pa.claim("q2", "cq2", false);
    expect(await client.get(k.presence_hint("q2"))).toBe("0");
    expect(await pb.touch_poll("q2", null, true)).toBe(false);
  });

  test("LOOKUP returns both keys per user, aligned, across chunks", async () => {
    await pa.claim("l1", "x1", true);
    await pb.touch_poll("l2", true, false);
    const uids = ["l1", "l2", "nobody", ...Array.from({ length: 300 }, (_, i) => `bulk${i}`)];
    const pres = await pa.lookup(uids);
    expect(pres.length).toBe(uids.length);
    expect(pres[0]).toEqual({ ws: { wid: A, cid: "x1", bg: true }, poll: null });
    expect(pres[1]).toEqual({ ws: null, poll: { wid: B, bg: true } });
    expect(pres[2]).toEqual({ ws: null, poll: null });
    expect(pres[3 + 7]?.ws?.wid).toBe(B); // bulk7 (claimed by B above)
    expect(pres[3 + 8]?.ws).toEqual({ wid: A, cid: "c8", bg: true });
  });

  test("release_owned_by deletes only keys the dead worker owned", async () => {
    await pa.claim("d1", "a", false);
    await pb.claim("d2", "b", false);
    const n = await pb.release_owned_by(A, ["d1", "d2"]);
    expect(n).toBe(1);
    expect(await client.exists(k.presence_ws("d1"))).toBe(0);
    expect(await client.get(k.presence_ws("d2"))).toBe(`${B}|b|0`);
  });

  test("scripts reload after SCRIPT FLUSH (NOSCRIPT fallback)", async () => {
    await client.script("FLUSH");
    const r = await pa.claim("f1", "c", false);
    expect(r.old_ws).toBeNull();
    expect(await pa.set_bg("f1", "c", true)).toBe(true);
    const [rr] = await pa.refresh_many([{ uid: "f1", cid: "c", bg: true }]);
    expect(rr).toBe(REFRESH_OK);
  });

  test("inbox: PUBLISH reaches the owner's subscriber; receivers + beat key decide liveness", async () => {
    const C = "host-c:1:cccccccc"; // dead: no subscriber, no beat
    const sub = client.duplicate();
    sub.on("error", () => { });
    const got: string[] = [];
    await sub.subscribe(k.inbox(B));
    sub.on("message", (_ch: string, msg: string) => got.push(msg));
    await client.set(k.worker(B), "{}", "EX", 15);

    const frame = JSON.stringify({ type: "conversation:typing", payload: { conv_id: "c\nx" } });
    const remote = new Map([
      [B, ["r1", "r2"]],
      [C, ["r3"]],
    ]);
    const res = await create_inbox_publisher(client).publish_and_check(remote, frame);
    expect(res.get(B)).toEqual({ receivers: 1, alive: true });
    expect(res.get(C)).toEqual({ receivers: 0, alive: false });

    const b = new_buckets();
    for (const u of ["r1", "r2", "r3"]) b.online.add(u);
    const { dead } = apply_liveness(b, remote, res);
    expect(bucket_arrays(b)).toEqual({ online: ["r1", "r2"], offline: ["r3"], polling: [], background: [] });
    expect(dead).toEqual([{ wid: C, uids: ["r3"] }]);

    expect(await wait_for(async () => got.length === 1, 2_000)).toBe(true);
    expect(decode_inbox(got[0])).toEqual({ kind: "deliver", uids: ["r1", "r2"], frame });

    await create_inbox_publisher(client).publish_evict(B, "r1", "old", "new");
    expect(await wait_for(async () => got.length === 2, 2_000)).toBe(true);
    expect(decode_inbox(got[1])).toEqual({ kind: "evict", uid: "r1", old_cid: "old", new_cid: "new" });
    await sub.quit();
  });
});
