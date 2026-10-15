// Sync v2 R1b "derived server state + frame fields" (SYNC_V2_PROTOCOL.md
// §3.5–§3.8, §3.3.5, §3.3.7, §4.1). Pure parts: flags (rollout_pct, the 'on'
// switches), the additive frame fields, the receipt-window effects plan, the
// per-viewer mins helpers and the serial vital chain; the chat_meta seq-CAS
// Lua against a REAL redis-server (REDIS_SERVER_BIN, skipped otherwise; never
// the project's Redis); and source contracts that keep 'off' / 'shadow'
// byte-identical. The SQL runs end to end on the PGlite harness
// (scratchpad pglite/r1b_app.ts, readapi.ts plans).
// Run: `bun test tests/sync-v2-r1b.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SYNC_V2_FLAGS,
  derived_ready,
  parse_pct,
  parse_sync_v2_flags,
  v2_on,
  type SyncV2Flags,
} from "@/services/sync/flags-core";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";
import { sync_proto_for } from "@/services/sync/read-core";
import { ack_seq_fields, delete_unpin_field, msg_seq_fields } from "@/services/sync/frame-fields";
import { plan_receipt_effects, windows_of } from "@/services/sync/receipt-plan";
import {
  RECEIPT_READ_WINDOW_CAP,
  RECEIPT_WINDOW_CAP,
  mins_rise,
  others_from_mins,
  type MinsRow,
  type ReceiptOutcome,
  type ReceiptWindowResult,
} from "@/services/sync/write-queries";
import { SERIAL_VITAL_TYPES, chain_vital, in_vital_chain, run_fanout } from "@/sockets/vital-chain";
import { bind_meta_cas, meta_pairs } from "@/cache-management/chat-meta-cas";

const SRC = join(import.meta.dir, "..", "src");
const src = (f: string) => readFileSync(join(SRC, f), "utf8");

const U = "6c3c7a8e-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
const S1 = "1b0e2f6a-9c8d-4e7f-a1b2-c3d4e5f60718";
const S2 = "2b0e2f6a-9c8d-4e7f-a1b2-c3d4e5f60718";
const CH = "0b0e2f6a-9c8d-4e7f-a1b2-c3d4e5f60718";

const on_flags = (over: Partial<SyncV2Flags> = {}): SyncV2Flags => ({
  ...DEFAULT_SYNC_V2_FLAGS,
  loaded: true,
  mode: "on",
  markers: { ...DEFAULT_SYNC_V2_FLAGS.markers, backfill: true, indexes_post: true },
  ...over,
});

describe("flags: rollout_pct and the 'on' switches", () => {
  test("rollout_pct parses to 0..100, anything malformed is 0", () => {
    expect(DEFAULT_SYNC_V2_FLAGS.rollout_pct).toBe(0);
    expect(parse_pct(25)).toBe(25);
    expect(parse_pct("40")).toBe(40);
    expect(parse_pct(250)).toBe(100);
    expect(parse_pct(-3)).toBe(0);
    expect(parse_pct("lots")).toBe(0);
    expect(parse_pct(null)).toBe(0);
    expect(parse_pct(undefined)).toBe(0);
    expect(parse_pct({ pct: 10 })).toBe(10);
    expect(parse_sync_v2_flags([{ key: SYNC_V2_KEYS.rollout_pct, value: 30 }]).rollout_pct).toBe(30);
    expect(parse_sync_v2_flags([]).rollout_pct).toBe(0);
  });
  test("v2_on is mode 'on' only; derived_ready also needs the backfill + index markers", () => {
    expect(v2_on(DEFAULT_SYNC_V2_FLAGS)).toBe(false);
    expect(v2_on({ ...DEFAULT_SYNC_V2_FLAGS, mode: "shadow" })).toBe(false);
    expect(v2_on(on_flags())).toBe(true);
    expect(derived_ready(on_flags())).toBe(true);
    expect(derived_ready(on_flags({ markers: { ...DEFAULT_SYNC_V2_FLAGS.markers, backfill: true } }))).toBe(false);
    expect(derived_ready({ ...on_flags(), mode: "shadow" })).toBe(false);
  });
  test("syncProto: 0 in 'on' until the user's bucket is in; 2 at 100%", () => {
    expect(sync_proto_for(U, on_flags())).toBe(0);
    expect(sync_proto_for(U, on_flags({ rollout_pct: 100 }))).toBe(2);
  });
});

