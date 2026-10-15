// R1b delivery + ops (SYNC_V2 §3.13, §14.13, §14.14, F "FCM fallback"):
//   - the FCM ack-fallback wheel (pure core with fake I/O): ack before the
//     deadline, the deadline, drain, big-group batching, every skip rule;
//   - its pending-store check against a real redis-server (the RC-3 drain
//     Lua writes the tombstones it must read as "acked");
//   - §3.13 derivable-event rules, the recent-holder set;
//   - beacon shape checks, FCM health helpers, the new flags' safe defaults.
// Redis parts are skipped without REDIS_SERVER_BIN / redis-server on PATH;
// nothing here touches the project's Redis or Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import type { WSMessage, VitalWSMessage } from "@/types/socket.types";
import {
  ACK_FALLBACK_DEFAULT_MS,
  MESSAGE_NEW_FRAME_PREFIX,
  acked_message_id,
  clamp_delay_ms,
  create_ack_fallback,
  create_pending_checker,
  create_v2_aware_checker,
  fallback_eligible,
  type AckFallbackDeps,
  type LocalConn,
} from "@/services/fcm-ack-fallback-core";
import { create_pending_redis, encode_entry, redis_entries_key } from "@/cache-management/pending-store-core";
import { RecentSet, is_derivable_for_v2 } from "@/services/sync/pending-suppress-core";
import { BEACON_MAX_BYTES, decode_queued, encode_queued, parse_beacon_body, validate_beacon } from "@/services/net-beacon-core";
import {
  DEFAULT_SYNC_V2_FLAGS,
  net_beacon_active,
  parse_sync_v2_flags,
  pending_suppression_active,
} from "@/services/sync/flags-core";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";
import * as health from "@/services/fcm-health-core";

const BIN = process.env.REDIS_SERVER_BIN || Bun.which("redis-server") || "";

const SENDER = "00000000-0000-7000-8000-000000000001";
const CHAT = "00000000-0000-7000-8000-0000000000c1";
const uid = (i: number) => `00000000-0000-7000-8000-${String(1000 + i).padStart(12, "0")}`;
const mid = (i: number) => `0199aaaa-0000-7000-8000-${String(i).padStart(12, "0")}`;

const msg_new = (id: string, extra: Record<string, unknown> = {}): WSMessage => ({
  type: "message:new",
  payload: { id, conv_id: CHAT, sender_id: SENDER, msg_type: "text", body: "hi", ...extra } as any,
  ws_timestamp: new Date("2026-10-15T00:00:00Z"),
});

// Fake world for the core: a clock, sockets, the pending store, tokens, live ids.
const world = (over: Partial<AckFallbackDeps> = {}) => {
  let t = 1_000_000;
  const conns = new Map<string, NonNullable<LocalConn>>();
  const counters = new Map<string, number>();
  const sent: { uid: string; id: string; silent: boolean }[] = [];
  const pending = new Set<string>(); // `${uid}|${id}` still stored
  const tokens = new Set<string>();
  const live = new Set<string>();
  const muted = new Set<string>();
  let enabled = true;
  const deps: AckFallbackDeps = {
    enabled: () => enabled,
    delay_ms: ACK_FALLBACK_DEFAULT_MS,
    local_conn: (u) => conns.get(u) ?? null,
    still_pending: async (items) => items.map((it) => pending.has(`${it.uid}|${it.msg_id}`)),
    with_token: async (uids) => new Set(uids.filter((u) => tokens.has(u))),
    live_ids: async (ids) => new Set(ids.filter((i) => live.has(i)).map((i) => i.toLowerCase())),
    muted: async () => muted,
    send: (u, m, o) => sent.push({ uid: u, id: (m.payload as any).id, silent: o.silent }),
    count: (name, n = 1) => counters.set(name, (counters.get(name) ?? 0) + n),
    now: () => t,
    ...over,
  };
  const fb = create_ack_fallback(deps);
  // A recipient on a foreground socket here, stored, with a token.
  const online = (u: string, ids: string[] = []) => {
    conns.set(u, { background: false, last_inbound_at: 0 });
    tokens.add(u);
    for (const id of ids) pending.add(`${u}|${id}`);
  };
  return {
    fb, deps, conns, counters, sent, pending, tokens, live, muted, online,
    advance: (ms: number) => { t += ms; },
    now: () => t,
    set_enabled: (v: boolean) => { enabled = v; },
    c: (name: string) => counters.get(`ack_fallback_${name}`) ?? 0,
  };
};

