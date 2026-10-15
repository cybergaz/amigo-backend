// =============================================================================
// Poll v1 read planning: ack-drained entries are NOT deleted on read
// =============================================================================
// SYNC_V2 R0.1 / field bug F2-1. Pure — no db / redis import, so it can be
// unit-tested (tests/poll-ack-drain.test.ts); polling.cache.ts does the I/O.
//
// Poll v1 used to delete every entry it returned BEFORE the HTTP response
// reached the phone. On cheap Wi-Fi, and on a phone whose network Android cuts
// ~5-10 s after a background wake, that response is often lost, and every
// message in it was gone for good (the client cannot ask again).
//
// Now a message:new entry the client will ack is KEPT after it is returned.
// It is removed by the existing drain-on-ack paths (WS / poll status ack →
// handle_message_status_ack, POST /message/delivered[/batch] →
// mark_message_delivered), which compute the same deterministic key. Until
// then it is re-sent, with a growing hold so an ack still in flight (client
// debounce 800 ms + RTT) does not cause an immediate duplicate. Re-sends are
// harmless: clients store message:new with INSERT OR IGNORE by id and acks are
// idempotent.
//
// Safety expiry counts from the FIRST RETURN, never from store time: a phone
// in Doze can go hours or days without polling, and age-from-store would
// delete messages it never saw. An entry returned but never acked (a client
// path that never acks) is dropped RESEND_EXPIRY_MS after its first return.
//
// Everything else keeps delete-on-read: those types have no ack path, so
// keeping them would re-send them until expiry. That includes message:new
// that the client deliberately never acks (own messages, system messages:
// chat.provider _handleNewMessage skips the ack for both) and entries whose
// key is not the drainable one (pre-deploy random keys).
//
// RC-3 (§13.7 C2): every drain this module plans is a compare-and-delete on
// the entry's store-time version `v` (pending-store-core.ts): the poll read
// deletes "the version it returned or older", so a newer version stored
// between the read and the delete survives; the delivered acks delete any
// version (they name a message, and every version of its key is that same
// message). The return marks (ret_v1) stay keyed by correlation key: a
// re-store of a message:new key is the same message, so its hold / expiry
// history carries over.

// First re-send hold; doubles per return, capped. 5 s covers the client's
// 800 ms ack debounce plus a slow round trip; the cap keeps a never-acking
// but constantly polling client at ~2 re-sends/hour.
const RESEND_HOLD_BASE_MS = 5_000;
const RESEND_HOLD_MAX_MS = 30 * 60 * 1000;
// Generous: covers a phone that polled once (response lost) and then slept
// for days. The Redis tier TTL (7 d from the last store) and the 30-day DB
// tier mean an entry can outlive its Redis copy and still be served from DB.
const RESEND_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
// Return-meta hash TTL, refreshed on every write. Longer than the expiry so
// the meta outlives the entries it describes.
const RETURN_META_TTL_SECONDS = 8 * 24 * 60 * 60;

type ReturnMeta = {
  first: number; // epoch ms of the first return
  last: number;  // epoch ms of the latest return
  n: number;     // how many times it was returned
  // Poll v2 (R3) only: the entry version (store-time v) that was returned.
  // v2 marks every type it hands out, and for a self-compacting key (pin,
  // react, user:update…) a re-store is a NEW fact, so its hold must not
  // carry over; v1 marks only message:new, where every version is the same
  // message, and writes no v.
  v?: string;
};

type PlannableEntry = {
  message_id: string; // correlation key
  created_at: number;
  ws_message: { type: string; payload?: unknown };
};

// Same shape as Snowflake.correlationId for a deterministic id. Duplicated
// (not imported) to keep this module free of runtime imports; the test pins
// both to the same output.
const message_new_key = (user_id: string, message_id: string): string =>
  `${user_id}:message:new:${message_id}`;

// True when the entry stays queued after it is returned and is removed only
// by a delivered ack. Mirrors the client's ack rule: it acks message:new
// unless the sender is the user itself or the message is a system message.
const is_ack_drained = (user_id: string, entry: PlannableEntry): boolean => {
  if (entry.ws_message.type !== "message:new") return false;
  const p = (entry.ws_message.payload ?? {}) as Record<string, unknown>;
  const id = typeof p.id === "string" && p.id.length > 0 ? p.id : undefined;
  if (!id) return false;
  if (p.sender_id === user_id) return false;
  if (p.msg_type === "system") return false;
  // Only an entry stored under the exact key the ack path deletes can drain.
  return entry.message_id === message_new_key(user_id, id);
};

const message_id_of = (entry: PlannableEntry): string | undefined => {
  const p = (entry.ws_message.payload ?? {}) as Record<string, unknown>;
  return typeof p.id === "string" ? p.id : undefined;
};

const resend_hold_ms = (returns_so_far: number): number => {
  if (returns_so_far <= 0) return 0;
  const exp = Math.min(returns_so_far - 1, 20); // 2^20 × 5 s ≫ cap
  return Math.min(RESEND_HOLD_BASE_MS * 2 ** exp, RESEND_HOLD_MAX_MS);
};

