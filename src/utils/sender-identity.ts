// =============================================================================
// Sender identity — who a client frame / request acts AS
// =============================================================================
// The actor of every send / forward / delete is the AUTHENTICATED user (the
// socket's ws.data user id, or the request's JWT id). Ids a client puts in a
// payload (message:new sender_id, message:forward forwarder_id, typing
// sender_id) were trusted outright, so anyone could send as anyone. They are
// now overwritten with the authenticated id. Wire formats are unchanged: an
// honest client sends its own id, so for it the overwrite is a no-op.
//
// Pure helpers only (no DB / Redis) so they can be unit-tested in isolation.

import { count } from "@/utils/counters";

// UUIDs compare case-insensitively (a client may upper-case them).
const same_user_id = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// Outcome of pin_identity:
//   "ok"          — the payload now carries the authenticated id (it was
//                   already right, or missing / empty and filled in);
//   "spoofed"     — the client claimed a DIFFERENT id; overwritten, counted;
//   "no_identity" — there is NO authenticated id: the caller MUST refuse the
//                   frame. Fails closed: whatever id the client claimed is
//                   removed from the payload, so even a caller that ignored the
//                   result could never act as that id;
//   "no_payload"  — nothing to pin into (null / non-object payload): refused too.
type PinResult = "ok" | "spoofed" | "no_identity" | "no_payload";

// Must the frame be refused? (pin_identity found nobody to act as / nothing to act on.)
const pin_refused = (r: PinResult): boolean => r === "no_identity" || r === "no_payload";

// Overwrite `payload[field]` with the authenticated id, in place (every later
// reader of the payload — store, acks, fan-out, the poll route's reply — then
// sees the trusted id). A client that claimed a DIFFERENT, non-empty id is a
// spoof attempt or a broken client: counted (AUTH/<event>_spoofed) and logged;
// the frame itself is still processed as the authenticated user. A missing /
// empty id is filled in silently. With no authenticated id there is nobody to
// act as: counted (AUTH/no_identity) and "no_identity" is returned.
const pin_identity = <T extends object>(
  payload: T | null | undefined,
  field: keyof T & string,
  auth_user_id: string | null | undefined,
  event: string,
): PinResult => {
  const has_payload = !!payload && typeof payload === "object";
  if (!auth_user_id || typeof auth_user_id !== "string") {
    if (has_payload) delete (payload as Record<string, unknown>)[field];
    count("AUTH", "no_identity");
    console.warn(`[AUTH] ${event}: no authenticated user id; frame refused`);
    return "no_identity";
  }
  // Nothing to pin into: the caller cannot act on it either (its handlers read
  // the payload), so it is refused too.
  if (!has_payload) return "no_payload";
  const claimed = (payload as Record<string, unknown>)[field];
  const spoofed = typeof claimed === "string" && claimed !== "" && !same_user_id(claimed, auth_user_id);
  (payload as Record<string, unknown>)[field] = auth_user_id;
  if (spoofed) {
    count("AUTH", `${event.replace(/[^a-z_]/gi, "_")}_spoofed`);
    console.warn(
      `[AUTH] ${event}: payload.${field}=${String(claimed)} != authenticated ${auth_user_id}; using the authenticated id`,
    );
    return "spoofed";
  }
  return "ok";
};

// ── forward gates ─────────────────────────────────────────────────────────────

// One chat_members row of the forwarder (joined with the chat's type).
type ForwarderMembershipRow = {
  chat_id: string | null;
  chat_type: string | null;
  status: string | null;
  removed_at: Date | string | null;
  joined_at: Date | string | null;
  cleared_at: Date | string | null;
};

// May the forwarder post into this TARGET chat? Same rule as message:new's
// send guard: an active member. Groups additionally need removed_at IS NULL
// (a removed member keeps a historical row). A DM the forwarder "deleted for
// me" (removed_at set, status still 'active') stays postable, exactly as the
// send path allows it. A chat may have several rows (re-joins): any one passing
// admits it.
const forward_target_allowed = (rows: ForwarderMembershipRow[]): boolean =>
  rows.some((r) =>
    r.status === "active" && (r.removed_at == null || r.chat_type === "dm"));

// May the forwarder READ the SOURCE chat, and from which point? Same gate as
// get_conversation_history: an ACTIVE, non-removed member, who sees only
// messages created after max(joined_at, cleared_at). Returns null when the
// chat is not readable at all, else the floor (null = no floor).
const forward_source_floor = (
  rows: ForwarderMembershipRow[],
): { floor: Date | null } | null => {
  const r = rows.find((x) => x.status === "active" && x.removed_at == null);
  if (!r) return null;
  const ts = [r.joined_at, r.cleared_at]
    .filter((x): x is Date | string => x != null)
    .map((x) => new Date(x).getTime())
    .filter((t) => Number.isFinite(t));
  return { floor: ts.length ? new Date(Math.max(...ts)) : null };
};

// The source messages the forwarder is allowed to see (strictly after the floor,
// like history's gt()).
const readable_after_floor = <M extends { created_at: Date | string | null }>(
  messages: M[],
  floor: Date | null,
): M[] => {
  if (!floor) return messages;
  const f = floor.getTime();
  return messages.filter((m) => {
    if (m.created_at == null) return false;
    const t = new Date(m.created_at).getTime();
    return Number.isFinite(t) && t > f;
  });
};

// ── message:new idempotent resend ─────────────────────────────────────────────

// store_message's insert hit an existing row with the client's message id. It
// is a benign resend (re-ack it with the stored row) only when that row is THIS
// sender's message in THIS chat — an honest retry always is. Anything else is a
// foreign id: re-acking it would confirm the message exists and leak its
// sent_at / seq, and mark a message "sent" that was never stored. Same rule as
// the broadcast path's read_stored_broadcast and forward's forward_id_foreign.
const is_own_resend = (
  existing: { sender_id: string | null; chat_id: string | null },
  sender_id: string,
  conv_id: string,
): boolean =>
  same_user_id(existing.sender_id, sender_id) && same_user_id(existing.chat_id, conv_id);

export {
  same_user_id,
  is_own_resend,
  pin_identity,
  pin_refused,
  type PinResult,
  forward_target_allowed,
  forward_source_floor,
  readable_after_floor,
  type ForwarderMembershipRow,
};