const settle = async (p: Promise<void> | null) => {
  if (p) await p;
};

describe("ack fallback wheel (core)", () => {
  test("an ack before the deadline cancels; an unacked recipient gets exactly one push after it", async () => {
    const w = world();
    const id = mid(1);
    w.live.add(id);
    w.online(uid(1), [id]);
    w.online(uid(2), [id]);
    expect(w.fb.arm([uid(1), uid(2)], msg_new(id))).toBe(2);
    expect(w.fb.stats().pending).toBe(2);

    w.advance(1_000);
    // uid(1) acks over its socket: the pending store drains its key.
    w.fb.note_drained(uid(1), [`${uid(1)}:message:new:${id}`, `${uid(1)}:message:sent:ack:${id}`]);
    w.pending.delete(`${uid(1)}|${id}`);
    expect(w.c("acked")).toBe(1);

    w.advance(ACK_FALLBACK_DEFAULT_MS - 2_000); // 9 s: not due yet
    expect(w.fb.tick()).toBeNull();
    expect(w.sent.length).toBe(0);

    w.advance(1_500); // past 10 s
    await settle(w.fb.tick());
    expect(w.sent).toEqual([{ uid: uid(2), id, silent: false }]);
    expect(w.c("sent")).toBe(1);
    expect(w.fb.stats().pending).toBe(0);
    w.advance(5_000);
    expect(w.fb.tick()).toBeNull(); // nothing fires twice
  });

  test("arms only foreground sockets here; never the sender; system rows and stubs never arm", () => {
    const w = world();
    const id = mid(2);
    w.online(uid(1));
    w.conns.set(uid(2), { background: true }); // already pushed by the fan-out
    w.online(SENDER);
    expect(w.fb.arm([uid(1), uid(2), uid(3) /* no socket here */, SENDER], msg_new(id))).toBe(1);
    expect(w.fb.arm([uid(1)], msg_new(mid(3), { msg_type: "system" }))).toBe(0);
    expect(w.fb.arm([uid(1)], msg_new(mid(4), { system_actor: true }))).toBe(0);
    expect(w.fb.arm([uid(1)], msg_new(mid(5), { partial: true }))).toBe(0);
    expect(w.c("skipped_system")).toBe(3);
    expect(w.fb.arm([uid(1)], { type: "message:pin", payload: {} as any, ws_timestamp: new Date() })).toBe(0);
    expect(fallback_eligible(null)).toEqual({ skip: "type" });
  });

  test("flag off: nothing arms; flipped off before the deadline → due entries are dropped, not pushed", async () => {
    const w = world();
    w.online(uid(1), [mid(6)]);
    w.set_enabled(false);
    expect(w.fb.arm([uid(1)], msg_new(mid(6)))).toBe(0);
    w.set_enabled(true);
    expect(w.fb.arm([uid(1)], msg_new(mid(6)))).toBe(1);
    w.set_enabled(false);
    w.advance(11_000);
    await settle(w.fb.tick());
    expect(w.sent.length).toBe(0);
    expect(w.c("skipped_off")).toBe(1);
  });

  test("skip rules at the deadline: alive foreground, acked elsewhere, no token, deleted; muted → silent", async () => {
    const w = world();
    const id = mid(7);
    w.live.add(id);
    for (let i = 1; i <= 6; i++) w.online(uid(i), [id]);
    w.fb.arm([1, 2, 3, 4, 5, 6].map(uid), msg_new(id));
    w.advance(3_000);
    w.conns.get(uid(1))!.last_inbound_at = w.now(); // talked to us after the send
    w.conns.get(uid(2))!.background = true; // went to background without acking → push
    w.conns.delete(uid(3)); // socket gone here (moved / closed) → push
    w.pending.delete(`${uid(4)}|${id}`); // acked on another worker (REST / reconnect)
    w.tokens.delete(uid(5));
    w.muted.add(uid(6));
    w.advance(8_000);
    await settle(w.fb.tick());
    expect(w.c("skipped_alive")).toBe(1);
    expect(w.c("skipped_acked")).toBe(1);
    expect(w.c("skipped_no_token")).toBe(1);
    expect(w.sent.map((s) => s.uid).sort()).toEqual([uid(2), uid(3), uid(6)].sort());
    expect(w.sent.find((s) => s.uid === uid(6))!.silent).toBe(true);

    // deleted / expired since the send → never pushed
    const w2 = world();
    w2.online(uid(1), [mid(8)]);
    w2.fb.arm([uid(1)], msg_new(mid(8)));
    w2.advance(11_000);
    await settle(w2.fb.tick());
    expect(w2.sent.length).toBe(0);
    expect(w2.c("skipped_deleted")).toBe(1);
  });

  test("lookups that fail open: pending check / live check errors still push (client dedups by id)", async () => {
    const w = world({
      still_pending: async () => null,
      live_ids: async () => { throw new Error("pg down"); },
    });
    w.online(uid(1));
    w.fb.arm([uid(1)], msg_new(mid(9)));
    w.advance(11_000);
    await settle(w.fb.tick());
    expect(w.sent.length).toBe(1);
    expect(w.c("check_failed")).toBe(1);
    expect(w.c("live_check_failed")).toBe(1);
  });

  test("big group: one batch per message (not a timer per recipient), fired in capped ticks, in order", async () => {
    const w = world({ max_fire_per_tick: 300 });
    const N = 1_000;
    const recips = Array.from({ length: N }, (_, i) => uid(i));
    for (let m = 0; m < 3; m++) {
      const id = mid(100 + m);
      w.live.add(id);
      for (const r of recips) w.online(r, [id]);
      expect(w.fb.arm(recips, msg_new(id))).toBe(N);
      w.advance(10);
    }
    expect(w.fb.stats()).toMatchObject({ pending: 3 * N, batches: 3 });
    // half the group acks the first message
    for (let i = 0; i < N / 2; i++) {
      w.fb.note_drained(uid(i), [`${uid(i)}:message:new:${mid(100)}`]);
      w.pending.delete(`${uid(i)}|${mid(100)}`);
    }
    expect(w.fb.stats().pending).toBe(3 * N - N / 2);
    w.advance(ACK_FALLBACK_DEFAULT_MS);
    let ticks = 0;
    while (w.fb.stats().pending > 0 && ticks < 50) {
      await settle(w.fb.tick());
      ticks++;
    }
    expect(w.sent.length).toBe(3 * N - N / 2);
    expect(ticks).toBe(Math.ceil((3 * N - N / 2) / 300));
    // the first message's pushes went out before the second's
    const first_of_second = w.sent.findIndex((s) => s.id === mid(101));
    expect(w.sent.slice(0, first_of_second).every((s) => s.id === mid(100))).toBe(true);
  });

  test("drain drops everything waiting (counted) and stops arming", async () => {
    const w = world();
    w.online(uid(1));
    w.online(uid(2));
    w.fb.arm([uid(1), uid(2)], msg_new(mid(10)));
    expect(w.fb.drop()).toBe(2);
    expect(w.c("dropped")).toBe(2);
    expect(w.fb.arm([uid(1)], msg_new(mid(11)))).toBe(0);
    w.advance(20_000);
    expect(w.fb.tick()).toBeNull();
    expect(w.sent.length).toBe(0);
    w.fb.resume(); // a restart arms again
    expect(w.fb.arm([uid(1)], msg_new(mid(11)))).toBe(1);
  });

  test("probe: a silent foreground socket is pinged at the deadline; a pong suppresses, silence pushes", async () => {
    const probed: string[] = [];
    const w = world({ probe: (u) => (probed.push(u), true), probe_ms: 3_000 });
    const id = mid(20);
    w.live.add(id);
    w.online(uid(1), [id]); // live, reading, ack withheld by the debounce
    w.online(uid(2), [id]); // frozen socket
    w.fb.arm([uid(1), uid(2)], msg_new(id));
    w.advance(11_000);
    await settle(w.fb.tick());
    expect(probed.sort()).toEqual([uid(1), uid(2)].sort());
    expect(w.c("probed")).toBe(2);
    expect(w.sent.length).toBe(0);
    w.advance(500);
    w.conns.get(uid(1))!.last_inbound_at = w.now(); // socket:pong
    w.advance(1_000);
    expect(w.fb.tick()).toBeNull(); // probe window not over
    w.advance(2_000);
    await settle(w.fb.tick());
    expect(w.sent.map((x) => x.uid)).toEqual([uid(2)]);
    expect(w.c("skipped_alive")).toBe(1);
    expect(probed.length).toBe(2); // never probed twice
    // an ack while probing cancels it
    const id2 = mid(21);
    w.online(uid(3), [id2]);
    w.fb.arm([uid(3)], msg_new(id2));
    w.advance(11_000);
    await settle(w.fb.tick());
    expect(w.fb.stats().probing).toBe(1);
    w.fb.note_drained(uid(3), [`${uid(3)}:message:new:${id2}`]);
    expect(w.fb.stats().probing).toBe(0);
    w.advance(5_000);
    expect(w.fb.tick()).toBeNull();
  });

  test("drain: fire_all pushes what is still armed or probing (no probe), once, and stops arming", async () => {
    const probed: string[] = [];
    const w = world({ probe: (u) => (probed.push(u), true) });
    const id = mid(22);
    w.live.add(id);
    w.online(uid(1), [id]);
    w.online(uid(2), [id]);
    w.online(uid(3), [id]);
    w.fb.arm([uid(1), uid(2), uid(3)], msg_new(id));
    w.advance(11_000);
    await settle(w.fb.tick()); // all three probing
    w.fb.arm([uid(4)], msg_new(id)); // not due yet
    w.online(uid(4), [id]);
    w.fb.arm([uid(4)], msg_new(id));
    w.pending.delete(`${uid(2)}|${id}`); // reconnected to a sibling and acked there
    for (const u of [uid(1), uid(2), uid(3), uid(4)]) w.conns.delete(u); // sockets closed (1012)
    await w.fb.fire_all();
    expect(w.sent.map((x) => x.uid).sort()).toEqual([uid(1), uid(3), uid(4)].sort());
    expect(probed.length).toBe(3);
    expect(w.fb.arm([uid(5)], msg_new(mid(23)))).toBe(0);
    w.advance(20_000);
    expect(w.fb.tick()).toBeNull();
    expect(w.sent.length).toBe(3);
  });

  test("v2-aware check: a lease holder's missing entry is judged by delivered_seq, not read as acked", async () => {
    const calls: { conv: string; seq: number; uids: string[] }[] = [];
    const counters = new Map<string, number>();
    const check = create_v2_aware_checker({
      pending: async (items) => items.map((it) => it.uid === uid(1)), // only uid(1) still stored
      leases: async (uids) => new Set(uids.filter((u) => u !== uid(4))), // uid(4): legacy client
      delivered: async (conv, seq, uids) => {
        calls.push({ conv, seq, uids });
        return new Set([uid(2)]);
      },
      count: (n, k = 1) => counters.set(n, (counters.get(n) ?? 0) + k),
    });
    const r = await check([
      { uid: uid(1), msg_id: "a", conv_id: CHAT, seq: 7 },
      { uid: uid(2), msg_id: "a", conv_id: CHAT, seq: 7 }, // delivered_seq ≥ 7 → acked
      { uid: uid(3), msg_id: "a", conv_id: CHAT, seq: 7 }, // suppressed, not delivered → push
      { uid: uid(4), msg_id: "a", conv_id: CHAT, seq: 7 }, // no lease: missing = acked
      { uid: uid(5), msg_id: "b", conv_id: CHAT, seq: null }, // no seq → push
    ]);
    expect(r).toEqual([true, false, true, false, true]);
    expect(calls).toEqual([{ conv: CHAT, seq: 7, uids: [uid(2), uid(3)] }]);
    expect(counters.get("ack_fallback_v2_acked")).toBe(1);
    expect(counters.get("ack_fallback_v2_unacked")).toBe(2);
    // flag off (no holders): exactly the store's answer, no delivered lookup
    const plain = create_v2_aware_checker({
      pending: async (items) => items.map(() => false),
      leases: async () => new Set(),
      delivered: async () => { throw new Error("must not run"); },
      count: () => { },
    });
    expect(await plain([{ uid: uid(1), msg_id: "a", conv_id: CHAT, seq: 1 }])).toEqual([false]);
    expect(fallback_eligible(msg_new(mid(1), { seq: 9 }))).toMatchObject({ seq: 9 });
  });

  test("memory bound: past max_entries new recipients are not armed (counted)", () => {
    const w = world({ max_entries: 5 });
    const recips = Array.from({ length: 8 }, (_, i) => uid(i));
    for (const r of recips) w.online(r);
    expect(w.fb.arm(recips, msg_new(mid(12)))).toBe(5);
    expect(w.c("skipped_overflow")).toBe(3);
  });

  test("inbox path parses only message:new frames; re-arming one message joins its batch", () => {
    const w = world();
    w.online(uid(1));
    w.online(uid(2));
    const frame = JSON.stringify(msg_new(mid(13)));
    expect(frame.startsWith(MESSAGE_NEW_FRAME_PREFIX)).toBe(true);
    expect(w.fb.arm_frame([uid(1)], frame)).toBe(1);
    expect(w.fb.arm_frame([uid(2)], frame)).toBe(1);
    expect(w.fb.stats().batches).toBe(1);
    expect(w.fb.arm_frame([uid(1)], JSON.stringify({ type: "message:pin", payload: {} }))).toBe(0);
    expect(w.fb.arm_frame([uid(1)], `${MESSAGE_NEW_FRAME_PREFIX},broken`)).toBe(0);
    // an ack in a different letter case still matches
    expect(w.fb.ack(uid(1), mid(13).toUpperCase())).toBe(true);
  });

  test("helpers", () => {
    expect(acked_message_id(uid(1), `${uid(1)}:message:new:${mid(1)}`)).toBe(mid(1));
    expect(acked_message_id(uid(1), `${uid(2)}:message:new:${mid(1)}`)).toBeNull();
    expect(acked_message_id(uid(1), `${uid(1)}:message:sent:ack:${mid(1)}`)).toBeNull();
    expect(clamp_delay_ms(undefined)).toBe(10_000);
    expect(clamp_delay_ms("500")).toBe(3_000);
    expect(clamp_delay_ms("999999")).toBe(120_000);
    expect(clamp_delay_ms("15000")).toBe(15_000);
  });
});

