// Unit tests for the pure broadcast-list helpers. No database / Redis: these
// modules deliberately import nothing that connects. Run: `bun test tests/`.
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  BROADCAST_TITLE_MAX_CHARS,
  LOCK_NS_DM_PAIR,
  chunk,
  derive_broadcast_copy_id,
  dm_pair_lock_key,
  dm_pair_locks_sql,
  for_each_with_concurrency,
  is_uuid,
  normalize_broadcast_title,
  normalize_recipient_ids,
  tx_timeouts_sql,
} from "@/utils/broadcast.utils";
import { resolve_stored_sent_at } from "@/utils/message-time.utils";

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A real UUIDv7: 48-bit ms timestamp 0x0192_5f3a_1b2c.
const BROADCAST_V7 = "01925f3a-1b2c-7d4e-9f00-112233445566";
const RECIPIENT_A = "5f0c9a2e-8d3b-4f1a-9c7e-0a1b2c3d4e5f";
const RECIPIENT_B = "6a1d0b3f-9e4c-4a2b-8d8f-1b2c3d4e5f60";

describe("derive_broadcast_copy_id", () => {
  test("is deterministic for the same (broadcast, recipient)", () => {
    const a1 = derive_broadcast_copy_id(BROADCAST_V7, RECIPIENT_A, 0);
    const a2 = derive_broadcast_copy_id(BROADCAST_V7, RECIPIENT_A, 123456);
    expect(a1).toBe(a2);
  });

  test("differs per recipient and per broadcast message", () => {
    const a = derive_broadcast_copy_id(BROADCAST_V7, RECIPIENT_A, 0);
    const b = derive_broadcast_copy_id(BROADCAST_V7, RECIPIENT_B, 0);
    const other = derive_broadcast_copy_id("01925f3a-1b2c-7d4e-9f00-112233445567", RECIPIENT_A, 0);
    expect(a).not.toBe(b);
    expect(a).not.toBe(other);
  });

  test("is a valid UUIDv7 (version 7, RFC 4122 variant)", () => {
    for (const rid of [RECIPIENT_A, RECIPIENT_B]) {
      const id = derive_broadcast_copy_id(BROADCAST_V7, rid, 0);
      expect(id).toMatch(UUIDV7_RE);
      expect(is_uuid(id)).toBe(true);
    }
  });

  test("keeps the broadcast id's 48-bit timestamp when it is a v7", () => {
    const id = derive_broadcast_copy_id(BROADCAST_V7, RECIPIENT_A, 999);
    expect(id.slice(0, 13)).toBe(BROADCAST_V7.slice(0, 13)); // "01925f3a-1b2c"
  });

  test("falls back to the given ms when the broadcast id is not a v7", () => {
    const v4 = "9b2f1c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const ms = Date.UTC(2026, 9, 8, 12, 0, 0);
    const id = derive_broadcast_copy_id(v4, RECIPIENT_A, ms);
    const hex = ms.toString(16).padStart(12, "0");
    expect(id.replace(/-/g, "").slice(0, 12)).toBe(hex);
    expect(id).toMatch(UUIDV7_RE);
  });

  test("copies sort by their broadcast message's time", () => {
    const earlier = derive_broadcast_copy_id("01925f3a-1b2c-7000-8000-000000000000", RECIPIENT_A, 0);
    const later = derive_broadcast_copy_id("01925f3a-1b2d-7000-8000-000000000000", RECIPIENT_A, 0);
    expect(earlier < later).toBe(true);
  });

  test("is case-insensitive in its inputs", () => {
    expect(derive_broadcast_copy_id(BROADCAST_V7.toUpperCase(), RECIPIENT_A.toUpperCase(), 0))
      .toBe(derive_broadcast_copy_id(BROADCAST_V7, RECIPIENT_A, 0));
  });
});

describe("normalize_broadcast_title", () => {
  test("null / undefined / blank → null", () => {
    expect(normalize_broadcast_title(null)).toEqual({ ok: true, value: null });
    expect(normalize_broadcast_title(undefined)).toEqual({ ok: true, value: null });
    expect(normalize_broadcast_title("   \n\t ")).toEqual({ ok: true, value: null });
  });

  test("trims", () => {
    expect(normalize_broadcast_title("  Family  ")).toEqual({ ok: true, value: "Family" });
  });

  test("accepts exactly the max, rejects one more", () => {
    const max = "x".repeat(BROADCAST_TITLE_MAX_CHARS);
    expect(normalize_broadcast_title(max)).toEqual({ ok: true, value: max });
    expect(normalize_broadcast_title(max + "x").ok).toBe(false);
  });

  test("counts an emoji as one character", () => {
    const emoji_title = "🎉".repeat(BROADCAST_TITLE_MAX_CHARS); // 200 UTF-16 units
    expect(normalize_broadcast_title(emoji_title).ok).toBe(true);
  });

  test("rejects non-strings", () => {
    expect(normalize_broadcast_title(42).ok).toBe(false);
  });
});

