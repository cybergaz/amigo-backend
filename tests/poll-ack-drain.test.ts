// Unit tests for SYNC_V2 R0.1 field fixes F2-1 (poll v1: no delete-on-read
// for message:new), F2-5 (background flag on connect / poll) and the
// [FANOUT] log. Pure — no database / Redis / sockets.
// Run: `bun test tests/poll-ack-drain.test.ts`.
import { beforeEach, describe, expect, test } from "bun:test";
import Snowflake from "@/utils/snowflake.utils";
import {
  RESEND_EXPIRY_MS,
  RESEND_HOLD_BASE_MS,
  RESEND_HOLD_MAX_MS,
  classify_pending_read,
  finalize_pending_read,
  format_return_meta,
  is_ack_drained,
  message_new_key,
  parse_return_meta,
  resend_hold_ms,
  stale_meta_keys,
  type ReturnMeta,
} from "@/utils/poll-ack-drain.utils";
import {
  clear_status_hints,
  hinted_background,
  is_bg_flag,
  is_fg_flag,
  next_lease_status,
  note_announced_status,
} from "@/sockets/presence-flags";
import { format_fanout_line, start_fanout_log } from "@/utils/fanout-log";
import { parse_debug_tags } from "@/utils/debug-log";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const MSG = "0192f000-0000-7000-8000-000000000001";

const msg_new = (id: string, opts: { sender?: string; msg_type?: string; key?: string; at?: number } = {}) => ({
  message_id: opts.key ?? message_new_key(ME, id),
  created_at: opts.at ?? 1_000,
  ws_message: {
    type: "message:new",
    payload: { id, sender_id: opts.sender ?? PEER, msg_type: opts.msg_type ?? "text" },
  },
});

const other = (key: string, type: string, at = 1_000) => ({
  message_id: key,
  created_at: at,
  ws_message: { type, payload: {} },
});

const keys = (entries: { message_id: string }[]) => entries.map((e) => e.message_id);

describe("message_new_key", () => {
  test("matches the key the ack drain computes", () => {
    expect(message_new_key(ME, MSG)).toBe(Snowflake.correlationId(ME, "message:new", MSG));
  });
});

describe("is_ack_drained", () => {
  test("a peer's message:new under its deterministic key", () => {
    expect(is_ack_drained(ME, msg_new(MSG))).toBe(true);
  });
  test("own message (forward copy): the client never acks it → delete on read", () => {
    expect(is_ack_drained(ME, msg_new(MSG, { sender: ME }))).toBe(false);
  });
  test("system message: the client never acks it → delete on read", () => {
    expect(is_ack_drained(ME, msg_new(MSG, { msg_type: "system" }))).toBe(false);
  });
  test("pre-deploy random key: the ack cannot target it → delete on read", () => {
    expect(is_ack_drained(ME, msg_new(MSG, { key: `${ME}:message:new:01999999-rand` }))).toBe(false);
  });
  test("other types keep delete-on-read", () => {
    for (const t of ["message:sent:ack", "message:delete", "conversation:new", "message:pin"]) {
      expect(is_ack_drained(ME, other(`${ME}:${t}:x`, t))).toBe(false);
    }
  });
  test("message:new without an id", () => {
    expect(
      is_ack_drained(ME, { message_id: "k", created_at: 1, ws_message: { type: "message:new", payload: {} } }),
    ).toBe(false);
  });
});

describe("resend_hold_ms", () => {
  test("never returned → no hold", () => {
    expect(resend_hold_ms(0)).toBe(0);
  });
  test("doubles per return, capped", () => {
    expect(resend_hold_ms(1)).toBe(RESEND_HOLD_BASE_MS);
    expect(resend_hold_ms(2)).toBe(RESEND_HOLD_BASE_MS * 2);
    expect(resend_hold_ms(3)).toBe(RESEND_HOLD_BASE_MS * 4);
    expect(resend_hold_ms(50)).toBe(RESEND_HOLD_MAX_MS);
    expect(resend_hold_ms(1000)).toBe(RESEND_HOLD_MAX_MS);
  });
});

describe("return meta encoding", () => {
  test("round trip", () => {
    const m: ReturnMeta = { first: 1_700_000_000_000, last: 1_700_000_005_000, n: 3 };
    expect(parse_return_meta(format_return_meta(m))).toEqual(m);
  });
  test("junk reads as never returned", () => {
    for (const raw of [null, undefined, "", "x", "1:2", "a:b:c", "1:2:0", "1:2:3:4"]) {
      expect(parse_return_meta(raw as string | null | undefined)).toBeUndefined();
    }
  });
});

