// Sync v2 R1b read API (SYNC_V2_PROTOCOL.md §3.9, §3.12, §4.2, §5.12). Pure:
// the gate + rollout bucket, request parsing, page attestation, the heads
// etag, intent validation and the set_pin miss classification, plus source
// contracts (routes mounted under the auth guard, legacy pin wrappers keep
// their codes). The SQL in services/sync/read-queries.ts runs end to end —
// with EXPLAIN ANALYZE of every statement — on a throwaway PGlite outside the
// repo (harness readapi.ts / readapi_app.ts, see SYNC_V2_PROGRESS.md R1b).
// Run: `bun test tests/sync-v2-read-api.test.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SYNC_V2_FLAGS, type SyncV2Flags } from "@/services/sync/flags-core";
import {
  DELTA_DEFAULT_LIMIT,
  DELTA_MAX_LIMIT,
  INTENT_MAX_IDS,
  MODS_PAGE,
  PIN_OUTCOME_HTTP,
  TAIL_GAP,
  classify_pin_miss,
  etag_matches,
  finalize_mods,
  finalize_page,
  heads_etag,
  in_rollout,
  parse_delta_params,
  parse_id_list,
  parse_intent,
  parse_stubs_after,
  resolve_mode,
  rollout_bucket,
  rollout_pct_of,
  sync_proto_for,
  sync_v2_gate,
  type EtagInput,
} from "@/services/sync/read-core";

const SRC = join(import.meta.dir, "..", "src");
const src = (f: string) => readFileSync(join(SRC, f), "utf8");

const U = "6c3c7a8e-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
const C = "0b0e2f6a-9c8d-4e7f-a1b2-c3d4e5f60718";
const M1 = "01a13bff-7e2a-7781-9ed9-9e8720169a1d";

// rollout_pct 100 unless a test says otherwise (the shipped default is 0,
// covered by its own test below).
const flags = (over: Omit<Partial<SyncV2Flags>, "markers"> & { markers?: Partial<SyncV2Flags["markers"]> } = {}): SyncV2Flags => ({
  ...DEFAULT_SYNC_V2_FLAGS,
  loaded: true,
  rollout_pct: 100,
  ...over,
  markers: { ...DEFAULT_SYNC_V2_FLAGS.markers, ...(over.markers ?? {}) },
});
const READY = { backfill: true, indexes_post: true };