describe("additive frame fields (§4.1)", () => {
  test("message:new / sent:ack fields come from the stored row", () => {
    const at = new Date("2026-10-15T10:00:00.123Z");
    expect(msg_seq_fields({ seq: 7, mod_seq: 7, created_at: at })).toEqual({ seq: 7, mod_seq: 7, srv_ts: at.toISOString() });
    expect(msg_seq_fields({ seq: "12", mod_seq: "15", created_at: at.toISOString() })).toEqual({ seq: 12, mod_seq: 15, srv_ts: at.toISOString() });
    expect(msg_seq_fields(null)).toEqual({ seq: null, mod_seq: null, srv_ts: null });
    expect(ack_seq_fields({ seq: 3, created_at: at })).toEqual({ seq: 3, srv_ts: at.toISOString() });
  });
  test("delete-unpin pin: only when the delete's trigger cleared the pin", () => {
    const mods = [{ mod_seq: 40 }, { mod_seq: 41 }];
    expect(delete_unpin_field({ pinned_msg_id: null, pin_seq: 42 }, mods)).toEqual({ pinned_msg_id: null, pin_seq: 42 });
    expect(delete_unpin_field({ pinned_msg_id: null, pin_seq: 12 }, mods)).toBeUndefined();   // unpinned long before
    expect(delete_unpin_field({ pinned_msg_id: "x", pin_seq: 50 }, mods)).toBeUndefined();     // still pinned
    expect(delete_unpin_field({ pinned_msg_id: null, pin_seq: 42 }, [])).toBeUndefined();       // nothing deleted
  });
});

const outcome = (o: Partial<ReceiptOutcome>): ReceiptOutcome => ({
  chat_id: CH, status: "applied", chat_type: "group", seq_head: 100, r: null, d: null,
  prev_read: 10, read_seq: 10, prev_deliv: 10, delivered_seq: 10, r_min2: null, d_min2: null, ...o,
});
const res = (over: Partial<ReceiptWindowResult> = {}): ReceiptWindowResult => ({
  marked: 0, senders: new Map(), last_read: new Map(), delivered: new Map(), ...over,
});

