// Unit tests for RC-2 cross-worker routing (SYNC_V2 §13.4–§13.6): presence
// value codec, router classification, liveness reclassification, inbox wire
// format, the replace/evict damper and the routing-mode parser.
// Pure — no database / Redis / sockets. Run: `bun test tests/rc2-router.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  format_poll_value,
  format_ws_value,
  parse_poll_value,
  parse_ws_value,
  worker_prefix,
  ws_prefix,
  type Presence,
} from "@/cluster/presence-core";
import {
  REPLACE_MAX_IN_WINDOW,
  REPLACE_WINDOW_MS,
  ReplaceDamper,
  apply_liveness,
  bucket_arrays,
  classify_presence,
  decode_inbox,
  encode_deliver,
  encode_evict,
  new_buckets,
  poll_lease_verdict,
} from "@/cluster/router-core";
import { parse_mode } from "@/cluster/mode";
import { k, legacy } from "@/cluster/keys";
import { REDIS_NS } from "@/cluster/identity";

const SELF = "host-a:1:aaaaaaaa";
const OTHER = "host-a:2:bbbbbbbb";
const THIRD = "host-b:1:cccccccc";

const ws = (wid: string, cid: string, bg = false) => ({ wid, cid, bg });
const poll = (wid: string, bg = false) => ({ wid, bg });

describe("presence value codec", () => {
  test("ws value round-trips and prefixes match only their owner", () => {
    const v = format_ws_value(SELF, "0123456789ab", true);
    expect(v).toBe(`${SELF}|0123456789ab|1`);
    expect(parse_ws_value(v)).toEqual({ wid: SELF, cid: "0123456789ab", bg: true });
    expect(v.startsWith(ws_prefix(SELF, "0123456789ab"))).toBe(true);
    expect(v.startsWith(ws_prefix(SELF, "0123456789ac"))).toBe(false);
    expect(v.startsWith(worker_prefix(SELF))).toBe(true);
    // "host-a:1:aaaaaaaa|" must not match a wid that merely starts the same
    expect(`${SELF}x|c|0`.startsWith(worker_prefix(SELF))).toBe(false);
  });

  test("poll value round-trips; garbage parses to null", () => {
    expect(parse_poll_value(format_poll_value(OTHER, false))).toEqual({ wid: OTHER, bg: false });
    expect(parse_poll_value(format_poll_value(OTHER, true))?.bg).toBe(true);
    for (const bad of [null, undefined, "", "x", "a|b|c|d", 42, "|c|1"]) {
      expect(parse_ws_value(bad)).toBeNull();
    }
    expect(parse_poll_value("a|b|c")).toBeNull();
    expect(parse_poll_value(null)).toBeNull();
  });
});

describe("keys", () => {
  test("new keys are namespaced and hash-tagged per user", () => {
    expect(k.presence_ws("u1")).toBe(`${REDIS_NS}:presence:{u1}:ws`);
    expect(k.presence_poll("u1")).toBe(`${REDIS_NS}:presence:{u1}:poll`);
    expect(k.inbox(SELF)).toBe(`${REDIS_NS}:ws:deliver:${SELF}`);
    expect(k.worker(SELF)).toBe(`${REDIS_NS}:worker:${SELF}`);
  });
  test("legacy channels keep their exact pre-RC-2 names (no orphaned subscribers mid-swap)", () => {
    expect(legacy).toEqual({
      ws_broadcast_channel: "ws:broadcast",
      ws_force_logout_channel: "ws:force_logout",
      conv_invalidate_channel: "conv:invalidate",
      user_peer_invalidate_channel: "user_peer:invalidate",
      fcm_invalidate_channel: "fcm:invalidate",
    });
  });
});

