// RC-3 G1: call busy reservation = two SET NX + compare-delete compensation
// (SYNC_V2 §13.5 "Calls"), against a REAL redis-server. Skipped without
// REDIS_SERVER_BIN / redis-server on PATH; never touches the project's Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { randomUUIDv7 } from "bun";
import { create_call_reservations, user_call_key, type CallReservations } from "@/cache-management/call-reserve";

const BIN = process.env.REDIS_SERVER_BIN || Bun.which("redis-server") || "";
const TTL = 14_400;

let server: Subprocess | null = null;
let client: Redis;
let cr: CallReservations;

describe.skipIf(!BIN)("call reservation on redis-server", () => {
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
    cr = create_call_reservations(client, TTL);
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

  test("free → ok: both keys name the call, with the TTL", async () => {
    const id = randomUUIDv7();
    expect(await cr.reserve("A", "B", id)).toBe("ok");
    expect(await client.get(user_call_key("A"))).toBe(id);
    expect(await client.get(user_call_key("B"))).toBe(id);
    expect(await client.ttl(user_call_key("B"))).toBeGreaterThan(TTL - 5);
  });

  test("caller busy → self_busy and the callee is never touched", async () => {
    await client.set(user_call_key("A"), "older");
    expect(await cr.reserve("A", "B", randomUUIDv7())).toBe("self_busy");
    expect(await client.exists(user_call_key("B"))).toBe(0);
    expect(await client.get(user_call_key("A"))).toBe("older");
  });

  test("callee busy → callee_busy and the caller's key is given back", async () => {
    await client.set(user_call_key("B"), "other");
    expect(await cr.reserve("A", "B", randomUUIDv7())).toBe("callee_busy");
    expect(await client.exists(user_call_key("A"))).toBe(0);
    expect(await client.get(user_call_key("B"))).toBe("other");
  });

  test("the TOCTOU: two callers ring the same callee at once → exactly one call", async () => {
    for (let round = 0; round < 25; round++) {
      await client.flushall();
      const r = await Promise.all([
        cr.reserve("A", "B", randomUUIDv7()),
        cr.reserve("C", "B", randomUUIDv7()),
      ]);
      expect(r.filter((x) => x === "ok").length).toBe(1);
      expect(r.filter((x) => x === "callee_busy").length).toBe(1);
      // the loser holds nothing
      const loser = r[0] === "ok" ? "C" : "A";
      expect(await client.exists(user_call_key(loser))).toBe(0);
    }
  });

  test("glare (A→B and B→A at once): never two calls, never a leaked key", async () => {
    for (let round = 0; round < 25; round++) {
      await client.flushall();
      const ab = randomUUIDv7();
      const ba = randomUUIDv7();
      const r = await Promise.all([cr.reserve("A", "B", ab), cr.reserve("B", "A", ba)]);
      expect(r.filter((x) => x === "ok").length).toBeLessThanOrEqual(1);
      const a = await client.get(user_call_key("A"));
      const b = await client.get(user_call_key("B"));
      if (r.includes("ok")) {
        const id = r[0] === "ok" ? ab : ba;
        expect([a, b]).toEqual([id, id]);
      } else {
        expect([a, b]).toEqual([null, null]);
      }
    }
  });

  test("release is compare-and-delete: a later call's key survives a late cleanup", async () => {
    const old = randomUUIDv7();
    expect(await cr.reserve("A", "B", old)).toBe("ok");
    expect(await cr.release_all(["A", "B"], old)).toBe(2);
    const next = randomUUIDv7();
    expect(await cr.reserve("A", "C", next)).toBe("ok");
    expect(await cr.release("A", old)).toBe(false);
    expect(await client.get(user_call_key("A"))).toBe(next);
    expect(await cr.release_all(["A", null, undefined, "C"], next)).toBe(2);
  });

  test("Redis error on the second SET → the caller's reservation is compensated, the error surfaces", async () => {
    let calls = 0;
    const flaky = new Proxy(client, {
      get(target, prop, recv) {
        if (prop === "set") {
          return (...args: unknown[]) => {
            if (++calls === 2) return Promise.reject(new Error("READONLY"));
            return (target.set as any)(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as Redis;
    const fr = create_call_reservations(flaky, TTL);
    await expect(fr.reserve("A", "B", randomUUIDv7())).rejects.toThrow("READONLY");
    expect(await client.exists(user_call_key("A"))).toBe(0);
  });
});
