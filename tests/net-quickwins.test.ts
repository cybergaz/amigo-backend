// Unit tests for the R0.1 network quick wins (SYNC_V2 §14.5, §14.14, §14.6).
// Pure — no database / Redis / sockets. Run: `bun test tests/`.
import { describe, expect, test } from "bun:test";
import { truncate_client_ip, client_ip_from_headers } from "@/utils/ip.utils";
import {
  CONGESTED_CLOSE_MS,
  KEEPALIVE_BG_MS,
  KEEPALIVE_FG_MS,
  KEEPALIVE_MAX_MS,
  KEEPALIVE_MIN_MS,
  keepalive_decision,
  resolve_keepalive,
} from "@/sockets/keepalive";
import {
  count,
  observe_ms,
  reset_counters,
  snapshot_counters,
} from "@/utils/counters";

describe("truncate_client_ip", () => {
  test("IPv4 → /24", () => {
    expect(truncate_client_ip("203.0.113.77")).toBe("203.0.113.0/24");
    expect(truncate_client_ip(" 10.1.2.3 ")).toBe("10.1.2.0/24");
  });
  test("IPv6 → /48", () => {
    expect(truncate_client_ip("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(truncate_client_ip("2401:4900:1c3a:5f2e:a1b2:c3d4:e5f6:789")).toBe(
      "2401:4900:1c3a::/48",
    );
    expect(truncate_client_ip("::1")).toBe("0:0:0::/48");
    expect(truncate_client_ip("[2001:db8::1]")).toBe("2001:db8:0::/48");
    expect(truncate_client_ip("fe80::1%eth0")).toBe("fe80:0:0::/48");
  });
  test("IPv4-mapped IPv6 is treated as IPv4", () => {
    expect(truncate_client_ip("::ffff:198.51.100.9")).toBe("198.51.100.0/24");
  });
  test("garbage → null", () => {
    expect(truncate_client_ip(undefined)).toBeNull();
    expect(truncate_client_ip("")).toBeNull();
    expect(truncate_client_ip("unknown")).toBeNull();
    expect(truncate_client_ip("300.1.1.1")).toBeNull();
    expect(truncate_client_ip("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(truncate_client_ip("1::2::3")).toBeNull();
  });
});

describe("client_ip_from_headers", () => {
  test("CF-Connecting-IP wins over X-Forwarded-For", () => {
    const h = new Headers({
      "cf-connecting-ip": "198.51.100.9",
      "x-forwarded-for": "198.51.100.9, 172.68.1.1",
      "x-real-ip": "172.68.1.1",
    });
    expect(client_ip_from_headers(h)).toBe("198.51.100.9");
  });
  test("falls back to the first X-Forwarded-For hop, then X-Real-IP", () => {
    expect(
      client_ip_from_headers(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })),
    ).toBe("1.2.3.4");
    expect(client_ip_from_headers(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe(
      "9.9.9.9",
    );
    expect(client_ip_from_headers(new Headers())).toBeNull();
  });
});

describe("resolve_keepalive", () => {
  test("old clients announce nothing → null (connection keeps 20 s)", () => {
    expect(resolve_keepalive({ sender_id: "u", status: "online" })).toBeNull();
    expect(resolve_keepalive(undefined)).toBeNull();
    expect(resolve_keepalive({ mode: "turbo" })).toBeNull();
    expect(resolve_keepalive({ mode: 5 })).toBeNull();
  });
  test("fg / bg defaults", () => {
    expect(resolve_keepalive({ mode: "fg" })).toEqual({ mode: "fg", keepalive_ms: KEEPALIVE_FG_MS });
    expect(resolve_keepalive({ mode: "bg" })).toEqual({ mode: "bg", keepalive_ms: KEEPALIVE_BG_MS });
    expect(resolve_keepalive({ mode: "reliable" })?.keepalive_ms).toBe(KEEPALIVE_BG_MS);
  });
  test("ka_s is clamped to [20 s, 50 s]", () => {
    expect(resolve_keepalive({ mode: "bg", ka_s: 5 })?.keepalive_ms).toBe(KEEPALIVE_MIN_MS);
    expect(resolve_keepalive({ mode: "bg", ka_s: 600 })?.keepalive_ms).toBe(KEEPALIVE_MAX_MS);
    expect(resolve_keepalive({ mode: "bg", ka_s: 30 })?.keepalive_ms).toBe(30_000);
    expect(resolve_keepalive({ mode: "bg", ka_s: Number.NaN })?.keepalive_ms).toBe(KEEPALIVE_BG_MS);
  });
});

// Simulate the server tick against a silent client and against a chatty one.
type Conn = Parameters<typeof keepalive_decision>[0];
const run_ticks = (
  conn: Conn,
  from: number,
  to: number,
  tick: number,
  on_inbound?: (now: number) => boolean,
) => {
  const events: { t: number; d: string }[] = [];
  for (let now = from; now <= to; now += tick) {
    if (on_inbound?.(now)) {
      conn.missed_pings = 0;
      conn.last_inbound_at = now;
    }
    const d = keepalive_decision(conn, now);
    if (d === "skip") conn.last_keepalive_at = now;
    if (d === "ping") {
      conn.last_ping_at = now;
      conn.last_keepalive_at = now;
      conn.missed_pings++;
    }
    if (d !== "wait") events.push({ t: now, d });
    if (d === "stale" || d === "congested") break;
  }
  return events;
};

describe("keepalive_decision", () => {
  test("silent fg client: ping at ~20 s, ~40 s, evicted at ~60 s", () => {
    const conn: Conn = {
      missed_pings: 0,
      last_inbound_at: 0,
      last_keepalive_at: 0,
      keepalive_ms: KEEPALIVE_FG_MS,
    };
    const ev = run_ticks(conn, 5_000, 120_000, 5_000);
    expect(ev).toEqual([
      { t: 20_000, d: "ping" },
      { t: 40_000, d: "ping" },
      { t: 60_000, d: "stale" },
    ]);
  });

  test("silent bg client: pings every 45 s, evicted at 135 s", () => {
    const conn: Conn = {
      missed_pings: 0,
      last_inbound_at: 0,
      last_keepalive_at: 0,
      keepalive_ms: KEEPALIVE_BG_MS,
    };
    const ev = run_ticks(conn, 5_000, 300_000, 5_000);
    expect(ev.map((e) => e.d)).toEqual(["ping", "ping", "stale"]);
    expect(ev[2].t).toBe(135_000);
  });

  test("client answering pings is never evicted", () => {
    const conn: Conn = {
      missed_pings: 0,
      last_inbound_at: 0,
      last_keepalive_at: 0,
      keepalive_ms: KEEPALIVE_FG_MS,
    };
    // Pong lands 5 s after each server ping.
    const ev = run_ticks(conn, 5_000, 600_000, 5_000, (now) =>
      conn.last_ping_at !== undefined && now - conn.last_ping_at === 5_000,
    );
    expect(ev.some((e) => e.d === "stale")).toBe(false);
    expect(ev.filter((e) => e.d === "ping").length).toBeGreaterThan(10);
  });

  test("chatty client (frame every 12 s): no server pings, skips counted once per interval", () => {
    const conn: Conn = {
      missed_pings: 0,
      last_inbound_at: 0,
      last_keepalive_at: 0,
      keepalive_ms: KEEPALIVE_FG_MS,
    };
    const ev = run_ticks(conn, 1_000, 600_000, 1_000, (now) => now % 12_000 === 0);
    expect(ev.some((e) => e.d === "ping" || e.d === "stale")).toBe(false);
    const skips = ev.filter((e) => e.d === "skip");
    expect(skips.length).toBeGreaterThanOrEqual(28);
    expect(skips.length).toBeLessThanOrEqual(31);
  });

  test("an interval change never evicts an unprobed socket", () => {
    // bg socket idle for 61 s, then announced fg (20 s): must ping first.
    const conn: Conn = {
      missed_pings: 0,
      last_inbound_at: 0,
      last_keepalive_at: 0,
      keepalive_ms: KEEPALIVE_FG_MS,
    };
    expect(keepalive_decision(conn, 61_000)).toBe("ping");
  });

  test("congested for 30 s → congested; drained in time → not", () => {
    const base: Conn = {
      missed_pings: 0,
      last_inbound_at: 0,
      last_keepalive_at: 0,
      keepalive_ms: KEEPALIVE_FG_MS,
    };
    expect(keepalive_decision({ ...base, congested_since: 1_000 }, 1_000 + CONGESTED_CLOSE_MS)).toBe(
      "congested",
    );
    expect(keepalive_decision({ ...base, congested_since: 1_000 }, 1_000 + CONGESTED_CLOSE_MS - 1)).not.toBe(
      "congested",
    );
  });

  test("a dropped frame → congested on the next tick, even after drain", () => {
    const base: Conn = {
      missed_pings: 0,
      last_inbound_at: 1_000,
      last_keepalive_at: 1_000,
      keepalive_ms: KEEPALIVE_FG_MS,
    };
    // congested_since cleared by drain; dropped_at survives it.
    expect(keepalive_decision({ ...base, dropped_at: 1_500 }, 2_000)).toBe("congested");
  });
});

describe("counters", () => {
  test("count + observe_ms snapshot, reset", () => {
    reset_counters();
    count("WS", "opens");
    count("WS", "opens");
    count("WS", "close_code_1006");
    count("FCM", "priority_normal", 3);
    observe_ms("WS", "open_ms", 10);
    observe_ms("WS", "open_ms", 30);
    observe_ms("WS", "open_ms", Number.NaN); // ignored
    const snap = snapshot_counters();
    expect(snap.WS).toEqual({
      opens: 2,
      close_code_1006: 1,
      open_ms_n: 2,
      open_ms_avg: 20,
      open_ms_max: 30,
    });
    expect(snap.FCM).toEqual({ priority_normal: 3 });
    reset_counters();
    expect(snapshot_counters()).toEqual({});
  });
});