describe("§3.13 suppression rules", () => {
  const m = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload, ws_timestamp: new Date() }) as unknown as VitalWSMessage;
  test("derivable events only", () => {
    expect(is_derivable_for_v2(m("message:new", { id: "x", seq: 12 }))).toBe(true);
    expect(is_derivable_for_v2(m("message:new", { id: "x" }))).toBe(false); // no seq: not a numbered row
    expect(is_derivable_for_v2(m("message:sent:ack", { is_sent: true }))).toBe(true);
    expect(is_derivable_for_v2(m("message:sent:ack", { is_sent: false, error_code: 403 }))).toBe(false);
    for (const t of ["message:status:ack", "conversation:join", "conversation:mark_read", "message:pin", "message:delete"]) {
      expect(is_derivable_for_v2(m(t))).toBe(true);
    }
    expect(is_derivable_for_v2(m("conversation:action", { system_message: { id: "s", seq: 3 } }))).toBe(true);
    expect(is_derivable_for_v2(m("conversation:action", { action: "join_request" }))).toBe(false);
    for (const t of ["conversation:new", "user:update", "auth:force_logout", "message:react", "message:forward", "conversation:disappearing"]) {
      expect(is_derivable_for_v2(m(t))).toBe(false);
    }
  });

  test("RecentSet: TTL and bound", () => {
    const s = new RecentSet(1_000, 2);
    s.add("a", 0);
    expect(s.has("a", 500)).toBe(true);
    expect(s.has("a", 1_000)).toBe(false);
    s.add("a", 0); s.add("b", 0); s.add("c", 0);
    expect(s.size()).toBe(2);
    expect(s.has("a", 1)).toBe(false); // oldest evicted
  });
});