describe("normalize_recipient_ids", () => {
  const SELF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  test("dedupes (case-insensitively), drops self and non-uuids, keeps order", () => {
    const out = normalize_recipient_ids(
      [RECIPIENT_B, "not-a-uuid", RECIPIENT_A, RECIPIENT_B.toUpperCase(), SELF.toUpperCase(), 7, null, RECIPIENT_A],
      SELF,
    );
    expect(out).toEqual([RECIPIENT_B, RECIPIENT_A]);
  });

  test("lowercases ids", () => {
    expect(normalize_recipient_ids([RECIPIENT_A.toUpperCase()], SELF)).toEqual([RECIPIENT_A]);
  });

  test("non-array → empty", () => {
    expect(normalize_recipient_ids(undefined, SELF)).toEqual([]);
    expect(normalize_recipient_ids("x", SELF)).toEqual([]);
  });
});

describe("resolve_stored_sent_at", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");

  test("keeps a past client stamp for non-media", () => {
    const past = "2026-10-08T11:00:00.000Z";
    expect(resolve_stored_sent_at("text", past, now).toISOString()).toBe(past);
  });

  test("clamps a future client stamp to server time", () => {
    expect(resolve_stored_sent_at("text", "2026-10-08T12:05:00.000Z", now)).toBe(now);
  });

  test("unparseable → server time", () => {
    expect(resolve_stored_sent_at("text", "garbage", now)).toBe(now);
    expect(resolve_stored_sent_at("contact", undefined, now)).toBe(now);
  });

  test("uploaded media always uses server arrival time", () => {
    for (const t of ["image", "video", "audio", "document", "media", "attachment", "sticker"]) {
      expect(resolve_stored_sent_at(t, "2026-10-08T11:00:00.000Z", now)).toBe(now);
    }
  });
});

describe("for_each_with_concurrency", () => {
  test("processes every item and never exceeds the limit", async () => {
    let in_flight = 0;
    let peak = 0;
    const seen: number[] = [];
    const items = Array.from({ length: 60 }, (_, i) => i);
    await for_each_with_concurrency(items, 7, async (item) => {
      in_flight++;
      peak = Math.max(peak, in_flight);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(item);
      in_flight--;
    });
    expect(peak).toBeLessThanOrEqual(7);
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  test("a failing item doesn't stop the others and never rejects", async () => {
    const done: number[] = [];
    const original = console.error;
    console.error = () => {};
    try {
      await for_each_with_concurrency([1, 2, 3, 4], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        done.push(n);
      });
    } finally {
      console.error = original;
    }
    expect(done.sort()).toEqual([1, 3, 4]);
  });

  test("empty input resolves", async () => {
    await for_each_with_concurrency([], 25, async () => {
      throw new Error("never called");
    });
  });
});

// Renders a drizzle SQL object without a connection.
const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(q);

describe("dm_pair_lock_key", () => {
  test("is symmetric — A→B and B→A take the same lock", () => {
    expect(dm_pair_lock_key(RECIPIENT_A, RECIPIENT_B)).toBe(dm_pair_lock_key(RECIPIENT_B, RECIPIENT_A));
  });

  test("is case-insensitive and sorted", () => {
    expect(dm_pair_lock_key(RECIPIENT_B.toUpperCase(), RECIPIENT_A)).toBe(`${RECIPIENT_A}:${RECIPIENT_B}`);
  });

  test("matches the key the broadcast path used before the helper existed", () => {
    // Old inline form: sender_lc < rid ? `${sender_lc}:${rid}` : `${rid}:${sender_lc}`
    const sender_lc = RECIPIENT_B;
    const rid = RECIPIENT_A;
    const legacy = sender_lc < rid ? `${sender_lc}:${rid}` : `${rid}:${sender_lc}`;
    expect(dm_pair_lock_key(sender_lc, rid)).toBe(legacy);
  });
});

describe("dm_pair_locks_sql", () => {
  test("binds the pair namespace and the keys deduped + sorted", () => {
    const k1 = dm_pair_lock_key(RECIPIENT_A, RECIPIENT_B);
    const k0 = dm_pair_lock_key(BROADCAST_V7, RECIPIENT_A); // sorts before k1
    const { sql, params } = render(dm_pair_locks_sql([k1, k0, k1]));
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("ORDER BY k");
    expect(params).toEqual([LOCK_NS_DM_PAIR, k0, k1]);
  });
});

describe("tx_timeouts_sql", () => {
  test("sets lock + statement timeouts transaction-locally in one statement", () => {
    const { sql, params } = render(tx_timeouts_sql());
    expect(sql).toBe(
      "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
    );
    expect(params).toEqual(["10s", "20s"]);
  });
});

describe("chunk", () => {
  test("splits into slices of at most size, in order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  test("empty input → no chunks; a bad size degrades to 1", () => {
    expect(chunk([], 1000)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});