// "first:last:n" (v1) or "first:last:n:v" (poll v2, R3; v may be "" for an
// entry from a build before RC-3). Anything unparsable reads as "never
// returned", which only costs one extra re-send. v1 reads a v2 mark as its
// first three fields (same meaning), so a user moving between the two never
// loses its hold / expiry history.
const parse_return_meta = (raw: string | null | undefined): ReturnMeta | undefined => {
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const [first, last, n] = parts.slice(0, 3).map(Number);
  if (![first, last, n].every(Number.isFinite) || n < 1) return undefined;
  if (parts.length === 3) return { first, last, n };
  // The version is a store-time UUIDv7 or "" (pre-RC-3 entry); anything
  // else is junk like any other malformed mark.
  if (!STORE_V_RE.test(parts[3]!)) return undefined;
  return { first, last, n, v: parts[3] };
};
const STORE_V_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

const format_return_meta = (m: ReturnMeta): string =>
  m.v === undefined ? `${m.first}:${m.last}:${m.n}` : `${m.first}:${m.last}:${m.n}:${m.v}`;

type ClassifiedRead<T extends PlannableEntry> = {
  candidates: T[];     // returnable now, replay order
  resend_keys: Set<string>; // candidates that were returned before
  held: number;        // ack-drained, returned recently, not re-sent yet
  expired_keys: string[]; // ack-drained, first returned > RESEND_EXPIRY_MS ago
};

// Step 1: split the (already replay-sorted) union of all tiers.
// `ignore_hold`: the reconnect gap-fill GET (for_sync). It is the only
// pending read a WS carrier makes, so a held entry it skipped would wait for
// the next reconnect (often the next resume) while the user is in the app.
// A duplicate costs nothing (INSERT OR IGNORE by id); expiry still applies.
const classify_pending_read = <T extends PlannableEntry>(
  user_id: string,
  sorted: T[],
  meta: Map<string, ReturnMeta>,
  now: number,
  ignore_hold: boolean = false,
): ClassifiedRead<T> => {
  const candidates: T[] = [];
  const resend_keys = new Set<string>();
  const expired_keys: string[] = [];
  let held = 0;
  for (const entry of sorted) {
    if (!is_ack_drained(user_id, entry)) {
      candidates.push(entry);
      continue;
    }
    const m = meta.get(entry.message_id);
    if (!m) {
      candidates.push(entry);
      continue;
    }
    if (now - m.first >= RESEND_EXPIRY_MS) {
      expired_keys.push(entry.message_id);
      continue;
    }
    if (!ignore_hold && now - m.last < resend_hold_ms(m.n)) {
      held++;
      continue;
    }
    candidates.push(entry);
    resend_keys.add(entry.message_id);
  }
  return { candidates, resend_keys, held, expired_keys };
};

type FinalRead<T extends PlannableEntry> = {
  result: T[];                       // what this poll returns
  delete_keys: string[];             // returned, delete-on-read types
  meta_updates: Map<string, ReturnMeta>; // returned, ack-drained
  resent: number;                    // returned again without an ack
};

// Step 2 (after the caller dropped candidates whose message was deleted):
// cap the response and work out what to delete and what to remember.
const finalize_pending_read = <T extends PlannableEntry>(
  user_id: string,
  candidates: T[],
  meta: Map<string, ReturnMeta>,
  cap: number,
  now: number,
): FinalRead<T> => {
  const result = candidates.length > cap ? candidates.slice(0, cap) : candidates;
  const delete_keys: string[] = [];
  const meta_updates = new Map<string, ReturnMeta>();
  let resent = 0;
  for (const entry of result) {
    if (!is_ack_drained(user_id, entry)) {
      delete_keys.push(entry.message_id);
      continue;
    }
    const m = meta.get(entry.message_id);
    if (m) resent++;
    meta_updates.set(entry.message_id, {
      first: m?.first ?? now,
      last: now,
      n: (m?.n ?? 0) + 1,
    });
  }
  return { result, delete_keys, meta_updates, resent };
};

// Tier merge (RC-3): the newer store wins whichever tier holds it. `v` is a
// UUIDv7, so string order is store order; "" (an entry from a build before
// RC-3, or a DB row with entry_v NULL) is older than any versioned one. On
// equal versions `b` wins: the caller passes the Redis copy as `b`, which is
// what "Redis wins" meant before versions existed.
const newer_pending_entry = <T extends { v: string }>(a: T, b: T): T => (a.v > b.v ? a : b);

// Meta fields whose entry no longer exists in any tier (trimmed by the
// per-user cap, or drained by a sibling worker before its meta write landed).
const stale_meta_keys = (meta: Map<string, ReturnMeta>, live_keys: Set<string>): string[] => {
  const out: string[] = [];
  for (const k of meta.keys()) if (!live_keys.has(k)) out.push(k);
  return out;
};

export {
  RESEND_HOLD_BASE_MS,
  RESEND_HOLD_MAX_MS,
  RESEND_EXPIRY_MS,
  RETURN_META_TTL_SECONDS,
  message_new_key,
  is_ack_drained,
  message_id_of,
  resend_hold_ms,
  parse_return_meta,
  format_return_meta,
  classify_pending_read,
  finalize_pending_read,
  stale_meta_keys,
  newer_pending_entry,
};
export type { ReturnMeta, PlannableEntry, ClassifiedRead, FinalRead };