describe("flags: safe defaults", () => {
  test("everything new is off by default", () => {
    expect(DEFAULT_SYNC_V2_FLAGS.ack_fallback).toBe(false);
    expect(DEFAULT_SYNC_V2_FLAGS.net_telemetry).toBe(false);
    expect(DEFAULT_SYNC_V2_FLAGS.markers.net_beacons).toBe(false);
    const empty = parse_sync_v2_flags([]);
    expect(empty.ack_fallback || empty.net_telemetry || empty.markers.net_beacons).toBe(false);
    expect(pending_suppression_active(empty)).toBe(false);
    expect(net_beacon_active(empty)).toBe(false);
  });

  test("suppression needs mode on AND the proto lease; beacons need telemetry AND the table", () => {
    const f = parse_sync_v2_flags([
      { key: SYNC_V2_KEYS.mode, value: "on" },
      { key: SYNC_V2_KEYS.ack_fallback, value: "on" },
      { key: SYNC_V2_KEYS.net_telemetry, value: "on" },
    ]);
    expect(f.ack_fallback && f.net_telemetry).toBe(true);
    expect(pending_suppression_active(f)).toBe(false);
    expect(pending_suppression_active({ ...f, proto_lease: true })).toBe(true);
    expect(pending_suppression_active({ ...f, mode: "shadow", proto_lease: true })).toBe(false);
    expect(net_beacon_active(f)).toBe(false);
    expect(net_beacon_active({ ...f, markers: { ...f.markers, net_beacons: true } })).toBe(true);
  });
});