describe("poll read plan", () => {
  const NOW = 10_000_000_000;

  test("first read: everything returned; message:new kept with a mark, the rest deleted", () => {
    const sorted = [
      other(`${ME}:conversation:new:c`, "conversation:new", 1),
      msg_new(MSG, { at: 2 }),
      other(`${ME}:message:sent:ack:m`, "message:sent:ack", 3),
    ];
    const meta = new Map<string, ReturnMeta>();
    const c = classify_pending_read(ME, sorted, meta, NOW);
    expect(keys(c.candidates)).toEqual(keys(sorted));
    expect(c.resend_keys.size).toBe(0);
    const plan = finalize_pending_read(ME, c.candidates, meta, 500, NOW);
    expect(keys(plan.result)).toEqual(keys(sorted));
    expect(plan.delete_keys).toEqual([`${ME}:conversation:new:c`, `${ME}:message:sent:ack:m`]);
    expect(plan.meta_updates.get(message_new_key(ME, MSG))).toEqual({ first: NOW, last: NOW, n: 1 });
    expect(plan.resent).toBe(0);
  });

  test("returned moments ago (ack in flight) → held, not re-sent", () => {
    const e = msg_new(MSG);
    const meta = new Map([[e.message_id, { first: NOW - 1_000, last: NOW - 1_000, n: 1 }]]);
    const c = classify_pending_read(ME, [e], meta, NOW);
    expect(c.candidates).toEqual([]);
    expect(c.held).toBe(1);
  });

  test("the reconnect gap-fill GET (for_sync) ignores the hold, not the expiry", () => {
    const e = msg_new(MSG);
    const meta = new Map([[e.message_id, { first: NOW - 1_000, last: NOW - 1_000, n: 1 }]]);
    const c = classify_pending_read(ME, [e], meta, NOW, true);
    expect(keys(c.candidates)).toEqual([e.message_id]);
    expect(c.resend_keys.has(e.message_id)).toBe(true);
    expect(c.held).toBe(0);
    const expired = new Map([[e.message_id, { first: NOW - RESEND_EXPIRY_MS, last: NOW, n: 3 }]]);
    expect(classify_pending_read(ME, [e], expired, NOW, true).expired_keys).toEqual([e.message_id]);
  });

  test("hold elapsed without an ack (response lost) → re-sent, first return kept", () => {
    const e = msg_new(MSG);
    const first = NOW - 60_000;
    const meta = new Map([[e.message_id, { first, last: NOW - RESEND_HOLD_BASE_MS, n: 1 }]]);
    const c = classify_pending_read(ME, [e], meta, NOW);
    expect(keys(c.candidates)).toEqual([e.message_id]);
    expect(c.resend_keys.has(e.message_id)).toBe(true);
    const plan = finalize_pending_read(ME, c.candidates, meta, 500, NOW);
    expect(plan.resent).toBe(1);
    expect(plan.delete_keys).toEqual([]);
    expect(plan.meta_updates.get(e.message_id)).toEqual({ first, last: NOW, n: 2 });
  });

  test("expiry counts from the FIRST RETURN, not from store time", () => {
    // Stored 30 days ago (phone asleep), never returned → delivered, not expired.
    const old = msg_new(MSG, { at: NOW - 30 * 24 * 3600_000 });
    const c1 = classify_pending_read(ME, [old], new Map(), NOW);
    expect(keys(c1.candidates)).toEqual([old.message_id]);
    expect(c1.expired_keys).toEqual([]);

    // First returned just under 7 days ago → still re-sent.
    const m2 = new Map([[old.message_id, { first: NOW - RESEND_EXPIRY_MS + 1, last: 0, n: 40 }]]);
    expect(classify_pending_read(ME, [old], m2, NOW).expired_keys).toEqual([]);

    // First returned 7 days ago, never acked → expired.
    const m3 = new Map([[old.message_id, { first: NOW - RESEND_EXPIRY_MS, last: NOW, n: 40 }]]);
    const c3 = classify_pending_read(ME, [old], m3, NOW);
    expect(c3.expired_keys).toEqual([old.message_id]);
    expect(c3.candidates).toEqual([]);
  });

  test("delete-on-read types ignore marks (never held, never expired)", () => {
    const e = other(`${ME}:message:delete:x`, "message:delete");
    const meta = new Map([[e.message_id, { first: 0, last: NOW, n: 9 }]]);
    const c = classify_pending_read(ME, [e], meta, NOW);
    expect(keys(c.candidates)).toEqual([e.message_id]);
    expect(c.held + c.expired_keys.length).toBe(0);
  });

  test("cap: only returned entries are deleted or marked; the rest stays untouched", () => {
    const a = other(`${ME}:message:delete:a`, "message:delete", 1);
    const b = msg_new("0192f000-0000-7000-8000-00000000000b", { at: 2 });
    const c = other(`${ME}:message:delete:c`, "message:delete", 3);
    const d = msg_new("0192f000-0000-7000-8000-00000000000d", { at: 4 });
    const plan = finalize_pending_read(ME, [a, b, c, d], new Map(), 2, NOW);
    expect(keys(plan.result)).toEqual([a.message_id, b.message_id]);
    expect(plan.delete_keys).toEqual([a.message_id]);
    expect([...plan.meta_updates.keys()]).toEqual([b.message_id]);
  });

  test("stale marks (entry gone from every tier) are cleaned", () => {
    const meta = new Map<string, ReturnMeta>([
      ["live", { first: 1, last: 1, n: 1 }],
      ["gone", { first: 1, last: 1, n: 1 }],
    ]);
    expect(stale_meta_keys(meta, new Set(["live", "other"]))).toEqual(["gone"]);
  });
});

