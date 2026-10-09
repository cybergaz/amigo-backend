import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

// Pure helpers for broadcast lists (see BROADCAST_LISTS.md). Deliberately free
// of db / redis imports so they can be unit-tested without a database. (The
// drizzle `sql` builders below only BUILD statements; callers execute them.)

// Product limits, locked with the user 2026-10-08.
const BROADCAST_MAX_RECIPIENTS = 250;
const BROADCAST_TITLE_MAX_CHARS = 100;
// Max broadcast message ids per POST /chat/broadcast/copies.
const BROADCAST_COPIES_MAX_IDS = 100;
// Per-recipient delivery concurrency for the send fan-out. Each delivery is a
// couple of Redis round-trips (pending-queue store) plus a ws.send; 25 in
// flight keeps a 250-recipient fan-out to ~10 sequential waves without letting
// one send monopolise the Redis connection.
const BROADCAST_FANOUT_CONCURRENCY = 25;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const is_uuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v);

/**
 * Deterministic, UUIDv7-shaped id for the copy of broadcast message
 * `broadcast_msg_id` delivered to `recipient_id`.
 *
 *   - bits 0-47  : the broadcast message's own 48-bit unix-ms timestamp (the
 *                  client mints UUIDv7 ids), so copies sort exactly where the
 *                  original does in every id-ordered structure. If the id is
 *                  not a v7 we fall back to `fallback_ms` (the stored sent_at).
 *   - version 7 / RFC 4122 variant bits, so the result is a valid UUIDv7.
 *   - every other bit comes from SHA-256(`${broadcast_msg_id}:${recipient_id}`).
 *
 * Deterministic on purpose: a duplicate send of the same broadcast message
 * re-derives the SAME copy ids, so the idempotent onConflictDoNothing insert
 * makes a resend a no-op instead of minting a second copy recipients can't
 * dedup (the root cause of the old duplicate-message bug).
 */
const derive_broadcast_copy_id = (
  broadcast_msg_id: string,
  recipient_id: string,
  fallback_ms: number,
): string => {
  // Postgres hands uuids back lowercase; normalise so the derivation never
  // depends on how the client happened to case the id.
  const bid = broadcast_msg_id.toLowerCase();
  const rid = recipient_id.toLowerCase();
  const hex = bid.replace(/-/g, "");

  const ts_hex =
    UUID_RE.test(bid) && hex[12] === "7"
      ? hex.slice(0, 12)
      : Math.max(0, Math.floor(Number.isFinite(fallback_ms) ? fallback_ms : 0))
        .toString(16)
        .padStart(12, "0")
        .slice(-12);

  const h = createHash("sha256").update(`${bid}:${rid}`).digest("hex");
  // Variant nibble: top two bits 10 (RFC 4122), low two bits from the hash.
  const variant = ((parseInt(h[3], 16) & 0x3) | 0x8).toString(16);
  const out = ts_hex + "7" + h.slice(0, 3) + variant + h.slice(4, 19);

  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`;
};

type TitleResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Normalise a list title: trimmed, empty → null (the client then shows
 * "N recipients"), at most BROADCAST_TITLE_MAX_CHARS characters (counted in
 * code points so an emoji is one character, not two UTF-16 units).
 */
const normalize_broadcast_title = (raw: unknown): TitleResult => {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: "title must be a string or null" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if ([...trimmed].length > BROADCAST_TITLE_MAX_CHARS) {
    return { ok: false, message: `title must be at most ${BROADCAST_TITLE_MAX_CHARS} characters` };
  }
  return { ok: true, value: trimmed };
};

/**
 * Dedupe a client-supplied id list, drop the caller's own id (you can't
 * broadcast to yourself) and anything that is not a UUID (it can never match a
 * user, and would otherwise 500 the uuid-typed IN query). Lowercased so the
 * dedupe is case-insensitive like Postgres' uuid equality. Order preserved.
 */
const normalize_recipient_ids = (ids: unknown, self_id: string): string[] => {
  if (!Array.isArray(ids)) return [];
  const self = self_id.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (!is_uuid(raw)) continue;
    const id = raw.toLowerCase();
    if (id === self || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

// ─── transaction guards / advisory locks ────────────────────────────────────

// pg_advisory_xact_lock(int4, int4) namespaces. ASCII "BCST" / "BCPR" — only
// need to be distinct from any other advisory-lock user (there are none today).
const LOCK_NS_BROADCAST_SENDER = 0x42435354;
const LOCK_NS_DM_PAIR = 0x42435052;

/**
 * Canonical advisory-lock key for the 1:1 DM between `a` and `b`: both ids
 * lowercased (a request body may carry an upper-case uuid; Postgres compares
 * uuids case-insensitively but hashtext does not) and sorted, so A→B and B→A
 * hash to the SAME lock. Every path that may CREATE a DM — create_dm and the
 * broadcast send — must derive its key here, or the two would lock different
 * keys and could each mint a DM for the same pair.
 */
const dm_pair_lock_key = (a: string, b: string): string => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? `${x}:${y}` : `${y}:${x}`;
};

/**
 * One statement taking the DM-pair transaction locks for every key. Keys are
 * deduped and acquired in sorted order (volatile select-list items are
 * evaluated after ORDER BY), so two transactions with overlapping pairs always
 * lock in the same order and can't deadlock. Pass keys from dm_pair_lock_key.
 */
const dm_pair_locks_sql = (pair_keys: readonly string[]): SQL => {
  const keys = Array.from(new Set(pair_keys)).sort();
  return sql`
    SELECT pg_advisory_xact_lock(${LOCK_NS_DM_PAIR}::int, hashtext(k))
    FROM unnest(ARRAY[${sql.join(keys.map((k) => sql`${k}::text`), sql`, `)}]) AS k
    ORDER BY k
  `;
};

// Timeouts for the transactions that take the advisory locks above. Without
// them a stalled lock holder (a wedged worker mid-transaction) parks every
// later sender on pg_advisory_xact_lock indefinitely, each pinning a pooled
// connection, until the whole pool is gone. With them the waiter fails after
// 10s → the send acks 500 (transient: the client keeps it pending and the GC
// retry re-runs the idempotent transaction). set_config(.., true) == SET LOCAL
// — scoped to this transaction only — and both fit in ONE round-trip.
const TX_LOCK_TIMEOUT = "10s";
const TX_STATEMENT_TIMEOUT = "20s";
const tx_timeouts_sql = (): SQL =>
  sql`SELECT set_config('lock_timeout', ${TX_LOCK_TIMEOUT}, true), set_config('statement_timeout', ${TX_STATEMENT_TIMEOUT}, true)`;

/** Split `items` into consecutive slices of at most `size` (size < 1 → 1). */
const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Never rejects:
 * a failure for one item is logged and the rest carry on — one bad recipient
 * must not cost the other 249 their message.
 */
const for_each_with_concurrency = async <T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (err) {
        console.error("[BROADCAST] fan-out item failed:", err);
      }
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
};

export {
  BROADCAST_MAX_RECIPIENTS,
  BROADCAST_TITLE_MAX_CHARS,
  BROADCAST_COPIES_MAX_IDS,
  BROADCAST_FANOUT_CONCURRENCY,
  LOCK_NS_BROADCAST_SENDER,
  LOCK_NS_DM_PAIR,
  is_uuid,
  derive_broadcast_copy_id,
  normalize_broadcast_title,
  normalize_recipient_ids,
  dm_pair_lock_key,
  dm_pair_locks_sql,
  tx_timeouts_sql,
  chunk,
  for_each_with_concurrency,
};