describe("routing mode", () => {
  test("defaults: local at N=1, on at N>1", () => {
    expect(parse_mode(undefined, 1)).toBe("local");
    expect(parse_mode("", 1)).toBe("local");
    expect(parse_mode(undefined, 2)).toBe("on");
  });
  test("explicit values win, garbage falls back to the default", () => {
    expect(parse_mode("shadow", 1)).toBe("shadow");
    expect(parse_mode("ON", 1)).toBe("on");
    expect(parse_mode("off", 2)).toBe("local");
    expect(parse_mode("local", 2)).toBe("local");
    expect(parse_mode("bogus", 1)).toBe("local");
  });
});

describe("v1 poll lease verdict (today's rule)", () => {
  test("fresh < 10 s is polling, older or missing is stale", () => {
    expect(poll_lease_verdict(1_000, 10_999)).toBe("polling");
    expect(poll_lease_verdict(1_000, 11_000)).toBe("stale");
    expect(poll_lease_verdict(undefined, 5)).toBe("stale");
  });
});

describe("classify_presence (§13.6.3 step 2)", () => {
  test("remote socket → online (+bg) grouped by worker; poller → polling (+bg); none → offline", () => {
    const b = new_buckets();
    const rest = ["r1", "r2", "r3", "p1", "p2", "o1"];
    const pres: Presence[] = [
      { ws: ws(OTHER, "c1"), poll: null },
      { ws: ws(OTHER, "c2", true), poll: null },
      { ws: ws(THIRD, "c3"), poll: poll(SELF) }, // a socket beats a poll lease
      { ws: null, poll: poll(SELF) },
      { ws: null, poll: poll(OTHER, true) },
      { ws: null, poll: null },
    ];
    const plan = classify_presence(b, rest, pres, SELF, () => false);
    const a = bucket_arrays(b);
    expect(a.online).toEqual(["r1", "r2", "r3"]);
    expect(a.polling).toEqual(["p1", "p2"]);
    expect(a.offline).toEqual(["o1"]);
    expect(a.background).toEqual(["r2", "p2"]);
    expect(Object.fromEntries(plan.remote)).toEqual({ [OTHER]: ["r1", "r2"], [THIRD]: ["r3"] });
    expect(plan.stale_self).toEqual([]);
  });

  test("a key naming THIS worker without a local socket is stale unless mid-open", () => {
    const b = new_buckets();
    const plan = classify_presence(
      b,
      ["s1", "s2"],
      [
        { ws: ws(SELF, "dead"), poll: null },
        { ws: ws(SELF, "opening"), poll: null },
      ],
      SELF,
      (cid) => cid === "opening",
    );
    expect(bucket_arrays(b).offline).toEqual(["s1", "s2"]);
    expect(plan.stale_self.map((s) => s.uid)).toEqual(["s1"]);
  });

  test("a stale self key with a live poll lease is a poller, not released", () => {
    const b = new_buckets();
    const plan = classify_presence(b, ["u"], [{ ws: ws(SELF, "x"), poll: poll(OTHER) }], SELF, () => false);
    expect(bucket_arrays(b).polling).toEqual(["u"]);
    expect(plan.stale_self).toEqual([]);
  });
});

