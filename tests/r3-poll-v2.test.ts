// R3 poll v2 (SYNC_V2 §3.11, §13.17, §14.9): request parsing, the versioned
// pending plan (F's ret_v1 holds reused), inline delta attestation, the
// waiter registry (wake / coalesce / timeout / supersede / drain, fake
// clock), and — against a REAL redis-server — nudge fan-in and supersede
// across two in-process "workers" through their inboxes, plus versioned ack
// races on RC-3's Lua drain. The one-statement poll SQL runs on the PGlite
// harness (scratchpad pglite/pollv2.ts). Redis parts need REDIS_SERVER_BIN
// (or redis-server on PATH) and never touch the project's Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { randomUUIDv7 } from "bun";
import {
  POLL_ACK_MAX,
  POLL_MAX_WAIT_S,
  POLL_WAKE_RETRY_MAX_MS,
  POLL_WATCH_MAX,
  acked_versions,
  chat_of_frame,
  finalize_poll_deltas,
  has_news,
  normalize_etag,
  parse_poll_request,
  plan_pending_v2,
  wake_retry_ms,
  type PendingEntryLike,
  type PollDeltaRaw,
} from "@/services/sync/poll-core";
import { TAIL_GAP } from "@/services/sync/read-core";
import {
  RESEND_EXPIRY_MS,
  format_return_meta,
  parse_return_meta,
  type ReturnMeta,
} from "@/utils/poll-ack-drain.utils";
import {
  WaiterRegistry,
  apply_poll_inbox,
  create_waiter_redis,
  remote_waiters_by_wid,
  type Clock,
  type WakeReason,
} from "@/cache-management/sync-nudge-core";
import {
  decode_inbox,
  encode_nudge,
  encode_supersede,
  lease_seen_ms,
  poll_lease_verdict,
} from "@/cluster/router-core";
import { create_presence } from "@/cluster/presence-store";
import { k } from "@/cluster/keys";
import {
  create_pending_redis,
  encode_entry,
  parse_value,
  redis_entries_key,
  redis_return_meta_key,
  type PendingRedis,
} from "@/cache-management/pending-store-core";

const BIN = process.env.REDIS_SERVER_BIN || Bun.which("redis-server") || "";
const U = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";

// ── request parsing ──────────────────────────────────────────────────────────