describe("receipt windows → legacy effects plan (§3.7 step 2)", () => {
  test("only applied outcomes that advanced produce windows", () => {
    expect(windows_of([
      outcome({ prev_read: 10, read_seq: 20, prev_deliv: 15, delivered_seq: 20 }),
      outcome({ status: "noop" }),
      outcome({ status: "rejected" }),
      outcome({ status: "retry" }),
    ])).toEqual([{ chat_id: CH, rp: 10, rn: 20, dp: 15, dn: 20 }]);
  });
  test("read window: conversation:join to the other senders with reader_id / read_seq; reset_unread", () => {
    const at = new Date(0);
    const plan = plan_receipt_effects(U, [{ chat_id: CH, rp: 10, rn: 20, dp: 20, dn: 20 }], res({
      senders: new Map([[CH, [S1, S2, U]]]),
      last_read: new Map([[CH, "m20"]]),
    }), at);
    expect(plan.reset_unread).toEqual([CH]);
    expect(plan.frames).toHaveLength(1);
    expect(plan.frames[0]!.to).toEqual([S1, S2]);
    expect(plan.frames[0]!.message).toEqual({
      type: "conversation:join",
      payload: { user_id: U, conv_id: CH, last_read_msg_id: "m20", reader_id: U, read_seq: 20 },
      ws_timestamp: at,
    });
  });
  test("delivered window: status:ack only for rows ABOVE the new read_seq, per sender, with seqs", () => {
    const plan = plan_receipt_effects(U, [{ chat_id: CH, rp: 10, rn: 12, dp: 10, dn: 15 }], res({
      senders: new Map([[CH, [S1]]]),
      last_read: new Map([[CH, "m12"]]),
      delivered: new Map([[CH, [
        { id: "m11", seq: 11, sender_id: S1, broadcast_msg_id: null },
        { id: "m12", seq: 12, sender_id: S1, broadcast_msg_id: null },
        { id: "m13", seq: 13, sender_id: S1, broadcast_msg_id: null },
        { id: "m14", seq: 14, sender_id: U, broadcast_msg_id: null },
        { id: "m15", seq: 15, sender_id: S2, broadcast_msg_id: "b15" },
      ]]]),
    }), new Date(0));
    const acks = plan.frames.filter((f) => f.message.type === "message:status:ack");
    expect(acks.map((f) => f.to[0]).sort()).toEqual([S1, S2].sort());
    const s1 = acks.find((f) => f.to[0] === S1)!.message.payload as any;
    expect(s1.acks).toEqual([{ chat_id: CH, msg_ids: ["m13"], status: ["delivered"], seqs: [13] }]);
    expect(s1).toMatchObject({ recipient_id: U, reader_id: U, delivered_seq: 15, read_seq: 12 });
    // drains: the reader's message:new for every row; each sender's sent:ack,
    // and a broadcast copy's parent sent:ack too
    expect(plan.drains.get(U)).toEqual(["m11", "m12", "m13", "m14", "m15"].map((id) => `${U}:message:new:${id}`));
    expect(plan.drains.get(S1)).toEqual(["m11", "m12", "m13"].map((id) => `${S1}:message:sent:ack:${id}`));
    expect(plan.drains.get(S2)).toEqual([`${S2}:message:sent:ack:m15`, `${S2}:message:sent:ack:b15`]);
  });
  test("reader_drain: false (the input path drained on arrival) skips only the reader's keys", () => {
    const plan = plan_receipt_effects(U, [{ chat_id: CH, rp: 10, rn: 10, dp: 10, dn: 11 }], res({
      delivered: new Map([[CH, [{ id: "m11", seq: 11, sender_id: S1, broadcast_msg_id: null }]]]),
    }), new Date(0), { reader_drain: false });
    expect(plan.drains.has(U)).toBe(false);
    expect(plan.drains.get(S1)).toEqual([`${S1}:message:sent:ack:m11`]);
  });
  test("legacy per-id delivered (delivered_relay: false): no window frames / drains — the handler relays the acked ids", () => {
    // D got only m14 of m11..m14 and acked it: the watermark moves to 14,
    // but the sender must not hear "delivered" for m11..m13.
    const plan = plan_receipt_effects(U, [{ chat_id: CH, rp: 10, rn: 10, dp: 10, dn: 14 }], res({
      delivered: new Map([[CH, [11, 12, 13, 14].map((n) => ({ id: `m${n}`, seq: n, sender_id: S1, broadcast_msg_id: null }))]]),
    }), new Date(0), { reader_drain: false, delivered_relay: false });
    expect(plan.frames).toHaveLength(0);
    expect(plan.drains.size).toBe(0);
  });
  test("legacy join (reader_drain: false): read effects, but the reader's unreceived copies stay pending", () => {
    const plan = plan_receipt_effects(U, [{ chat_id: CH, rp: 0, rn: 3, dp: 0, dn: 3 }], res({
      senders: new Map([[CH, [S1]]]),
      last_read: new Map([[CH, "m3"]]),
      delivered: new Map([[CH, [1, 2, 3].map((n) => ({ id: `m${n}`, seq: n, sender_id: S1, broadcast_msg_id: null }))]]),
    }), new Date(0), { reader_drain: false });
    expect(plan.drains.has(U)).toBe(false);
    expect(plan.frames.map((f) => f.message.type)).toEqual(["conversation:join"]);
  });
  test("no last visible row → no join frame; windows past their caps are counted", () => {
    const plan = plan_receipt_effects(U, [
      { chat_id: CH, rp: 0, rn: RECEIPT_READ_WINDOW_CAP + 5, dp: 0, dn: RECEIPT_READ_WINDOW_CAP + 5 },
    ], res({ senders: new Map([[CH, [S1]]]) }), new Date(0));
    expect(plan.frames).toHaveLength(0);
    expect(plan.capped).toBe(2);
    expect(RECEIPT_WINDOW_CAP).toBe(200);
  });
});