describe("beacon shape (§14.14)", () => {
  const good = {
    v: 1, app: "4.3.0+50", os: "android 13", oem: "xiaomi", window_s: 900,
    rtt: { p50: 120, p90: 480 }, carrier: { ws: 600, lp: 200 },
    ws: { attempts: 4, fail: { timeout: 2 }, close: { "1006": 1 } },
    fcm: { token: "dGhpcyBpcyBhIHRva2Vu", rx: 3 },
    net: { k1: { s: 900, validated: false } },
  };
  test("accepts the documented shape; a token string is reduced to a boolean", () => {
    const v = validate_beacon(good);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.app_ver).toBe("4.3.0+50");
      expect((v.payload.fcm as any).token).toBe(true);
      expect(JSON.stringify(v.payload)).not.toContain("dGhpcyBpcyBhIHRva2Vu");
    }
  });
  test("refuses junk", () => {
    expect(parse_beacon_body("nope")).toEqual({ ok: false, reason: "bad_json" });
    expect(validate_beacon([1])).toMatchObject({ ok: false, reason: "not_an_object" });
    expect(validate_beacon({ os: "x" })).toMatchObject({ ok: false, reason: "bad_app" });
    expect(validate_beacon({ app: "1", a: { b: { c: { d: { e: 1 } } } } })).toMatchObject({ ok: false, reason: "too_deep" });
    expect(validate_beacon({ app: "1", s: "x".repeat(201) })).toMatchObject({ ok: false, reason: "string_too_long" });
    expect(validate_beacon({ app: "1", n: Infinity })).toMatchObject({ ok: false, reason: "bad_number" });
    expect(parse_beacon_body(JSON.stringify({ app: "1", pad: "x".repeat(150) + "y" }).padEnd(BEACON_MAX_BYTES + 1, " ")))
      .toMatchObject({ ok: false, reason: "too_large" });
  });
  test("queue items round-trip; corrupt ones are dropped", () => {
    const item = { u: uid(1), t: 1_760_000_000_000, ip: "1.2.3.0/24", av: "4.3.0", p: { app: "4.3.0" } };
    expect(decode_queued(encode_queued(item))).toEqual(item);
    expect(decode_queued("{")).toBeNull();
    expect(decode_queued(JSON.stringify({ ...item, u: "not-a-uuid" }))).toBeNull();
  });
});