describe("parse_poll_request", () => {
  const base = { req_id: "r-1" };

  test("defaults and clamps", () => {
    const r = parse_poll_request(base);
    expect(r.ok && r.value).toEqual({
      req_id: "r-1", wait_s: POLL_MAX_WAIT_S, heads_etag: null, raw_bg: undefined,
      last_resp_ver: null, watch: [], ack: [], stubs_after: null,
    });
    const w = parse_poll_request({ ...base, wait: 90 });
    expect(w.ok && w.value.wait_s).toBe(POLL_MAX_WAIT_S);
    const w0 = parse_poll_request({ ...base, wait: 0 });
    expect(w0.ok && w0.value.wait_s).toBe(0);
    expect(parse_poll_request({ ...base, wait: 7.9 }).ok && (parse_poll_request({ ...base, wait: 7.9 }) as any).value.wait_s).toBe(7);
  });

  test("fg maps to the poll lease's bg flag; etag is normalised", () => {
    const fg = parse_poll_request({ ...base, fg: true, heads_etag: 'W/"h2-abc"' });
    expect(fg.ok && fg.value.raw_bg).toBe("0");
    expect(fg.ok && fg.value.heads_etag).toBe("h2-abc");
    const bg = parse_poll_request({ ...base, fg: false, heads_etag: "" });
    expect(bg.ok && bg.value.raw_bg).toBe("1");
    expect(bg.ok && bg.value.heads_etag).toBeNull();
    expect(normalize_etag(' "h2-x" ')).toBe("h2-x");
  });

  test("watch: uuids lower-cased, first occurrence wins, capped", () => {
    const up = CHAT.toUpperCase();
    const r = parse_poll_request({ ...base, watch: [{ chat_id: up, since: 5 }, { chat_id: CHAT, since: 9 }, { chat_id: U, since: 0 }] });
    expect(r.ok && r.value.watch).toEqual([{ chat_id: CHAT, since: 5 }, { chat_id: U, since: 0 }]);
    // since is required: a default of 0 paged a chat from its oldest rows.
    expect(parse_poll_request({ ...base, watch: [{ chat_id: U }] })).toEqual({ ok: false, reason: "bad_watch" });
    const many = Array.from({ length: POLL_WATCH_MAX + 1 }, () => ({ chat_id: crypto.randomUUID(), since: 0 }));
    expect(parse_poll_request({ ...base, watch: many })).toEqual({ ok: false, reason: `too_many_watch_max_${POLL_WATCH_MAX}` });
    expect(parse_poll_request({ ...base, watch: [{ chat_id: "nope", since: 1 }] })).toEqual({ ok: false, reason: "bad_watch" });
    expect(parse_poll_request({ ...base, watch: [{ chat_id: CHAT, since: -1 }] })).toEqual({ ok: false, reason: "bad_watch" });
  });

  test("ack: v lower-cased; '*' and junk refused; capped", () => {
    const v = randomUUIDv7();
    const r = parse_poll_request({ ...base, ack: [{ key: "k1", v: v.toUpperCase() }, { key: "k2", v: "" }] });
    expect(r.ok && r.value.ack).toEqual([{ key: "k1", v }, { key: "k2", v: "" }]);
    expect(parse_poll_request({ ...base, ack: [{ key: "k1", v: "*" }] })).toEqual({ ok: false, reason: "bad_ack" });
    expect(parse_poll_request({ ...base, ack: [{ key: "k1" }] })).toEqual({ ok: false, reason: "bad_ack" });
    expect(parse_poll_request({ ...base, ack: [{ key: "", v }] })).toEqual({ ok: false, reason: "bad_ack" });
    const many = Array.from({ length: POLL_ACK_MAX + 1 }, (_, i) => ({ key: "k" + i, v }));
    expect(parse_poll_request({ ...base, ack: many })).toEqual({ ok: false, reason: `too_many_acks_max_${POLL_ACK_MAX}` });
  });

  test("req_id must be safe for 'wid|req_id' values and inbox headers", () => {
    for (const bad of ["", "a|b", "a\nb", "x".repeat(101), 5, null]) {
      expect(parse_poll_request({ req_id: bad })).toEqual({ ok: false, reason: "bad_req_id" });
    }
    expect(parse_poll_request(null)).toEqual({ ok: false, reason: "bad_body" });
    expect(parse_poll_request([])).toEqual({ ok: false, reason: "bad_body" });
    expect(parse_poll_request({ ...base, wait: "x" })).toEqual({ ok: false, reason: "bad_wait" });
    expect(parse_poll_request({ ...base, fg: "yes" })).toEqual({ ok: false, reason: "bad_fg" });
    expect(parse_poll_request({ ...base, stubs_after: -3 })).toEqual({ ok: false, reason: "bad_stubs_after" });
  });

  test("acked_versions keeps the highest v per key", () => {
    const a = randomUUIDv7(), b = randomUUIDv7();
    expect(acked_versions([{ key: "k", v: b }, { key: "k", v: a }, { key: "j", v: "" }])).toEqual(new Map([["k", b], ["j", ""]]));
  });
});

// ── pending plan ─────────────────────────────────────────────────────────────