describe("gate (every /chat/sync/* route and the pinned endpoint)", () => {
  test("closed with every default", () => {
    expect(sync_v2_gate(U, DEFAULT_SYNC_V2_FLAGS)).toEqual({ ok: false, reason: "sync_v2_off" });
    expect(sync_proto_for(U, DEFAULT_SYNC_V2_FLAGS)).toBe(0);
  });
  test("shadow serves nothing new", () => {
    expect(sync_v2_gate(U, flags({ mode: "shadow", markers: READY })).ok).toBe(false);
  });
  test("on needs both post-backfill markers", () => {
    expect(sync_v2_gate(U, flags({ mode: "on" }))).toEqual({ ok: false, reason: "sync_v2_not_ready" });
    expect(sync_v2_gate(U, flags({ mode: "on", markers: { backfill: true } })).ok).toBe(false);
    expect(sync_v2_gate(U, flags({ mode: "on", markers: { indexes_post: true } })).ok).toBe(false);
    expect(sync_v2_gate(U, flags({ mode: "on", markers: READY }))).toEqual({ ok: true });
    expect(sync_proto_for(U, flags({ mode: "on", markers: READY }))).toBe(2);
  });
  test("rollout_pct is honoured; the shipped default (0) exposes nobody; a snapshot without it counts as 100", () => {
    expect(DEFAULT_SYNC_V2_FLAGS.rollout_pct).toBe(0);
    expect(sync_v2_gate(U, { ...DEFAULT_SYNC_V2_FLAGS, mode: "on", markers: { ...DEFAULT_SYNC_V2_FLAGS.markers, ...READY } }))
      .toEqual({ ok: false, reason: "sync_v2_not_in_rollout" });
    const on = flags({ mode: "on", markers: READY });
    expect(rollout_pct_of(on)).toBe(100);
    const { rollout_pct: _drop, ...legacy_shape } = on;
    expect(rollout_pct_of(legacy_shape as SyncV2Flags)).toBe(100);
    const zero = { ...on, rollout_pct: 0 } as SyncV2Flags;
    expect(sync_v2_gate(U, zero)).toEqual({ ok: false, reason: "sync_v2_not_in_rollout" });
    expect(sync_v2_gate(U, { ...on, rollout_pct: 100 } as SyncV2Flags).ok).toBe(true);
    expect(rollout_pct_of({ ...on, rollout_pct: "garbage" } as unknown as SyncV2Flags)).toBe(0);
    expect(rollout_pct_of({ ...on, rollout_pct: 250 } as unknown as SyncV2Flags)).toBe(100);
  });
  test("rollout bucket is stable, case-insensitive and roughly uniform", () => {
    expect(rollout_bucket(U)).toBe(rollout_bucket(U.toUpperCase()));
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 5000; i++) buckets[Math.floor(rollout_bucket(crypto.randomUUID()) / 10)]++;
    for (const b of buckets) expect(b).toBeGreaterThan(350);
    expect(in_rollout(U, 0)).toBe(false);
    expect(in_rollout(U, 100)).toBe(true);
    expect(in_rollout(U, rollout_bucket(U) + 1)).toBe(true);
    expect(in_rollout(U, rollout_bucket(U))).toBe(false);
  });
});

describe("delta params", () => {
  const ok = (q: Record<string, unknown>) => {
    const r = parse_delta_params(q);
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  };
  test("defaults: auto, limit 50", () => {
    expect(ok({})).toEqual({ mode: "auto", since: null, before: null, limit: DELTA_DEFAULT_LIMIT });
  });
  test("before alone means backward; limit is clamped", () => {
    expect(ok({ before: "10" }).mode).toBe("backward");
    expect(ok({ limit: "100000" }).limit).toBe(DELTA_MAX_LIMIT);
  });
  test("rejects junk", () => {
    for (const [q, reason] of [
      [{ since: "-1" }, "bad_since"], [{ since: "1.5" }, "bad_since"], [{ before: "0" }, "bad_before"],
      [{ limit: "0" }, "bad_limit"], [{ mode: "x" }, "bad_mode"], [{ mode: "backward" }, "before_required"],
      [{ mode: "mods", since: "1" }, "since_and_before_required"],
    ] as const) {
      const r = parse_delta_params(q as Record<string, unknown>);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    }
  });
  test("auto → tail when since is absent or head − since > TAIL_GAP", () => {
    expect(resolve_mode(ok({}), 10)).toBe("tail");
    expect(resolve_mode(ok({ since: "100" }), 100 + TAIL_GAP)).toBe("delta");
    expect(resolve_mode(ok({ since: "100" }), 101 + TAIL_GAP)).toBe("tail");
    expect(resolve_mode(ok({ since: "100", mode: "delta" }), 100000)).toBe("delta");
  });
  test("stubs_after", () => {
    expect(parse_stubs_after(undefined)).toBeNull();
    expect(parse_stubs_after("1792007962208")).toBe(1792007962208);
    expect(parse_stubs_after("x")).toBeUndefined();
  });
});