describe("per-viewer others from the mins row (§3.2) and chat:wm rise detection", () => {
  const row = (o: Partial<MinsRow> = {}): MinsRow => ({
    chat_id: CH, seq_head: 50, r_min1: 10, r_min1_user: S1, r_min2: 20, d_min1: 15, d_min1_user: S2, d_min2: 30, ...o,
  });
  test("the min1 user sees min2 (or head), everybody else min1", () => {
    expect(others_from_mins(row(), U)).toEqual({ r: 10, d: 15 });
    expect(others_from_mins(row(), S1)).toEqual({ r: 20, d: 15 });
    expect(others_from_mins(row(), S2)).toEqual({ r: 10, d: 30 });
    expect(others_from_mins(row({ r_min2: null }), S1.toUpperCase())).toEqual({ r: 50, d: 15 });
  });
  test("rise: min1 up → everybody; only min2 up → only the min1 user; nothing → none", () => {
    expect(mins_rise(row(), row({ r_min1: 11 }))).toEqual({ all: true, users: [] });
    expect(mins_rise(row(), row({ r_min2: 25 }))).toEqual({ all: false, users: [S1] });
    expect(mins_rise(row(), row({ d_min2: 31 }))).toEqual({ all: false, users: [S2] });
    expect(mins_rise(row(), row())).toEqual({ all: false, users: [] });
    expect(mins_rise(undefined, row())).toEqual({ all: true, users: [] });
  });
});

describe("serial vital chain (§3.3.5)", () => {
  test("the vital frame types", () => {
    for (const t of ["message:new", "message:pin", "message:delete", "message:forward", "conversation:join", "conversation:mark_read", "message:status:ack"]) {
      expect(SERIAL_VITAL_TYPES.has(t)).toBe(true);
    }
    expect(SERIAL_VITAL_TYPES.has("conversation:typing")).toBe(false);
    expect(SERIAL_VITAL_TYPES.has("call:init")).toBe(false);
  });
  test("outside a chain run_fanout is awaited inline (the pre-R1b behaviour)", async () => {
    const order: string[] = [];
    expect(in_vital_chain()).toBe(false);
    await run_fanout("s", "c", async () => {
      await Bun.sleep(5);
      order.push("fanout");
    });
    order.push("after");
    expect(order).toEqual(["fanout", "after"]);
  });
  test("commits run in arrival order; fan-outs detach, stay ordered per (sender, chat), never block the next commit", async () => {
    const order: string[] = [];
    const holder: { vital_tail?: Promise<unknown> } = {};
    const a = chain_vital(holder, async () => {
      await Bun.sleep(20);
      order.push("commit1");
      await run_fanout("s", "c", async () => {
        await Bun.sleep(30);
        order.push("fanout1");
      });
      order.push("ack1");
    });
    const b = chain_vital(holder, async () => {
      order.push("commit2");
      await run_fanout("s", "c", async () => {
        order.push("fanout2");
      });
      await run_fanout("s", "other", async () => {
        order.push("fanout2-other-chat");
      });
    });
    await Promise.all([a, b]);
    // both commits (and the first ack) before any fan-out into chat c
    expect(order.filter((x) => !x.startsWith("fanout"))).toEqual(["commit1", "ack1", "commit2"]);
    expect(order.includes("fanout1") || order.includes("fanout2")).toBe(false);
    await Bun.sleep(80);
    // chat c's fan-outs in commit order; the other chat's did not wait for them
    expect(order.filter((x) => x === "fanout1" || x === "fanout2")).toEqual(["fanout1", "fanout2"]);
    expect(order.indexOf("fanout2-other-chat")).toBeLessThan(order.indexOf("fanout1"));
  });
  test("a failed frame does not stall the chain; a failed fan-out does not reject", async () => {
    const holder: { vital_tail?: Promise<unknown> } = {};
    const bad = chain_vital(holder, async () => {
      throw new Error("boom");
    });
    await expect(bad).rejects.toThrow("boom");
    let ran = false;
    await chain_vital(holder, async () => {
      ran = true;
      await run_fanout("s", "boom", async () => {
        throw new Error("fanout boom");
      });
    });
    expect(ran).toBe(true);
    await Bun.sleep(10);
  });
  test("a nested run_fanout inside a detached fan-out runs inline on that link", async () => {
    const order: string[] = [];
    await chain_vital({}, async () => {
      await run_fanout("s", "nested", async () => {
        await run_fanout("s", "nested", async () => {
          order.push("inner");
        });
        order.push("outer");
      });
    });
    await Bun.sleep(10);
    expect(order).toEqual(["inner", "outer"]);
  });
});