describe("apply_liveness (§13.6.3, V7)", () => {
  const setup = () => {
    const b = new_buckets();
    const remote = new Map<string, string[]>([
      ["w-live", ["a", "b"]],
      ["w-dead", ["c"]],
      ["w-zero-live", ["d"]],
      ["w-wedged", ["e"]],
      ["w-unknown", ["f"]],
    ]);
    for (const uid of ["a", "b", "c", "d", "e", "f"]) b.online.add(uid);
    for (const uid of ["b", "c", "e"]) b.background.add(uid);
    return { b, remote };
  };

  test("each liveness outcome lands in the right bucket", () => {
    const { b, remote } = setup();
    const res = new Map([
      ["w-live", { receivers: 1, alive: true }],
      ["w-dead", { receivers: 0, alive: false }],
      ["w-zero-live", { receivers: 0, alive: true }],
      ["w-wedged", { receivers: 2, alive: false }],
      // w-unknown: no answer for that worker
    ]);
    const { dead, stats } = apply_liveness(b, remote, res);
    const a = bucket_arrays(b);
    expect(a.online.sort()).toEqual(["a", "b", "d"]);
    expect(a.offline.sort()).toEqual(["c", "e", "f"]);
    // reclassified users leave the background bucket (they get FCM as offline)
    expect(a.background).toEqual(["b"]);
    // only the provably dead worker's keys are released, never on a 0 alone
    expect(dead).toEqual([{ wid: "w-dead", uids: ["c"] }]);
    expect(stats).toEqual({
      remote_deliveries: 2,
      publish_zero_live: 1,
      publish_zero_dead: 1,
      wedged_reclass: 1,
      liveness_unknown: 1,
    });
  });

  test("deadline (null result) reclassifies every remote user offline, releases nothing", () => {
    const { b, remote } = setup();
    const { dead, stats } = apply_liveness(b, remote, null);
    expect(bucket_arrays(b).online).toEqual([]);
    expect(bucket_arrays(b).offline.length).toBe(6);
    expect(dead).toEqual([]);
    expect(stats.liveness_unknown).toBe(6);
  });
});

describe("inbox wire format (§13.6.2)", () => {
  test("deliver carries the frame byte-for-byte, including newlines and commas", () => {
    const frame = JSON.stringify({ type: "message:new", payload: { body: "a\nb, c\n\nd" } });
    const raw = encode_deliver(["u1", "u2"], frame);
    expect(raw.startsWith("d\nu1,u2\n")).toBe(true);
    expect(decode_inbox(raw)).toEqual({ kind: "deliver", uids: ["u1", "u2"], frame });
    // a frame that is not JSON (or contains raw newlines) still survives
    const odd = "line1\nline2";
    expect(decode_inbox(encode_deliver(["x"], odd))).toEqual({ kind: "deliver", uids: ["x"], frame: odd });
  });

  test("evict / nudge / supersede decode; malformed input is rejected", () => {
    expect(decode_inbox(encode_evict("u", "oldcid", "newcid"))).toEqual({
      kind: "evict",
      uid: "u",
      old_cid: "oldcid",
      new_cid: "newcid",
    });
    expect(decode_inbox("n\nu1,u2\nchat")).toEqual({ kind: "nudge", uids: ["u1", "u2"], chat_id: "chat" });
    expect(decode_inbox("s\nu1\nreq")).toEqual({ kind: "supersede", uid: "u1", req_id: "req" });
    for (const bad of ["", "d", "d\n", "d\n\nframe", "dx", "x\nfoo", "e\nu\nold", "d\nu1"]) {
      expect(decode_inbox(bad)).toBeNull();
    }
  });
});

describe("ReplaceDamper (evict ping-pong guard)", () => {
  test(`allows ${REPLACE_MAX_IN_WINDOW} replacements per window, then damps until quiet`, () => {
    const d = new ReplaceDamper();
    const t0 = 1_000_000;
    for (let i = 0; i < REPLACE_MAX_IN_WINDOW; i++) expect(d.allow("u", t0 + i)).toBe(true);
    expect(d.allow("u", t0 + 10)).toBe(false);
    // other users are unaffected
    expect(d.allow("v", t0 + 10)).toBe(true);
    // still damped while attempts keep coming inside the window
    expect(d.allow("u", t0 + REPLACE_WINDOW_MS - 1)).toBe(false);
    // after a full quiet window it is allowed again
    expect(d.allow("u", t0 + 3 * REPLACE_WINDOW_MS)).toBe(true);
  });

  test("bounded memory", () => {
    const d = new ReplaceDamper();
    for (let i = 0; i < 25_000; i++) d.allow(`u${i}`, i);
    expect(d.size()).toBeLessThanOrEqual(20_000);
  });
});