describe("page attestation", () => {
  const rows = (pairs: [number, number][]) => pairs.map(([seq, mod_seq]) => ({ seq, mod_seq }));
  test("delta: not cut → through = head; cut → last returned mod_seq", () => {
    const full = finalize_page("delta", rows([[5, 5], [2, 6], [7, 7]]), 3, 9, 0);
    expect(full).toMatchObject({ through_seq: 9, has_more: false });
    expect(full.rows.length).toBe(3);
    const cut = finalize_page("delta", rows([[5, 5], [2, 6], [7, 7], [8, 8]]), 3, 9, 0);
    expect(cut).toMatchObject({ through_seq: 7, has_more: true });
    expect(cut.rows.length).toBe(3);
  });
  test("delta with no rows attests head (burned values / rows below the floor)", () => {
    expect(finalize_page("delta", [], 50, 42, 10).through_seq).toBe(42);
  });
  test("tail: [through_lo, head]; floor when not cut", () => {
    const cut = finalize_page("tail", rows([[9, 9], [8, 8], [7, 12]]), 2, 12, 0);
    expect(cut).toMatchObject({ through_seq: 12, through_lo: 8, floor: false, has_more: false });
    const all = finalize_page("tail", rows([[9, 9], [8, 8]]), 5, 12, 3);
    expect(all).toMatchObject({ through_lo: 4, floor: true });
  });
  test("backward: [through_lo, before−1]", () => {
    const cut = finalize_page("backward", rows([[9, 9], [8, 8], [7, 7]]), 2, 50, 0, 10);
    expect(cut).toMatchObject({ through_seq: 9, through_lo: 8, floor: false, has_more: true });
    const done = finalize_page("backward", rows([[2, 2]]), 5, 50, 1, 3);
    expect(done).toMatchObject({ through_seq: 2, through_lo: 2, floor: true, has_more: false });
  });
  test("mods pages", () => {
    const many = Array.from({ length: MODS_PAGE + 1 }, (_, i) => ({ mod_seq: 100 + i }));
    const m = finalize_mods(many, 999);
    expect(m.mods.length).toBe(MODS_PAGE);
    expect(m.has_more_mods).toBe(true);
    expect(m.mods_through).toBe(100 + MODS_PAGE - 1);
    expect(finalize_mods([{ mod_seq: 3 }], 999)).toMatchObject({ has_more_mods: false, mods_through: 999 });
  });
});

describe("heads etag", () => {
  const row = (o: Partial<EtagInput> = {}): EtagInput => ({
    chat_id: C, status: "active", seq_head: 10, read_seq: 5, delivered_seq: 6, joined_seq: 0, cleared_seq: 0,
    left_seq: null, pin_seq: 0, settings_seq: 0, roster_seq: 0, others_read_seq: 4, others_delivered_seq: 6, ...o,
  });
  test("order independent, changes with any watermark", () => {
    const a = row(), b = row({ chat_id: U });
    expect(heads_etag([a, b])).toBe(heads_etag([b, a]));
    for (const k of ["seq_head", "read_seq", "delivered_seq", "pin_seq", "settings_seq", "roster_seq", "others_read_seq", "cleared_seq"] as const) {
      expect(heads_etag([row({ [k]: 77 })])).not.toBe(heads_etag([a]));
    }
    expect(heads_etag([a])).toMatch(/^h2-[0-9a-f]{32}$/);
  });
  test("shells: activity after the leave does not churn the etag", () => {
    const s = row({ status: "left", left_seq: 7 });
    expect(heads_etag([{ ...s, seq_head: 99, others_read_seq: 50 }])).toBe(heads_etag([s]));
    expect(heads_etag([{ ...s, left_seq: 8 }])).not.toBe(heads_etag([s]));
  });
  test("If-None-Match tolerates W/ (proxies weaken ETags) and lists", () => {
    const e = "h2-abc";
    expect(etag_matches(`"h2-abc"`, e)).toBe(true);
    expect(etag_matches(`W/"h2-abc"`, e)).toBe(true);
    expect(etag_matches(`"x", W/"h2-abc"`, e)).toBe(true);
    expect(etag_matches(`"h2-abd"`, e)).toBe(false);
    expect(etag_matches(null, e)).toBe(false);
  });
});