const BIN = process.env.REDIS_SERVER_BIN || Bun.which("redis-server") || "";

describe.skipIf(!BIN)("chat_meta seq-CAS (§3.5) on a real redis-server", () => {
  let server: Subprocess;
  let client: Redis;
  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    server = Bun.spawn(
      [BIN, "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", tmpdir()],
      { stdout: "ignore", stderr: "ignore" },
    );
    client = new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1 });
    for (let i = 0; i < 50; i++) {
      try {
        await client.connect();
        break;
      } catch {
        await Bun.sleep(50);
      }
    }
  });
  afterAll(async () => {
    client?.disconnect();
    server?.kill();
  });

  const f = (id: string) => ({ id, body: "b-" + id, type: "text", sender_id: "s", sent_at: "t", attachments: "" });

  test("meta_pairs flattens fields and never forwards a `seq` field", () => {
    expect(meta_pairs({ id: "a", seq: "9", body: "x" })).toEqual(["id", "a", "body", "x"]);
  });
  test("first write lands; an older seq is refused; a newer one wins; equal is refused", async () => {
    const { cas } = bind_meta_cas(client);
    const key = "chat_meta:t1";
    expect(await cas(key, 10, f("m10"))).toBe(1);
    expect(await cas(key, 5, f("m5"))).toBe(0);
    expect(await cas(key, 10, f("m10b"))).toBe(0);
    expect(await client.hget(key, "id")).toBe("m10");
    expect(await cas(key, 11, f("m11"))).toBe(1);
    expect(await client.hgetall(key)).toMatchObject({ id: "m11", seq: "11" });
  });
  test("other fields of the hash (disappearing_after_sec) are untouched; a cleared seq accepts a lower one", async () => {
    const { cas } = bind_meta_cas(client);
    const key = "chat_meta:t2";
    await client.hset(key, "disappearing_after_sec", "3600");
    expect(await cas(key, 7, f("m7"))).toBe(1);
    await client.hdel(key, "id", "body", "type", "sender_id", "sent_at", "attachments", "seq", "srv_ts");
    expect(await cas(key, 3, f("m3"))).toBe(1);
    expect(await client.hgetall(key)).toMatchObject({ id: "m3", seq: "3", disappearing_after_sec: "3600" });
  });
  test("a legacy hash (no seq field) is overwritten by the first CAS", async () => {
    const { cas } = bind_meta_cas(client);
    const key = "chat_meta:t3";
    await client.hset(key, f("legacy"));
    expect(await cas(key, 1, f("m1"))).toBe(1);
    expect(await client.hget(key, "id")).toBe("m1");
  });
  test("cas_many: one pipeline, per-chat verdicts; 40 racing writers → the highest seq", async () => {
    const { cas, cas_many } = bind_meta_cas(client);
    await cas("chat_meta:t4", 30, f("m30"));
    const r = await cas_many([
      { key: "chat_meta:t4", seq: 12, fields: f("m12") },
      { key: "chat_meta:t5", seq: 12, fields: f("m12") },
    ]);
    expect(r).toEqual([0, 1]);
    const seqs = Array.from({ length: 40 }, (_, i) => 100 + ((i * 17) % 40));
    await Promise.all(seqs.map((s) => cas("chat_meta:t6", s, f("m" + s))));
    expect(await client.hget("chat_meta:t6", "id")).toBe("m" + Math.max(...seqs));
  });
});