describe("background flag (bg=1)", () => {
  beforeEach(() => clear_status_hints());

  test("is_bg_flag", () => {
    for (const v of ["1", "true", true, 1]) expect(is_bg_flag(v)).toBe(true);
    for (const v of [undefined, null, "", "0", "false", 0, false, "yes"]) expect(is_bg_flag(v)).toBe(false);
  });

  test("bg=1 always wins: new lease and refresh both become background", () => {
    expect(next_lease_status(undefined, true, false)).toBe("background");
    expect(next_lease_status("online", true, false)).toBe("background");
  });

  test("no bg on refresh keeps the status (an old client's background frame survives polls)", () => {
    expect(next_lease_status("background", false, false)).toBe("background");
    expect(next_lease_status("online", false, true)).toBe("online");
  });

  test("bg=0 (new clients in the foreground) clears background on refresh and new lease", () => {
    for (const v of ["0", "false", false, 0]) expect(is_fg_flag(v)).toBe(true);
    for (const v of [undefined, null, "", "1", "true", 1, true]) expect(is_fg_flag(v)).toBe(false);
    expect(next_lease_status("background", false, false, true)).toBe("online");
    expect(next_lease_status(undefined, false, true, true)).toBe("online");
  });

  test("new lease without bg starts from the last announcement", () => {
    expect(next_lease_status(undefined, false, false)).toBe("online");
    expect(next_lease_status(undefined, false, true)).toBe("background");
  });

  test("hint: last announcement wins, expires after a week", () => {
    const t0 = 1_000_000;
    expect(hinted_background(ME, t0)).toBe(false);
    note_announced_status(ME, "background", t0);
    expect(hinted_background(ME, t0 + 1_000)).toBe(true);
    note_announced_status(ME, "online", t0 + 2_000);
    expect(hinted_background(ME, t0 + 3_000)).toBe(false);
    note_announced_status(ME, "background", t0);
    expect(hinted_background(ME, t0 + 8 * 24 * 3600_000)).toBe(false);
  });
});

describe("[FANOUT] line", () => {
  const buckets = {
    online: [ME, PEER],
    background: [PEER],
    polling: ["p1"],
    offline: ["o1", "o2"],
  };

  test("format", () => {
    expect(
      format_fanout_line({
        kind: "new", message_id: "m", chat_id: "c", recipients: 5,
        online: 2, background: 1, polling: 1, offline: 2, fcm: 3, sent: 2, failed: 1, pending: 0,
      }),
    ).toBe("[FANOUT] kind=new msg=m chat=c rcpt=5 on=2 bg=1 poll=1 off=2 fcm=3 sent=2 failed=1");
  });

  test("one line, printed when the last FCM result is in", () => {
    const lines: string[] = [];
    const t = start_fanout_log("new", "m", "c", buckets, { log: (l) => lines.push(l) });
    const r1 = t.fcm_queued();
    const r2 = t.fcm_queued();
    const r3 = t.fcm_queued();
    t.done_queueing();
    r1(true);
    r2(false);
    r2(true); // duplicate report ignored
    expect(lines).toEqual([]);
    r3(true);
    expect(lines).toEqual([
      "[FANOUT] kind=new msg=m chat=c rcpt=5 on=2 bg=1 poll=1 off=2 fcm=3 sent=2 failed=1",
    ]);
  });

  test("no pushes → printed at once; forwarder excluded from counts", () => {
    const lines: string[] = [];
    const t = start_fanout_log("fwd", "m", "c", buckets, { exclude: ME, log: (l) => lines.push(l) });
    t.done_queueing();
    expect(lines).toEqual([
      "[FANOUT] kind=fwd msg=m chat=c rcpt=4 on=1 bg=1 poll=1 off=2 fcm=0 sent=0 failed=0",
    ]);
  });

  test("results that never come → printed after the wait with pending", async () => {
    const lines: string[] = [];
    const t = start_fanout_log("new", "m", "c", buckets, { log: (l) => lines.push(l), wait_ms: 5 });
    t.fcm_queued()(true);
    t.fcm_queued();
    t.done_queueing();
    expect(lines).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEndWith("fcm=2 sent=1 failed=0 pending=1");
  });
});

describe("AMIGO_DEBUG parsing", () => {
  test("tags, case-insensitive; * / 1 / all = everything; unset = nothing", () => {
    expect(parse_debug_tags(undefined)).toEqual(new Set());
    expect(parse_debug_tags("pending, fanout")).toEqual(new Set(["PENDING", "FANOUT"]));
    expect(parse_debug_tags("*")).toBe("all");
    expect(parse_debug_tags("1")).toBe("all");
  });
});
