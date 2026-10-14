// Unit tests for the RC-1 lifecycle core (SYNC_V2 §13.3, §13.9).
// Pure — no database / Redis / sockets / signals. Run: `bun test tests/rc1-lifecycle.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  await_tracked,
  drain_sleep,
  track,
  tracked_count,
} from "@/cluster/lifecycle";
import {
  BOOT_ID,
  CLUSTER_MAX,
  DB_FINGERPRINT,
  GIT_REV,
  INSTANCE_ID,
  REDIS_NS,
  SLOT_ID,
  WORKER_ID,
} from "@/cluster/identity";

describe("identity", () => {
  test("worker id is slot + 8-hex boot id", () => {
    expect(BOOT_ID).toMatch(/^[0-9a-f]{8}$/);
    expect(WORKER_ID).toBe(`${SLOT_ID}:${BOOT_ID}`);
    expect(SLOT_ID.endsWith(`:${INSTANCE_ID}`)).toBe(true);
  });
  test("namespace, fingerprint, rev, cluster max are sane", () => {
    expect(REDIS_NS).toMatch(/^[a-z0-9]{1,8}$/i);
    expect(DB_FINGERPRINT).toMatch(/^[0-9a-f]{8}$/);
    expect(GIT_REV.length).toBeGreaterThan(0);
    expect(CLUSTER_MAX).toBeGreaterThanOrEqual(1);
  });
});

describe("tracked work", () => {
  test("await_tracked waits for tracked promises and reports leftovers", async () => {
    let resolve_a!: () => void;
    const a = new Promise<void>((r) => (resolve_a = r));
    track(a);
    track(Promise.reject(new Error("x"))).catch(() => { });
    expect(tracked_count()).toBeGreaterThanOrEqual(1);
    setTimeout(resolve_a, 20);
    expect(await await_tracked(1_000)).toBe(0);
  });

  test("await_tracked gives up at its budget", async () => {
    const never = new Promise<void>(() => { });
    track(never);
    const t0 = Date.now();
    const left = await await_tracked(60);
    expect(left).toBeGreaterThanOrEqual(1);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("drain_sleep", () => {
  test("sleeps roughly the requested time", async () => {
    const t0 = Date.now();
    await drain_sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
  test("zero / negative resolves immediately", async () => {
    await drain_sleep(0);
    await drain_sleep(-5);
  });
});