const NOW = 2_000_000_000_000;
const v_at = (ms: number): string => {
  const hex = ms.toString(16).padStart(12, "0");
  const r = randomUUIDv7();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}${r.slice(13)}`;
};
const E = (key: string, type: string, v: string, created_at: number, payload: Record<string, unknown> = {}): PendingEntryLike => ({
  v, message_id: key, created_at, ws_message: { type, payload, ws_timestamp: new Date(0) } as any,
});
const plan = (over: Partial<Parameters<typeof plan_pending_v2>[0]>) => plan_pending_v2({
  db_rows: [], redis_entries: [], meta: new Map(), meta_ok: true, entries_ok: true,
  acked: new Map(), now: NOW, ignore_hold: false, suppress_derivable: false, ...over,
});

describe("plan_pending_v2 (versioned, F's holds)", () => {
  test("tier merge keeps the newest version; nothing is deleted on read; marks record the version", () => {
    const v1 = v_at(NOW - 5000), v2 = v_at(NOW - 4000);
    const p = plan({
      db_rows: [E("u:message:pin:c", "message:pin", v2, NOW - 4000), E("u:user:update:x", "user:update", v1, NOW - 5000)],
      redis_entries: [E("u:message:pin:c", "message:pin", v1, NOW - 5000)],
    });
    expect(p.pending.map((x) => [x.key, x.v])).toEqual([["u:user:update:x", v1], ["u:message:pin:c", v2]]);
    expect(p.drop).toEqual([]);
    expect(p.returnable).toBe(2);
    expect(p.meta_updates.get("u:message:pin:c")).toEqual({ first: NOW, last: NOW, n: 1, v: v2 });
  });

  test("ack race: an ack of an OLDER v filters only that version; the newer one is still sent", () => {
    const v1 = v_at(NOW - 5000), v2 = v_at(NOW - 1000);
    const pin = E("u:message:pin:c", "message:pin", v2, NOW - 1000);
    const older = plan({ redis_entries: [pin], acked: new Map([["u:message:pin:c", v1]]) });
    expect(older.pending.map((x) => x.v)).toEqual([v2]);
    expect(older.ack_newer).toBe(1); // [POLL2] compare_delete_miss
    const same = plan({ redis_entries: [pin], acked: new Map([["u:message:pin:c", v2]]) });
    expect(same.pending).toEqual([]);
    expect(same.returnable).toBe(0);
    expect(same.ack_newer).toBe(0);
  });

  test("hold: returned recently with the same version → held (no early answer), wait:0 gets it back", () => {
    const v = v_at(NOW - 9000);
    const e = E("u:conversation:new:c", "conversation:new", v, NOW - 9000);
    const meta = new Map<string, ReturnMeta>([["u:conversation:new:c", { first: NOW - 2000, last: NOW - 2000, n: 1, v }]]);
    const held = plan({ redis_entries: [e], meta });
    expect(held.pending).toEqual([]);
    expect(held.held).toBe(1);
    expect(held.returnable).toBe(0);
    const w0 = plan({ redis_entries: [e], meta, ignore_hold: true });
    expect(w0.pending.map((x) => x.key)).toEqual(["u:conversation:new:c"]);
    expect(w0.redelivered).toBe(1);
    expect(w0.meta_updates.get("u:conversation:new:c")).toEqual({ first: NOW - 2000, last: NOW, n: 2, v });
    // hold elapsed (5 s for one return) → re-sent, counted
    const later = plan({ redis_entries: [e], meta, now: NOW + 4000 });
    expect(later.pending.length).toBe(1);
    expect(later.redelivered).toBe(1);
  });

  test("a NEWER version of a self-compacting key is a new fact (no hold); message:new versions share history", () => {
    const v1 = v_at(NOW - 9000), v2 = v_at(NOW - 500);
    const meta = new Map<string, ReturnMeta>([
      ["u:message:pin:c", { first: NOW - 2000, last: NOW - 2000, n: 1, v: v1 }],
      ["u:message:new:m", { first: NOW - 2000, last: NOW - 2000, n: 1 }], // a v1-written mark (no v)
    ]);
    const p = plan({
      redis_entries: [E("u:message:pin:c", "message:pin", v2, NOW - 500), E("u:message:new:m", "message:new", v2, NOW - 500, { id: "m" })],
      meta,
    });
    expect(p.pending.map((x) => x.key)).toEqual(["u:message:pin:c"]);
    expect(p.held).toBe(1);
    expect(p.meta_updates.get("u:message:pin:c")).toEqual({ first: NOW, last: NOW, n: 1, v: v2 });
  });

  test("expiry 7 days after the FIRST return → dropped with its exact version", () => {
    const v = v_at(NOW - RESEND_EXPIRY_MS - 10_000);
    const p = plan({
      redis_entries: [E("u:user:update:x", "user:update", v, NOW - RESEND_EXPIRY_MS - 10_000)],
      meta: new Map([["u:user:update:x", { first: NOW - RESEND_EXPIRY_MS - 1, last: NOW - 3_600_000, n: 9, v }]]),
    });
    expect(p.pending).toEqual([]);
    expect(p.expired).toBe(1);
    expect(p.drop).toEqual([{ key: "u:user:update:x", v }]);
  });

  test("lease holder (§3.13 active): derivable residue is drained, not sent; the rest is sent", () => {
    const v = v_at(NOW - 1000);
    const p = plan({
      suppress_derivable: true,
      redis_entries: [
        E("u:message:new:m", "message:new", v, NOW - 1000, { id: "m", seq: 7 }),
        E("u:message:new:n", "message:new", v, NOW - 1000, { id: "n" }), // no seq: not derivable
        E("u:user:update:x", "user:update", v, NOW - 1000),
      ],
    });
    expect(p.pending.map((x) => x.key).sort()).toEqual(["u:message:new:n", "u:user:update:x"]);
    expect(p.drop).toEqual([{ key: "u:message:new:m", v }]);
    expect(p.suppressed).toBe(1);
  });

  test("store order (created_at, conversation:new first on a tie, then v); cap → pending_more", () => {
    const t = NOW - 1000;
    const va = v_at(t), vb = v_at(t), vc = v_at(t - 1);
    const p = plan({
      cap: 2,
      redis_entries: [E("u:message:new:a", "message:new", va, t, { id: "a" }), E("u:conversation:new:c", "conversation:new", vb, t), E("u:message:react:r", "message:react", vc, t - 1)],
    });
    expect(p.pending.map((x) => x.key)).toEqual(["u:message:react:r", "u:conversation:new:c"]);
    expect(p.pending_more).toBe(true);
    expect(p.returnable).toBe(3);
    expect(p.meta_updates.size).toBe(2); // only what was handed out is marked
  });

  test("marks: stale ones pruned; nothing written when a Redis read failed", () => {
    const v = v_at(NOW - 1000);
    const meta = new Map<string, ReturnMeta>([["u:gone", { first: 1, last: 1, n: 1 }]]);
    const ok = plan({ redis_entries: [E("u:x", "user:update", v, NOW - 1000)], meta });
    expect(ok.stale_meta).toEqual(["u:gone"]);
    const bad = plan({ redis_entries: [E("u:x", "user:update", v, NOW - 1000)], meta, meta_ok: false });
    expect(bad.stale_meta).toEqual([]);
    expect(bad.meta_updates.size).toBe(0);
    expect(bad.pending.length).toBe(1); // still sent
  });

  test("return-meta codec: v1 3-part unchanged, v2 4-part with a store version", () => {
    const v = randomUUIDv7();
    const m4 = { first: 1, last: 2, n: 3, v };
    expect(format_return_meta(m4)).toBe(`1:2:3:${v}`);
    expect(parse_return_meta(format_return_meta(m4))).toEqual(m4);
    expect(parse_return_meta("1:2:3:")).toEqual({ first: 1, last: 2, n: 3, v: "" });
    expect(format_return_meta({ first: 1, last: 2, n: 3 })).toBe("1:2:3");
    expect(parse_return_meta(`1:2:3:${v.toUpperCase()}`)).toBeUndefined();
  });
});

// ── deltas / decision / misc ─────────────────────────────────────────────────

describe("inline delta attestation", () => {
  const raw = (o: Partial<PollDeltaRaw>): PollDeltaRaw => ({
    chat_id: CHAT, chat_type: "group", status: "active", hidden: false, since: 10, seq_head: 80,
    last_seq: 80, read_seq: 1, delivered_seq: 1, joined_seq: 0, cleared_seq: 0, left_seq: null, floor_seq: 0,
    roster_seq: 0, pin: null, settings: null, rows: [], tail: false, n_kept: 0, last_mod: null, fetched: 0, ...o,
  });
  test("complete → through head; cut by the chat cap → last mod_seq; cut to nothing → since", () => {
    const [a, b, c] = finalize_poll_deltas([
      raw({ rows: [{ mod_seq: 11 }, { mod_seq: 12 }], n_kept: 2, last_mod: 12, fetched: 2 }),
      raw({ rows: [{ mod_seq: 11 }], n_kept: 1, last_mod: 11, fetched: 51 }),
      raw({ n_kept: 0, last_mod: null, fetched: 51 }),
    ]);
    expect([a!.through_seq, a!.has_more, a!.mode, a!.mods]).toEqual([80, false, "delta", []]);
    expect([b!.through_seq, b!.has_more]).toEqual([11, true]);
    expect([c!.through_seq, c!.has_more]).toEqual([10, true]);
    expect("n_kept" in a! || "fetched" in a! || "since" in a! || "tail" in a!).toBe(false);
    expect(a!.tail_needed).toBe(false);
  });
  test("a chat more than TAIL_GAP behind: no rows, through = since, tail_needed (§3.9 auto)", () => {
    const [t, edge] = finalize_poll_deltas([
      raw({ since: 0, seq_head: TAIL_GAP + 1, tail: true, rows: [{ mod_seq: 1 }], n_kept: 1, last_mod: 1, fetched: 1 }),
      raw({ since: 0, seq_head: TAIL_GAP, rows: [{ mod_seq: 1 }], n_kept: 1, last_mod: 1, fetched: 1 }),
    ]);
    expect([t!.rows, t!.through_seq, t!.has_more, t!.tail_needed]).toEqual([[], 0, true, true]);
    expect([edge!.rows.length, edge!.through_seq, edge!.has_more, edge!.tail_needed]).toEqual([1, TAIL_GAP, false, false]);
  });
  test("FCM: an 'on' message:delete push drops mods / pin (derivable), like meta (source contract)", async () => {
    const f = await Bun.file(`${import.meta.dir}/../src/services/fcm-batch.service.ts`).text();
    expect(f).toContain("const strip_delete = ws_message.type === 'message:delete' && ('mods' in p || 'pin' in p);");
    expect(f).toContain("delete (rest as Record<string, unknown>).mods;");
    expect(f).toContain("delete (rest as Record<string, unknown>).pin;");
    // why: with mods, 34+ ids overflow the 3700-byte budget (and a delete has no stub)
    const ids = Array.from({ length: 89 }, () => crypto.randomUUID());
    const legacy = JSON.stringify([{ type: "message:delete", payload: { conv_id: CHAT, message_ids: ids, sender_id: U }, ws_timestamp: new Date().toISOString() }]);
    const with_mods = JSON.stringify([{ type: "message:delete", payload: { conv_id: CHAT, message_ids: ids, sender_id: U, mods: ids.map((id, i) => ({ id, mod_seq: 100_000 + i })) }, ws_timestamp: new Date().toISOString() }]);
    expect(Buffer.byteLength(legacy)).toBeLessThanOrEqual(3700);
    expect(Buffer.byteLength(with_mods)).toBeGreaterThan(3700);
  });
  test("has_news / chat_of_frame", () => {
    expect(has_news({ heads_rows: 0, gone: 0, deltas: 0, returnable: 0 })).toBe(false);
    expect(has_news({ heads_rows: 0, gone: 1, deltas: 0, returnable: 0 })).toBe(true);
    expect(chat_of_frame({ payload: { conv_id: CHAT } })).toBe(CHAT);
    expect(chat_of_frame({ payload: { chat_id: "a,b" } })).toBe("-");
    expect(chat_of_frame(undefined)).toBe("-");
  });
  test("a parked long-poll keeps its v1 lease fresh until held_until (no FCM / eviction mid-wait)", () => {
    const now = 1_000_000;
    const lease = { last_poll_at: new Date(now - 20_000), held_until: now + 5_000 };
    expect(poll_lease_verdict(lease_seen_ms(lease), now)).toBe("polling");
    expect(poll_lease_verdict(lease_seen_ms({ last_poll_at: new Date(now - 20_000) }), now)).toBe("stale");
    expect(poll_lease_verdict(lease_seen_ms({ last_poll_at: new Date(now - 20_000), held_until: now - 11_000 }), now)).toBe("stale");
  });
  test("inbox nudge / supersede frames round-trip", () => {
    expect(decode_inbox(encode_nudge(["a", "b"], CHAT))).toEqual({ kind: "nudge", uids: ["a", "b"], chat_id: CHAT });
    expect(decode_inbox(encode_nudge(["a"], ""))).toEqual({ kind: "nudge", uids: ["a"], chat_id: "-" });
    expect(decode_inbox(encode_supersede("a", "req-1"))).toEqual({ kind: "supersede", uid: "a", req_id: "req-1" });
  });
});

// ── waiter registry (fake clock) ─────────────────────────────────────────────

class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private seq = 0;
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clear = (h: unknown) => {
    this.timers.delete(h as number);
  };
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await Promise.resolve();
    }
    this.t = end;
    await Promise.resolve();
  }
  pending() {
    return this.timers.size;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const track = (p: Promise<WakeReason>) => {
  const box: { v: WakeReason | null } = { v: null };
  p.then((v) => (box.v = v));
  return box;
};

describe("WaiterRegistry", () => {
  test("timeout at the deadline; final: later nudges are ignored", async () => {
    const c = new FakeClock();
    const reg = new WaiterRegistry(c, 300);
    const { waiter } = reg.register(U, "r1", 25_000);
    const got = track(waiter.next());
    await c.advance(24_999);
    await settle();
    expect(got.v).toBeNull();
    await c.advance(1);
    await settle();
    expect(got.v).toBe("timeout");
    expect(waiter.nudge(CHAT)).toBe(false);
    expect(await waiter.next()).toBe("timeout");
  });

  test("nudges coalesce: the first starts 300 ms, later ones ride it → ONE wake", async () => {
    const c = new FakeClock();
    const reg = new WaiterRegistry(c, 300);
    const { waiter } = reg.register(U, "r1", 25_000);
    const got = track(waiter.next());
    expect(reg.nudge([U, "nobody"], "c1")).toBe(1);
    await c.advance(100);
    reg.nudge([U], "c2");
    reg.nudge([U], "c3");
    await settle();
    expect(got.v).toBeNull();
    await c.advance(200);
    await settle();
    expect(got.v).toBe("nudge");
    expect(waiter.nudges).toBe(3);
    expect([...waiter.chats].sort()).toEqual(["c1", "c2", "c3"]);
    // re-armed: nothing pending until the next nudge
    const again = track(waiter.next());
    await c.advance(1_000);
    await settle();
    expect(again.v).toBeNull();
  });

  test("a nudge that fires while the caller computes is not lost: next() returns it at once", async () => {
    const c = new FakeClock();
    const reg = new WaiterRegistry(c, 300);
    const { waiter } = reg.register(U, "r1", 25_000);
    reg.nudge([U]);
    await c.advance(300); // fired with nobody waiting
    expect(await waiter.next()).toBe("nudge");
  });

  test("a newer request supersedes the older one at once; by req_id only from the inbox", async () => {
    const c = new FakeClock();
    const reg = new WaiterRegistry(c, 300);
    const first = reg.register(U, "r1", 25_000);
    const got = track(first.waiter.next());
    const second = reg.register(U, "r2", 25_000);
    await settle();
    expect(got.v).toBe("superseded");
    expect(second.superseded).toBe(first.waiter);
    expect(reg.get(U)).toBe(second.waiter);
    reg.release(first.waiter); // the old request's cleanup must not drop the new one
    expect(reg.get(U)).toBe(second.waiter);
    expect(reg.supersede(U, "r1")).toBe(false); // stale: a newer one stays
    expect(reg.supersede(U, "r2")).toBe(true);
    expect(await second.waiter.next()).toBe("superseded");
    reg.release(second.waiter);
    expect(reg.size()).toBe(0);
    expect(c.pending()).toBe(0); // timers cleared
  });

  test("retry_in: a busy wake re-wakes as a nudge; a pending nudge covers it; nothing after final", async () => {
    const c = new FakeClock();
    const reg = new WaiterRegistry(c, 300);
    const { waiter } = reg.register(U, "r1", 25_000);
    expect(waiter.retry_in(150)).toBe(true);
    const got = track(waiter.next());
    await c.advance(149);
    await settle();
    expect(got.v).toBeNull();
    await c.advance(1);
    await settle();
    expect(got.v).toBe("nudge");
    // a nudge already armed: retry_in adds no second timer
    reg.nudge([U]);
    const before = c.pending();
    waiter.retry_in(1_000);
    expect(c.pending()).toBe(before);
    await c.advance(300);
    expect(await waiter.next()).toBe("nudge");
    waiter.finish("aborted");
    expect(waiter.retry_in(150)).toBe(false);
    expect(await waiter.next()).toBe("aborted");
    reg.release(waiter);
    expect(c.pending()).toBe(0);
  });

  test("coalesce jitter: each waiter's window is 300 + 0..jitter ms", async () => {
    const c = new FakeClock();
    let r = 0;
    const seq = [0, 0.999, 0.5];
    const reg = new WaiterRegistry(c, 300, 150, () => seq[r++ % seq.length]!);
    const ws = ["a", "b", "x"].map((u) => reg.register(u, "r", 25_000).waiter);
    const got = ws.map((w) => track(w.next()));
    reg.nudge(["a", "b", "x"]);
    await c.advance(300);
    await settle();
    expect(got.map((g) => g.v)).toEqual(["nudge", null, null]);
    await c.advance(75);
    await settle();
    expect(got.map((g) => g.v)).toEqual(["nudge", null, "nudge"]);
    await c.advance(75);
    await settle();
    expect(got.map((g) => g.v)).toEqual(["nudge", "nudge", "nudge"]);
  });

  test("wake_retry_ms: 150 ms doubling to 1 s, ±25 %", () => {
    expect(wake_retry_ms(0, () => 0.5)).toBe(150);
    expect(wake_retry_ms(1, () => 0.5)).toBe(300);
    expect(wake_retry_ms(10, () => 0.5)).toBe(POLL_WAKE_RETRY_MAX_MS);
    expect(wake_retry_ms(0, () => 0)).toBe(113);
    expect(wake_retry_ms(50, () => 0.999)).toBeLessThanOrEqual(1_250);
  });

  test("drain answers every parked request now and every later one at birth", async () => {
    const c = new FakeClock();
    const reg = new WaiterRegistry(c, 300);
    const a = reg.register("a", "r", 25_000).waiter;
    const b = reg.register("b", "r", 25_000).waiter;
    const ga = track(a.next());
    expect(reg.drain_all()).toBe(2);
    await settle();
    expect(ga.v).toBe("drain");
    expect(await b.next()).toBe("drain");
    const late = reg.register("c", "r", 25_000).waiter;
    expect(await late.next()).toBe("drain");
    expect(reg.is_closed()).toBe(true);
  });

  test("apply_poll_inbox: nudge / supersede frames; anything else is not ours", async () => {
    const c = new FakeClock();
    const reg = new WaiterRegistry(c, 300);
    const w = reg.register(U, "r1", 25_000).waiter;
    expect(apply_poll_inbox(reg, decode_inbox(encode_nudge([U, "x"], CHAT))!)).toEqual({ kind: "nudge", hit: 1 });
    expect(apply_poll_inbox(reg, decode_inbox(encode_supersede(U, "zzz"))!)).toEqual({ kind: "supersede", hit: 0 });
    expect(apply_poll_inbox(reg, decode_inbox(encode_supersede(U, "r1"))!)).toEqual({ kind: "supersede", hit: 1 });
    expect(await w.next()).toBe("superseded");
    expect(apply_poll_inbox(reg, { kind: "deliver", uids: [U], frame: "{}" })).toBeNull();
  });

  test("remote_waiters_by_wid groups by holder and skips this worker", () => {
    const by = remote_waiters_by_wid(["a", "b", "c", "d"], [
      { wid: "w1", req_id: "1" }, { wid: "self", req_id: "2" }, null, { wid: "w1", req_id: "3" },
    ], "self");
    expect(by).toEqual(new Map([["w1", ["a", "d"]]]));
  });
});

// ── real redis-server: two workers, versioned acks ───────────────────────────

let server: Subprocess | null = null;
let client: Redis;
const subs: Redis[] = [];

describe.skipIf(!BIN)("poll v2 on redis-server", () => {
  let port = 0;
  beforeAll(async () => {
    port = 20_000 + Math.floor(Math.random() * 20_000);
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
    for (const s of subs) {
      try {
        await s.quit();
      } catch { }
    }
    try {
      await client?.quit();
    } catch { }
    server?.kill();
  });

  beforeEach(async () => {
    await client.flushall();
  });

  // One in-process "worker": its registry, a subscriber on its inbox (as
  // bus.on(k.inbox(wid)) → router.handle_inbox → handle_poll_inbox), and the
  // waiter / presence stores bound to the shared connection.
  const worker = async (wid: string) => {
    const reg = new WaiterRegistry(undefined, 50);
    const sub = new Redis({ host: "127.0.0.1", port, maxRetriesPerRequest: 1 });
    sub.on("error", () => { });
    subs.push(sub);
    const received: string[] = [];
    sub.on("message", (_ch: string, raw: string) => {
      received.push(raw);
      const m = decode_inbox(raw);
      if (m) apply_poll_inbox(reg, m);
    });
    await sub.subscribe(k.inbox(wid));
    const wr = create_waiter_redis(client, k);
    const pres = create_presence(client, wid);
    // register_waiter in remote mode: local registry + swap + supersede the old holder.
    const register = async (uid: string, req_id: string, wait_ms: number) => {
      const r = reg.register(uid, req_id, wait_ms);
      const old = await wr.swap(uid, wid, req_id, wait_ms / 1000 + 5);
      if (old && old.wid !== wid) await wr.publish_supersede(old.wid, uid, old.req_id);
      return r.waiter;
    };
    // router.deliver's nudge: local registry + presence pipeline with waiters → inbox.
    const fan_out = async (recipients: string[], chat: string) => {
      const p = await pres.lookup(recipients, { waiters: true });
      reg.nudge(recipients, chat);
      const remote = remote_waiters_by_wid(recipients, p.map((x) => x.waiter), wid);
      return wr.publish_nudges(remote, chat);
    };
    return { wid, reg, register, fan_out, wr, received };
  };

  const within = async <T>(p: Promise<T>, ms = 2_000): Promise<T | "late"> =>
    Promise.race([p, Bun.sleep(ms).then(() => "late" as const)]);

  test("N=2 nudge fan-in: one fan-out wakes a local waiter in-process and a remote one via ITS inbox (one publish)", async () => {
    const w1 = await worker("host:1:aaaaaaaa");
    const w2 = await worker("host:2:bbbbbbbb");
    const a = await w1.register("ua", "ra", 10_000);   // ua parked on w1
    const b = await w2.register("ub", "rb", 10_000);   // ub parked on w2
    const pa = a.next();
    const pb = b.next();
    expect(await client.get(k.poll_waiter("ub"))).toBe("host:2:bbbbbbbb|rb");
    expect(await client.ttl(k.poll_waiter("ub"))).toBeLessThanOrEqual(15);
    // A fan-out on w1 to ua, ub and someone with no waiter.
    const sent = await w1.fan_out(["ua", "ub", "uz"], CHAT);
    expect([...sent.entries()]).toEqual([["host:2:bbbbbbbb", 1]]); // one PUBLISH, one subscriber
    expect(await within(pa)).toBe("nudge");
    expect(await within(pb)).toBe("nudge");
    expect(w2.received).toEqual([encode_nudge(["ub"], CHAT)]);
    expect(w1.received).toEqual([]); // nothing published for a local waiter
    // A burst of fan-outs from both workers coalesces into ONE more wake per waiter.
    const nb = b.next();
    await w1.fan_out(["ub"], "c1");
    await w2.fan_out(["ub"], "c2");
    await w1.fan_out(["ub"], "c3");
    expect(await within(nb)).toBe("nudge");
    const quiet = await within(b.next(), 200);
    expect(quiet).toBe("late");
    expect(b.nudges).toBe(4);
  });

  test("supersede across workers: the newer request swaps poll:waiter and the old holder answers at once", async () => {
    const w1 = await worker("host:1:cccccccc");
    const w2 = await worker("host:2:dddddddd");
    const old = await w1.register(U, "r1", 10_000);
    const p_old = old.next();
    const neo = await w2.register(U, "r2", 10_000);
    expect(await within(p_old)).toBe("superseded");
    expect(await client.get(k.poll_waiter(U))).toBe("host:2:dddddddd|r2");
    // the old holder's cleanup compare-deletes: it must not remove the new advertisement
    expect(await w1.wr.release(U, "host:1:cccccccc", "r1")).toBe(false);
    expect(await client.get(k.poll_waiter(U))).toBe("host:2:dddddddd|r2");
    // a nudge now reaches the new holder only
    const pn = neo.next();
    await w1.fan_out([U], CHAT);
    expect(await within(pn)).toBe("nudge");
    expect(await w2.wr.release(U, "host:2:dddddddd", "r2")).toBe(true);
    expect(await client.exists(k.poll_waiter(U))).toBe(0);
    // a stale supersede (an older req_id) leaves a newer local waiter alone
    const newer = await w1.register(U, "r3", 10_000);
    await w2.wr.publish_supersede("host:1:cccccccc", U, "r1");
    expect(await within(newer.next(), 200)).toBe("late");
  });

  test("a nudge for a waiter whose worker died is published to nobody (0 receivers), never thrown", async () => {
    const w1 = await worker("host:1:eeeeeeee");
    await client.set(k.poll_waiter(U), "host:9:deadbeef|r", "EX", 30);
    const sent = await w1.fan_out([U], CHAT);
    expect([...sent.entries()]).toEqual([["host:9:deadbeef", 0]]);
  });

  // ---- versioned acks on RC-3's Lua drain -------------------------------------

  const store = async (pr: PendingRedis, uid: string, key: string, v: string, type = "message:pin") => {
    await client.hset(redis_entries_key(uid), key, encode_entry({
      v, message_id: key, ws_message: { type, payload: { conv_id: CHAT }, ws_timestamp: new Date(0) } as any, created_at: Date.now(),
    }));
    return pr;
  };

  test("ack of an OLDER v never deletes a newer entry; the acked version itself is drained", async () => {
    const pr = create_pending_redis(client);
    const key = `${U}:message:pin:${CHAT}`;
    const v1 = randomUUIDv7();
    await store(pr, U, key, v1);
    // the client got v1; meanwhile the pin changed (re-store, same key)
    const v2 = randomUUIDv7();
    await store(pr, U, key, v2);
    await client.hset(redis_return_meta_key(U), key, format_return_meta({ first: 1, last: 1, n: 1, v: v1 }));
    // its next poll acks v1 (lower-cased by parse_poll_request: send it upper-case)
    const req = parse_poll_request({ req_id: "r", ack: [{ key, v: v1.toUpperCase() }] });
    expect(req.ok).toBe(true);
    const acked = acked_versions(req.ok ? req.value.ack : []);
    await pr.drain([{ user_id: U, items: Array.from(acked, ([key, v]) => ({ key, v })), tomb: false }]);
    const left = parse_value(await client.hget(redis_entries_key(U), key));
    expect(left?.kind === "entry" && left.entry.v).toBe(v2);
    // …and the same request's plan still sends v2 (no hold: a new version)
    const p = plan_pending_v2({
      db_rows: [], redis_entries: left?.kind === "entry" ? [left.entry] : [], meta: new Map(), meta_ok: true,
      entries_ok: true, acked, now: Date.now(), ignore_hold: false, suppress_derivable: false,
    });
    expect(p.pending.map((x) => x.v)).toEqual([v2]);
    // acking v2 removes it
    await pr.drain([{ user_id: U, items: [{ key, v: v2 }], tomb: false }]);
    expect(await client.hexists(redis_entries_key(U), key)).toBe(0);
  });

  test("concurrent re-store between read and ack: the ack of the read version leaves the re-store", async () => {
    const pr = create_pending_redis(client);
    const key = `${U}:user:update:x`;
    const v1 = randomUUIDv7();
    await store(pr, U, key, v1, "user:update");
    const read_v = v1;                         // the poll handed out v1
    const v2 = randomUUIDv7();
    await Promise.all([
      store(pr, U, key, v2, "user:update"),    // a fan-out re-stores
      pr.drain([{ user_id: U, items: [{ key, v: read_v }], tomb: false }]), // the ack lands
    ]);
    const left = parse_value(await client.hget(redis_entries_key(U), key));
    // whichever order Redis applied them in, v2 survives (drain is "stored v ≤ v1")
    expect(left?.kind === "entry" && left.entry.v).toBe(v2);
  });

  test("an empty-version ack drains only a legacy (pre-RC-3) entry, never a versioned one", async () => {
    const pr = create_pending_redis(client);
    const legacy = `${U}:message:react:old`;
    await client.hset(redis_entries_key(U), legacy, JSON.stringify({ message_id: legacy, ws_message: { type: "message:react", payload: {} }, created_at: 1 }));
    const key = `${U}:message:react:new`;
    await store(pr, U, key, randomUUIDv7(), "message:react");
    await pr.drain([{ user_id: U, items: [{ key: legacy, v: "" }, { key, v: "" }], tomb: false }]);
    expect(await client.hexists(redis_entries_key(U), legacy)).toBe(0);
    expect(await client.hexists(redis_entries_key(U), key)).toBe(1);
  });
});
