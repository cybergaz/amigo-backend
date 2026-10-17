// Load & accuracy test tool — pure rules (src/services/load-test-core.ts):
// test-user phones, the message body format, caps / body parsing, the verify
// math (stream stats, checksum, seq holes) and the pools. The end-to-end run
// against PGlite + a throwaway redis lives in the scratchpad harness
// (pglite/load_test_e2e.ts); this file needs no database.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BODY_RE,
  CAPS,
  build_verify_chat,
  checksum_of_ids,
  fold_checksums,
  format_body,
  group_title,
  id_checksum_part,
  is_test_group_title,
  is_test_phone,
  load_test_enabled,
  not_allowed_ids,
  parse_body,
  parse_dms_body,
  parse_groups_body,
  parse_members_body,
  parse_page_query,
  parse_receipts_body,
  parse_send_body,
  parse_users_body,
  parse_verify_body,
  parse_cleanup_body,
  percentile,
  pick_random,
  run_keyed_pool,
  run_pool,
  send_stats,
  summarize_run_rows,
  test_name,
  test_phone,
  test_phone_number,
  type RawRunRow,
  type StreamAggRow,
} from "@/services/load-test-core";

const U = (i: number) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`;

describe("test users", () => {
  test("phone = +99900 + 7 digits, name = LT NNNN", () => {
    expect(test_phone(1)).toBe("+999000000001");
    expect(test_phone(3000)).toBe("+999000003000");
    expect(test_name(1)).toBe("LT 0001");
    expect(test_name(42)).toBe("LT 0042");
  });

  test("is_test_phone accepts only the exact shape", () => {
    expect(is_test_phone("+999000000001")).toBe(true);
    expect(is_test_phone("+999009999999")).toBe(true);
    expect(is_test_phone("+99900000001")).toBe(false); // 6 digits
    expect(is_test_phone("+9990000000011")).toBe(false); // 8 digits
    expect(is_test_phone("+919900000001")).toBe(false);
    expect(is_test_phone("+999010000001")).toBe(false); // +99901 is not the prefix
    expect(is_test_phone("999000000001")).toBe(false);
    expect(is_test_phone(null)).toBe(false);
    expect(test_phone_number("+999000000042")).toBe(42);
    expect(test_phone_number("+919000000042")).toBeNull();
  });

  test("not_allowed_ids: only the caller and test users pass", () => {
    const tests = new Set([U(1), U(2)]);
    expect(not_allowed_ids([U(1), U(2), U(9)], U(9), tests)).toEqual([]);
    expect(not_allowed_ids([U(1), U(3), U(3)], U(9), tests)).toEqual([U(3)]);
  });

  test("LOAD_TEST_ENABLED parsing", () => {
    expect(load_test_enabled({})).toBe(false);
    expect(load_test_enabled({ LOAD_TEST_ENABLED: "" })).toBe(false);
    expect(load_test_enabled({ LOAD_TEST_ENABLED: "false" })).toBe(false);
    expect(load_test_enabled({ LOAD_TEST_ENABLED: "true" })).toBe(true);
    expect(load_test_enabled({ LOAD_TEST_ENABLED: " TRUE " })).toBe(true);
    expect(load_test_enabled({ LOAD_TEST_ENABLED: "1" })).toBe(true);
  });
});

describe("body format", () => {
  test("format + parse round trip, with and without N", () => {
    expect(format_body(3, "ab12cd", 10)).toBe("3/10 [LT ab12cd]");
    expect(format_body(3, "ab12cd")).toBe("3 [LT ab12cd]");
    expect(parse_body("3/10 [LT ab12cd]")).toEqual({ n: 3, N: 10, run: "ab12cd" });
    expect(parse_body("17 [LT zzzzzz]")).toEqual({ n: 17, N: null, run: "zzzzzz" });
  });

  test("the contract regex rejects near misses", () => {
    for (const b of ["3/10 [LT AB12CD]", "3/10 [LT ab12c]", "3/10  [LT ab12cd]", "x3 [LT ab12cd]", "3 [LT ab12cd] ", "3/ [LT ab12cd]", "[LT ab12cd]"]) {
      expect(parse_body(b)).toBeNull();
    }
    expect(BODY_RE.source).toBe("^(\\d+)(?:\\/(\\d+))? \\[LT ([a-z0-9]{6})\\]$");
  });

  test("group titles", () => {
    expect(group_title("ab12", 1, 5)).toBe("LT·ab12·01");
    expect(group_title("ab12", 7, 150)).toBe("LT·ab12·007");
    expect(is_test_group_title("LT·ab12·01")).toBe(true);
    expect(is_test_group_title("LT ab12")).toBe(false);
    expect(is_test_group_title(null)).toBe(false);
  });
});

describe("caps + body parsing", () => {
  test("users", () => {
    expect(parse_users_body({ count: 10 })).toEqual({ ok: true, value: { count: 10 } });
    expect(parse_users_body({ count: CAPS.users_per_call })).toMatchObject({ ok: true });
    expect(parse_users_body({ count: CAPS.users_per_call + 1 })).toMatchObject({ ok: false, reason: "cap_exceeded" });
    expect(parse_users_body({ count: 0 })).toMatchObject({ ok: false });
    expect(parse_users_body({ count: 1.5 })).toMatchObject({ ok: false });
    expect(parse_users_body(null)).toMatchObject({ ok: false });
  });

  test("users page query", () => {
    expect(parse_page_query({})).toEqual({ limit: 100, offset: 0 });
    expect(parse_page_query({ limit: "9999", offset: "-3" })).toEqual({ limit: CAPS.users_page_max, offset: 0 });
    expect(parse_page_query({ limit: "20", offset: "40" })).toEqual({ limit: 20, offset: 40 });
  });

  test("dms", () => {
    expect(parse_dms_body({ pairs: [[U(1), U(2)]] })).toEqual({ ok: true, value: { pairs: [[U(1), U(2)]] } });
    expect(parse_dms_body({ pairs: [[U(1), U(1)]] })).toMatchObject({ ok: false });
    expect(parse_dms_body({ pairs: [[U(1)]] })).toMatchObject({ ok: false });
    expect(parse_dms_body({ pairs: [] })).toMatchObject({ ok: false });
    expect(parse_dms_body({ pairs: Array.from({ length: CAPS.dm_pairs_per_call + 1 }, () => [U(1), U(2)]) })).toMatchObject({ reason: "cap_exceeded" });
  });

  test("groups", () => {
    expect(parse_groups_body({ count: 2, members_per_group: 5, include_me: true })).toEqual({
      ok: true, value: { count: 2, members_per_group: 5, include_me: true, title_prefix: null },
    });
    expect(parse_groups_body({ count: 2, members_per_group: 5 })).toMatchObject({ ok: true, value: { include_me: true } });
    expect(parse_groups_body({ count: 201, members_per_group: 5 })).toMatchObject({ reason: "cap_exceeded" });
    expect(parse_groups_body({ count: 1, members_per_group: 1001 })).toMatchObject({ reason: "cap_exceeded" });
    expect(parse_groups_body({ count: 1, members_per_group: 1000 })).toMatchObject({ ok: true });
    expect(parse_groups_body({ count: 1, members_per_group: 0, include_me: false })).toMatchObject({ ok: false });
    expect(parse_groups_body({ count: 1, members_per_group: 3, title_prefix: "run-7" })).toMatchObject({ ok: true, value: { title_prefix: "run-7" } });
    expect(parse_groups_body({ count: 1, members_per_group: 3, title_prefix: "bad prefix!" })).toMatchObject({ ok: false });
  });

  test("members", () => {
    expect(parse_members_body({ chat_ids: [U(1)], add: 2, remove: 1 })).toEqual({ ok: true, value: { chat_ids: [U(1)], add: 2, remove: 1 } });
    expect(parse_members_body({ chat_ids: [U(1)], add: 0, remove: 0 })).toMatchObject({ ok: false });
    expect(parse_members_body({ chat_ids: [], add: 1 })).toMatchObject({ ok: false });
    expect(parse_members_body({ chat_ids: ["nope"], add: 1 })).toMatchObject({ ok: false });
  });

  test("send", () => {
    const s = { chat_id: U(1), sender_id: U(2), n: 1 };
    expect(parse_send_body({ run: "abc123", sends: [s] })).toEqual({
      ok: true, value: { run: "abc123", sends: [{ ...s, N: null }], concurrency: CAPS.default_concurrency },
    });
    expect(parse_send_body({ run: "abc123", sends: [{ ...s, N: 5 }], concurrency: 200 })).toMatchObject({ ok: true, value: { concurrency: 200, sends: [{ N: 5 }] } });
    expect(parse_send_body({ run: "abc123", sends: [s], concurrency: 201 })).toMatchObject({ ok: false });
    expect(parse_send_body({ run: "abc123", sends: [s], concurrency: 0 })).toMatchObject({ ok: false });
    expect(parse_send_body({ run: "ABC123", sends: [s] })).toMatchObject({ ok: false });
    expect(parse_send_body({ run: "abc12", sends: [s] })).toMatchObject({ ok: false });
    expect(parse_send_body({ run: "abc123", sends: [{ ...s, n: 0 }] })).toMatchObject({ ok: false });
    expect(parse_send_body({ run: "abc123", sends: [{ ...s, N: 0 }] })).toMatchObject({ ok: false });
    expect(parse_send_body({ run: "abc123", sends: Array.from({ length: CAPS.sends_per_batch }, () => s) })).toMatchObject({ ok: true });
    expect(parse_send_body({ run: "abc123", sends: Array.from({ length: CAPS.sends_per_batch + 1 }, () => s) })).toMatchObject({ reason: "cap_exceeded" });
  });

  test("receipts / verify / cleanup", () => {
    expect(parse_receipts_body({ chat_ids: [U(1)], status: "read" })).toMatchObject({ ok: true });
    expect(parse_receipts_body({ chat_ids: [U(1)], status: "seen" })).toMatchObject({ ok: false });
    expect(parse_verify_body({ run: "abc123", chat_ids: [U(1), U(1).toUpperCase()] })).toEqual({ ok: true, value: { run: "abc123", chat_ids: [U(1)] } });
    expect(parse_verify_body({ run: "abc123", chat_ids: [] })).toMatchObject({ ok: false });
    expect(parse_cleanup_body({ scope: "me_out" })).toMatchObject({ ok: true });
    expect(parse_cleanup_body({ scope: "purge_queues" })).toMatchObject({ ok: true });
    expect(parse_cleanup_body({ scope: "everything" })).toMatchObject({ ok: false });
  });
});

describe("checksum", () => {
  test("first 8 hex chars of md5(id) as unsigned int, summed mod 2^32", () => {
    const id = "0192f0a0-0000-7000-8000-000000000001";
    const hex = createHash("md5").update(id).digest("hex").slice(0, 8);
    expect(id_checksum_part(id)).toBe(parseInt(hex, 16));
    const ids = Array.from({ length: 50 }, (_, i) => U(i));
    const expected = ids.reduce((s, x) => s + BigInt(id_checksum_part(x)), 0n) % 4294967296n;
    expect(checksum_of_ids(ids)).toBe(expected.toString());
    // order-independent
    expect(checksum_of_ids([...ids].reverse())).toBe(expected.toString());
    expect(checksum_of_ids([])).toBe("0");
  });

  test("folding partial sums equals the checksum over all ids", () => {
    const a = Array.from({ length: 30 }, (_, i) => U(i));
    const b = Array.from({ length: 30 }, (_, i) => U(100 + i));
    const part = (ids: string[]) => ids.reduce((s, x) => s + BigInt(id_checksum_part(x)), 0n).toString();
    expect(fold_checksums([part(a), part(b), null])).toBe(checksum_of_ids([...a, ...b]));
    // A sum far past 2^32 still folds exactly (BigInt, not float).
    expect(fold_checksums(["18446744073709551615", "1"])).toBe((18446744073709551616n % 4294967296n).toString());
  });
});

describe("verify math", () => {
  const run = "abc123";
  const A = U(1), B = U(2);
  const at = (i: number) => new Date(1_700_000_000_000 + i * 1000);
  // Chat rows (any body): stream A 1..5 with n=4 duplicated and 3/2 swapped
  // in seq order; stream B 1..3; one foreign-run row, one plain row, one
  // deleted run row (still holds its seq), and a seq gap at 9.
  const rows: RawRunRow[] = [
    { id: U(10), sender_id: A, body: format_body(1, run, 5), seq: 1, created_at: at(1) },
    { id: U(11), sender_id: A, body: format_body(3, run, 5), seq: 2, created_at: at(2) },
    { id: U(12), sender_id: A, body: format_body(2, run, 5), seq: 3, created_at: at(3) },
    { id: U(13), sender_id: B, body: format_body(1, run), seq: 4, created_at: at(4) },
    { id: U(14), sender_id: A, body: format_body(4, run, 5), seq: 5, created_at: at(5) },
    { id: U(15), sender_id: A, body: format_body(4, run, 5), seq: 6, created_at: at(6) },
    { id: U(16), sender_id: B, body: "hello", seq: 7, created_at: at(7) },
    { id: U(17), sender_id: B, body: format_body(2, "zzzzzz"), seq: 8, created_at: at(8) },
    { id: U(18), sender_id: B, body: format_body(2, run), seq: 10, created_at: at(10) },
    { id: U(19), sender_id: A, body: format_body(5, run, 5), seq: 11, created_at: at(11), deleted: true },
    { id: U(20), sender_id: A, body: format_body(5, run, 5), seq: 12, created_at: at(12) },
    { id: U(21), sender_id: B, body: format_body(3, run), seq: 13, created_at: at(13) },
  ];

  test("reference summary over fixture rows", () => {
    const s = summarize_run_rows(run, rows);
    expect(s.total).toBe(9);
    expect(s.checksum).toBe(checksum_of_ids([U(10), U(11), U(12), U(13), U(14), U(15), U(18), U(20), U(21)]));
    const sa = s.streams.find((x) => x.sender_id === A)!;
    const sb = s.streams.find((x) => x.sender_id === B)!;
    expect(sa).toEqual({ sender_id: A, count: 6, distinct_n: 5, min_n: 1, max_n: 5, declared_N: 5, duplicates: 1, order_violations: 1 });
    expect(sb).toEqual({ sender_id: B, count: 3, distinct_n: 3, min_n: 1, max_n: 3, declared_N: null, duplicates: 0, order_violations: 0 });
    // span 1..13 = 13 values; 12 rows hold one (the deleted one included) → 1 hole (seq 9).
    expect(s.seq).toEqual({ min: 1, max: 13, rows_in_range: 12, holes: 1 });
  });

  test("order falls back to created_at when the chat is unnumbered", () => {
    const un = rows.map((r) => ({ ...r, seq: null }));
    const s = summarize_run_rows(run, un);
    expect(s.seq).toBeNull();
    expect(s.streams.find((x) => x.sender_id === A)!.order_violations).toBe(1);
  });

  test("build_verify_chat folds the SQL's per-stream rows to the same answer", () => {
    const ref = summarize_run_rows(run, rows);
    const part = (ids: string[]) => ids.reduce((s, x) => s + BigInt(id_checksum_part(x)), 0n).toString();
    const agg: StreamAggRow[] = [
      { chat_id: U(99), sender_id: A, cnt: 6, distinct_n: 5, min_n: "1", max_n: "5", declared_n: "5", order_violations: 1, ck_sum: part([U(10), U(11), U(12), U(14), U(15), U(20)]), min_seq: "1", max_seq: "12" },
      { chat_id: U(99), sender_id: B, cnt: 3, distinct_n: 3, min_n: "1", max_n: "3", declared_n: null, order_violations: 0, ck_sum: part([U(13), U(18), U(21)]), min_seq: "4", max_seq: "13" },
    ];
    const v = build_verify_chat(U(99), agg, { rows_in_range: 12, my_unread: 4, my_read_seq: 3, my_delivered_seq: 13 });
    expect(v.total).toBe(ref.total);
    expect(v.checksum).toBe(ref.checksum);
    expect(v.streams).toEqual(ref.streams);
    expect(v.seq).toEqual(ref.seq);
    expect(v).toMatchObject({ my_unread: 4, my_read_seq: 3, my_delivered_seq: 13 });
  });

  test("an empty chat", () => {
    const v = build_verify_chat(U(98), [], { rows_in_range: 0, my_unread: 0, my_read_seq: null, my_delivered_seq: null });
    expect(v).toEqual({ chat_id: U(98), total: 0, checksum: "0", streams: [], seq: null, my_unread: 0, my_read_seq: null, my_delivered_seq: null });
  });
});

describe("stats + pools", () => {
  test("percentile (nearest rank)", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    const v = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 100)).toBe(100);
  });

  test("send_stats splits ok / refused / failed", () => {
    const r = (ok: boolean, code: number, ms: number) => ({ chat_id: U(1), sender_id: U(2), n: 1, id: U(3), ok, code, ms });
    expect(send_stats([r(true, 200, 10), r(false, 403, 1), r(false, 404, 2), r(false, 500, 30)], 40)).toEqual({
      ok: 1, failed: 1, refused: 2, ms_p50: 2, ms_p95: 30, ms_max: 30, wall_ms: 40,
    });
  });

  test("run_pool keeps input order and the limit", async () => {
    let inflight = 0, peak = 0;
    const out = await run_pool(Array.from({ length: 20 }, (_, i) => i), 3, async (x) => {
      inflight++; peak = Math.max(peak, inflight);
      await Bun.sleep(Math.random() * 5);
      inflight--;
      return x * 2;
    });
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("run_keyed_pool: one key strictly serial and in order, keys concurrent", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ k: `s${i % 4}`, n: Math.floor(i / 4) + 1 }));
    const seen = new Map<string, number[]>();
    const busy = new Set<string>();
    let inflight = 0, peak = 0;
    const out = await run_keyed_pool(items, (x) => x.k, 10, async (x) => {
      expect(busy.has(x.k)).toBe(false); // never two of one stream at once
      busy.add(x.k);
      inflight++; peak = Math.max(peak, inflight);
      await Bun.sleep(Math.random() * 4);
      (seen.get(x.k) ?? seen.set(x.k, []).get(x.k)!).push(x.n);
      busy.delete(x.k);
      inflight--;
      return `${x.k}:${x.n}`;
    });
    expect(out).toEqual(items.map((x) => `${x.k}:${x.n}`));
    for (const ns of seen.values()) expect(ns).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(peak).toBeLessThanOrEqual(4); // 4 streams → at most 4 in flight
    expect(peak).toBeGreaterThan(1);
  });

  test("pick_random: distinct, bounded", () => {
    const pool = Array.from({ length: 10 }, (_, i) => i);
    const p = pick_random(pool, 4);
    expect(new Set(p).size).toBe(4);
    expect(pick_random(pool, 50).sort((a, b) => a - b)).toEqual(pool);
    expect(pick_random(pool, 0)).toEqual([]);
  });
});