describe("intents", () => {
  const good = (o: Record<string, unknown>) => {
    const r = parse_intent({ request_id: "r", chat_id: C, ...o });
    if (!r.ok) throw new Error(r.result.reason);
    return r.intent;
  };
  const bad = (o: Record<string, unknown>) => {
    const r = parse_intent(o);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.result.status).toBe("rejected");
    expect(r.result.code).toBe(400);
    return r.result.reason;
  };
  test("each kind parses", () => {
    expect(good({ kind: "receipt", read_seq: 5 })).toMatchObject({ read_seq: 5, delivered_seq: null });
    expect(good({ kind: "receipt", delivered_seq: "7" })).toMatchObject({ delivered_seq: 7 });
    expect(good({ kind: "pin", message_id: M1, base_pin_seq: 3 })).toMatchObject({ message_id: M1, base_pin_seq: 3, unpin_target: null });
    expect(good({ kind: "pin", message_id: null, base_pin_seq: 3 })).toMatchObject({ message_id: null });
    expect(good({ kind: "react", message_id: M1, reaction: null })).toMatchObject({ reaction: null });
    expect(good({ kind: "delete_everyone", message_ids: [M1, M1.toUpperCase()] })).toMatchObject({ message_ids: [M1] });
    expect(good({ kind: "delete_me", message_ids: [M1] }).kind).toBe("delete_me");
    expect(good({ kind: "clear", upto_seq: 0 })).toMatchObject({ upto_seq: 0 });
    expect(good({ kind: "clear" })).toMatchObject({ upto_seq: null });
  });
  test("malformed intents are terminal 400s with a reason", () => {
    expect(bad({ kind: "receipt", chat_id: C })).toBe("bad_request_id");
    expect(bad({ request_id: "r", kind: "sing", chat_id: C })).toBe("unknown_kind");
    expect(bad({ request_id: "r", kind: "receipt", chat_id: "x" })).toBe("bad_chat_id");
    expect(bad({ request_id: "r", kind: "receipt", chat_id: C })).toBe("empty_receipt");
    expect(bad({ request_id: "r", kind: "receipt", chat_id: C, read_seq: -1 })).toBe("bad_seq");
    expect(bad({ request_id: "r", kind: "pin", chat_id: C, message_id: "nope" })).toBe("bad_message_id");
    expect(bad({ request_id: "r", kind: "react", chat_id: C, message_id: M1, reaction: "x".repeat(51) })).toBe("bad_reaction");
    expect(bad({ request_id: "r", kind: "delete_me", chat_id: C, message_ids: [] })).toBe("bad_message_ids");
    expect(bad({ request_id: "r", kind: "delete_me", chat_id: C, message_ids: Array(INTENT_MAX_IDS + 1).fill(M1) })).toBe("bad_message_ids");
    expect(bad({ request_id: "r", kind: "clear", chat_id: C, upto_seq: "1e3" })).toBe("bad_upto_seq");
    expect(parse_intent(null).ok).toBe(false);
  });
  test("id lists", () => {
    const r = parse_id_list([M1, "junk", M1.toUpperCase()], 5);
    expect(r).toEqual({ ok: true, value: [M1] });
    expect(parse_id_list(new Array(6).fill(M1), 5).ok).toBe(false);
    expect(parse_id_list("x", 5).ok).toBe(false);
  });
});