describe("FCM health helpers (§14.13)", () => {
  test("day keys, ratio, fast window, message:new count", () => {
    const h = health;
    expect(h.utc_day(Date.UTC(2026, 9, 15, 23, 59))).toBe("20261015");
    expect(h.last_days(3, Date.UTC(2026, 9, 1, 12))).toEqual(["20261001", "20260930", "20260929"]);
    expect(h.fcm_health_ratio(0, 0)).toBeNull();
    expect(h.fcm_health_ratio(10, 4)).toBe(0.4);
    expect(h.fcm_health_ratio(3, 5)).toBe(1);
    const now = Date.now();
    expect(h.is_fast_receipt(new Date(now - 60_000), now)).toBe(true);
    expect(h.is_fast_receipt(new Date(now - 3 * 60_000), now)).toBe(false);
    expect(h.is_fast_receipt(null, now)).toBe(false);
    expect(h.count_message_new([
      msg_new(mid(1)),
      msg_new(mid(2), { msg_type: "system" }),
      { type: "message:delete", payload: {} as any, ws_timestamp: new Date() },
    ])).toBe(1);
  });
});

let server: Subprocess | null = null;
let client: Redis;

describe.skipIf(!BIN)("ack fallback pending check on redis-server", () => {
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
      client.disconnect();
    } catch { }
    server?.kill();
  });

  test("stored → pending; drained (plain or tombstoned) → acked; another user's key → not pending", async () => {
    const check = create_pending_checker(client);
    const store = create_pending_redis(client);
    const U1 = uid(1), U2 = uid(2), M = mid(20), M2 = mid(21);
    const put = async (u: string, id: string) => {
      const key = `${u}:message:new:${id}`;
      const v = Bun.randomUUIDv7();
      await client.hset(redis_entries_key(u), key, encode_entry({ v, message_id: key, ws_message: msg_new(id) as any, created_at: Date.now() }));
      return key;
    };
    const k1 = await put(U1, M);
    const k2 = await put(U2, M);
    await put(U1, M2);
    expect(await check([{ uid: U1, msg_id: M }, { uid: U2, msg_id: M }, { uid: U1, msg_id: M2 }])).toEqual([true, true, true]);

    // U1's ack drains with a tombstone (routing shadow / on), U2's without.
    await store.drain([{ user_id: U1, items: [{ key: k1 }], tomb: true }]);
    await store.drain([{ user_id: U2, items: [{ key: k2 }], tomb: false }]);
    expect((await client.hget(redis_entries_key(U1), k1))?.startsWith("~")).toBe(true);
    expect(await check([{ uid: U1, msg_id: M }, { uid: U2, msg_id: M }, { uid: U1, msg_id: M2 }])).toEqual([false, false, true]);
    expect(await check([{ uid: uid(9), msg_id: M2 }])).toEqual([false]);

    // chunking: more items than one pipeline chunk
    const many = Array.from({ length: 1_200 }, (_, i) => ({ uid: U1, msg_id: i % 2 ? M2 : M }));
    const res = await create_pending_checker(client, undefined, 500)(many);
    expect(res!.length).toBe(1_200);
    expect(res!.filter(Boolean).length).toBe(600);
  });

  test("a Redis error → null (the caller pushes)", async () => {
    const broken = { pipeline: () => ({ hget() { return this; }, exec: async () => { throw new Error("down"); } }) } as any;
    expect(await create_pending_checker(broken)([{ uid: uid(1), msg_id: mid(1) }])).toBeNull();
  });
});