describe("source contracts: 'off' / 'shadow' stay byte-identical", () => {
  test("get_chat_list takes the v2 path only when derived_ready; the legacy enrichment is intact", () => {
    const c = src("services/chat.services.ts");
    expect(c).toContain("const derived = derived_ready(f);");
    expect(c).toContain("derived\n        ? chat_list_state_sql(");
    expect(c).toContain("const legacy_enrich_chat_list = async (");
    expect(c).toContain("get_all_unread(user_id)");
    expect(c).toContain("const data = v2_on(f)");
  });
  test("every additive frame field is behind sync_v2 'on'", () => {
    const s = src("sockets/socket.service.ts");
    expect(s).toContain("const v2 = v2_on(sync_v2_flags());");
    expect(s).toContain("...(v2 ? msg_seq_fields(store_msg_result.data) : {})");
    expect(s).toContain("...(v2 ? ack_seq_fields(store_msg_result.data) : {})");
    expect(src("services/chat.services.ts")).toContain("if (v2_on(sync_v2_flags())) {\n    try {\n      frame_state = await delete_frame_state_sql(");
    expect(src("services/chat-broadcast.service.ts")).toContain("...(v2\n          ? {\n            dm_chat_id: r.conv_id,");
    expect(src("services/message-status.service.ts")).toContain("...(v2 ? ack_seq_fields(r) : {})");
    expect(src("services/fcm-batch.service.ts")).toContain("if (!v2_on(sync_v2_flags())) return ws_message;");
  });
  test("serial chain, poll sent_ack, forward ids and the HTTP forward result are 'on' only", () => {
    expect(src("sockets/socket.server.ts")).toContain("if (v2_on(sync_v2_flags()) && SERIAL_VITAL_TYPES.has(message.type)) {");
    expect(src("routes/chat-poll.routes.ts")).toContain('typeof request_id === "string" && request_id.length > 0 && v2_on(sync_v2_flags())');
    expect(src("services/message.services.ts")).toContain("const client_ids = v2_on(sync_v2_flags()) && request.ids");
    expect(src("routes/message.routes.ts")).toContain("forward_result.data && v2_on(sync_v2_flags())");
  });
  test("receipt window effects replace the legacy relays only when derived_ready", () => {
    expect(src("services/sync/receipt-effects.ts")).toContain("export const window_effects_active = (): boolean => derived_ready(sync_v2_flags());");
    // FCM delivered keeps its per-id relay in 'on' too; the coalesced legacy
    // delivered inputs add no window frames (legacy_delivered).
    expect(src("services/message-status.service.ts")).not.toContain("window_effects_active");
    expect(src("services/sync/watermark.service.ts")).toContain("await apply_receipts(user_id, items, { reader_drained: true, legacy_delivered: true });");
    expect(src("services/sync/watermark.service.ts")).toContain("{ join: ids.length > 0, at, reader_drained: true },");
    expect(src("sockets/socket.service.ts")).toContain("if (!window_effects_active()) return false;");
  });
  test("chat_meta: the plain HSET unless 'on' and the caller knows the seq", () => {
    const m = src("cache-management/chat-meta.cache.ts");
    expect(m).toContain('typeof msg.seq === "number" && Number.isFinite(msg.seq) && v2_on(sync_v2_flags())');
    expect(m).toContain('"attachments", "seq", "srv_ts"] as const;');
  });
  test("delivered flush: the reset is chained after the assignment (stale-promise regression)", () => {
    const w = src("services/sync/watermark.service.ts");
    expect(w).toContain("flushing = run().finally(() => {");
    expect(w).not.toMatch(/flushing = \(async \(\) => \{/);
  });
});