describe("set_pin miss classification (§3.12)", () => {
  const s = (o: Partial<Parameters<typeof classify_pin_miss>[0]> = {}) => ({
    chat_exists: true, member: true, chat_type: "group", pinned_msg_id: null as string | null, pin_seq: 4,
    target_in_chat: true, target_live: true, ...o,
  });
  const req = (o: Partial<Parameters<typeof classify_pin_miss>[1]> = {}) => ({ message_id: M1 as string | null, base_pin_seq: null as number | null, unpin_target: null as string | null, ...o });
  test("order: chat, member, broadcast, already-in-state, stale base / wrong target, not stored, deleted", () => {
    expect(classify_pin_miss(s({ chat_exists: false }), req())).toBe("no_chat");
    expect(classify_pin_miss(s({ member: false }), req())).toBe("forbidden");
    expect(classify_pin_miss(s({ chat_type: "broadcast" }), req())).toBe("unsupported");
    // already in that state wins over a stale base (an outbox replay of an applied pin)
    expect(classify_pin_miss(s({ pinned_msg_id: M1, pin_seq: 9 }), req({ base_pin_seq: 4 }))).toBe("noop");
    expect(classify_pin_miss(s({ pin_seq: 9 }), req({ base_pin_seq: 4 }))).toBe("conflict");
    expect(classify_pin_miss(s({ pinned_msg_id: U }), req({ message_id: null, unpin_target: M1 }))).toBe("conflict");
    expect(classify_pin_miss(s({ target_in_chat: false, target_live: false }), req({ base_pin_seq: 4 }))).toBe("not_stored");
    expect(classify_pin_miss(s({ target_live: false }), req())).toBe("not_found");
  });
  test("HTTP mapping: 425 is the only retry", () => {
    expect(PIN_OUTCOME_HTTP.not_stored).toEqual({ status: "retry", code: 425 });
    expect(PIN_OUTCOME_HTTP.conflict).toEqual({ status: "rejected", code: 409 });
    expect(PIN_OUTCOME_HTTP.noop).toEqual({ status: "noop", code: 200 });
    const retry = Object.entries(PIN_OUTCOME_HTTP).filter(([, v]) => v.status === "retry").map(([k]) => k);
    expect(retry).toEqual(["not_stored"]);
  });
});

describe("source contracts", () => {
  test("sync routes are mounted, behind the same guard as polling, gate after auth", () => {
    const server = src("server.ts");
    expect(server).toContain(".use(sync_routes)");
    const routes = src("routes/sync.routes.ts");
    expect(routes).toContain("app_middleware({ cookie, headers })");
    expect(routes).toContain("enforce_device_token(state_result.data)");
    expect(routes.indexOf("enforce_device_token(state_result.data)")).toBeLessThan(routes.indexOf("sync_v2_gate(r.auth.id"));
    expect(routes).not.toContain("store.id");
  });
  test("legacy pin / unpin delegate to set_pin and keep their codes", () => {
    const m = src("services/message.services.ts");
    const pin = m.slice(m.indexOf("const pin_message"), m.indexOf("const reply_to_message"));
    expect(pin).toContain("set_pin(");
    expect(pin).toContain('"Message already pinned"');
    expect(pin).toContain('"This message is not currently pinned"');
    expect(pin).not.toContain(".update(chat_model)");
    // pinned endpoint stays 501 while the gate is closed
    expect(m).toContain("sync_v2_gate(user_id, sync_v2_flags())");
  });
  test("pin_seq (and the live-only pinned_message) ride the legacy frame only when Sync v2 is on", () => {
    const p = src("services/sync/set-pin.ts");
    expect(p).toContain('const v2 = sync_v2_flags().mode === "on";');
    expect(p).toContain("if (v2) payload.pin_seq = applied.pin_seq;");
    expect(p).toContain("...(v2 && applied.pinned_message");
  });
  test("read SQL repeats the partial-index predicates it relies on", () => {
    const q = src("services/sync/read-queries.ts");
    expect(q).toContain("m.mod_seq <> m.seq");        // idx_messages_chat_modchg
    expect(q).toContain("um.deleted_at IS NULL AND um.seq IS NOT NULL"); // idx_messages_unread
    expect(q).toContain("cm.removed_at IS NULL AND c.deleted_at IS NULL"); // heads on the unremoved (user_id, chat_id) index
    expect(q).not.toMatch(/\bOFFSET\b/);
  });
});
