// =============================================================================
// POST /chat/sync/intents: the server half of the v2 outbox
// (SYNC_V2_PROTOCOL.md §4.2 "Intent kinds", §5.12)
// =============================================================================
// Every intent is idempotent BY SEMANTICS, so the server stores nothing per
// request_id: receipts are max-merges, clear is GREATEST, pin is a seq-CAS
// (a replay of an applied pin is a noop), react sets an absolute value,
// deletes are "make it deleted". A replayed batch therefore converges on the
// same state and never double-applies.
//
// Intents run in the order given. A run of consecutive receipt intents is one
// apply_receipts statement (receipts commute). Each result carries the
// authoritative state, even on `rejected`, so the client can restore:
//   applied | noop  → final (200)
//   rejected        → final (400 malformed, 403, 404, 409)
//   retry           → 425 (not numbered / pin target not stored) or 5xx
// The state for receipt and clear results is read once, after the batch, in
// one statement (watermarks only rise, so the later read is still the truth).
// =============================================================================
import { pg_client } from "@/config/db";
import { track } from "@/cluster/lifecycle";
import { count } from "@/utils/counters";
import { reset_unread } from "@/cache-management/chat-meta.cache";
import { delete_message_for_me, soft_delete_message } from "@/services/chat.services";
import { react_to_message } from "@/services/message.services";
import { apply_receipts } from "./watermark.service";
import { refresh_mins_sql } from "./write-queries";
import {
  INTENT_KINDS,
  PIN_OUTCOME_HTTP,
  parse_intent,
  type IntentKind,
  type Intent,
  type IntentResult,
  type ParsedIntent,
} from "./read-core";
import {
  chat_state_sql,
  clear_upto_sql,
  messages_state_sql,
  react_state_sql,
  type ChatState,
} from "./read-queries";
import { set_pin } from "./set-pin";

type R = IntentResult;

const result = (i: Intent, status: R["status"], code: number, state: unknown, reason?: string): R => ({
  request_id: i.request_id,
  kind: i.kind,
  chat_id: i.chat_id,
  status,
  code,
  ...(reason ? { reason } : {}),
  state,
});

// A thrown DB error (lock timeout, deadlock twice, connection) is transient.
const transient = (i: Intent, err: any): R => {
  console.error(`[INTENT] ${i.kind} chat=${i.chat_id} failed: ${err?.code ?? ""} ${err?.message ?? err}`);
  return result(i, "retry", 503, null, "server_error");
};

// ── receipt ──────────────────────────────────────────────────────────────────

const RECEIPT_HTTP = {
  applied: { status: "applied", code: 200 },
  noop: { status: "noop", code: 200 },
  rejected: { status: "rejected", code: 403 },
  retry: { status: "retry", code: 425 },
} as const;

/** One apply_receipts statement for a run of receipt intents (merged per chat by max). */
const run_receipts = async (uid: string, run: Extract<Intent, { kind: "receipt" }>[]): Promise<R[]> => {
  const merged = new Map<string, { chat_id: string; read_seq: number | null; delivered_seq: number | null }>();
  const max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
  for (const i of run) {
    const m = merged.get(i.chat_id) ?? { chat_id: i.chat_id, read_seq: null, delivered_seq: null };
    m.read_seq = max(m.read_seq, i.read_seq);
    m.delivered_seq = max(m.delivered_seq, i.delivered_seq);
    merged.set(i.chat_id, m);
  }
  try {
    const outcomes = await apply_receipts(uid, Array.from(merged.values()));
    const by_chat = new Map(outcomes.map((o) => [o.chat_id.toLowerCase(), o]));
    return run.map((i) => {
      const o = by_chat.get(i.chat_id);
      // No outcome = the chat does not exist (apply_receipts drops nothing else).
      if (!o) return result(i, "rejected", 404, null, "chat_not_found");
      const h = RECEIPT_HTTP[o.status];
      const reason = o.status === "rejected" ? "not_a_member" : o.status === "retry" ? "chat_not_numbered" : undefined;
      return result(i, h.status, h.code, null, reason);
    });
  } catch (err) {
    return run.map((i) => transient(i, err));
  }
};

// ── clear ────────────────────────────────────────────────────────────────────

const run_clear = async (uid: string, i: Extract<Intent, { kind: "clear" }>): Promise<R> => {
  const c = await clear_upto_sql(pg_client, uid, i.chat_id, i.upto_seq);
  if (!c.chat_exists) return result(i, "rejected", 404, null, "chat_not_found");
  if (!c.member) return result(i, "rejected", 403, null, "not_a_member");
  if (!c.numbered) return result(i, "retry", 425, null, "chat_not_numbered");
  count("INTENT", c.applied ? "clear_applied" : "clear_noop");
  if (c.applied) {
    // Legacy side effects, fire-and-forget (the state is already durable):
    // the Redis unread counter old builds read (until R4) when the clear
    // reached the last message, and the receipt mins (the clear raised this
    // member's read/delivered; clears are rare, so recompute directly).
    if (c.cleared_seq !== null && c.last_seq !== null && c.cleared_seq >= c.last_seq) {
      track(reset_unread(uid, i.chat_id).catch(() => undefined));
    }
    if (c.chat_type !== "broadcast") {
      track(refresh_mins_sql(pg_client, [i.chat_id]).catch((err: any) =>
        console.error(`[INTENT] clear mins refresh failed: ${err?.message ?? err}`)));
    }
  }
  return result(i, c.applied ? "applied" : "noop", 200, null);
};

// ── pin ──────────────────────────────────────────────────────────────────────

const run_pin = async (uid: string, i: Extract<Intent, { kind: "pin" }>): Promise<R> => {
  const r = await set_pin({
    chat_id: i.chat_id,
    actor_id: uid,
    message_id: i.message_id,
    base_pin_seq: i.base_pin_seq,
    unpin_target: i.unpin_target,
  });
  const h = PIN_OUTCOME_HTTP[r.outcome];
  const reason = r.outcome === "applied" || r.outcome === "noop" ? undefined : r.outcome;
  return result(i, h.status, h.code, r.state, reason);
};

// ── react ────────────────────────────────────────────────────────────────────

const run_react = async (uid: string, i: Extract<Intent, { kind: "react" }>): Promise<R> => {
  const s = await react_state_sql(pg_client, uid, i.chat_id, i.message_id);
  // Reactions are only echoed to active members (the same rule as reacting).
  if (!s.member) return result(i, "rejected", 403, null, "not_a_member");
  const state = (reactions: typeof s.reactions) => ({ message_id: i.message_id, reactions });
  if (!s.exists) return result(i, "rejected", 404, null, "message_not_found");
  if (s.mine === i.reaction) return result(i, "noop", 200, state(s.reactions));
  // An absolute value: react_to_message upserts it (membership re-checked
  // there) and broadcasts the legacy delta frame.
  const res = await react_to_message(
    {
      message_id: i.message_id,
      conversation_id: i.chat_id,
      emoji: i.reaction ?? s.mine ?? "",
      action: i.reaction === null ? "remove" : "add",
    },
    uid,
  );
  if (res.code === 200) {
    const others = s.reactions.filter((r) => r.user_id.toLowerCase() !== uid.toLowerCase());
    const next = i.reaction === null ? others : [...others, { user_id: uid, reaction: i.reaction }];
    return result(i, "applied", 200, state(next));
  }
  if (res.code >= 500) return result(i, "retry", res.code, state(s.reactions), "server_error");
  const reason = res.code === 403 ? "not_a_member" : res.code === 404 ? "message_not_found" : "unsupported";
  return result(i, "rejected", res.code, state(s.reactions), reason);
};

// ── delete_everyone / delete_me ──────────────────────────────────────────────

type MsgSnap = Awaited<ReturnType<typeof messages_state_sql>>;

// State is echoed only to callers with a membership row in the chat (a
// global admin deleting in a chat they are not in gets the status, no state).
const delete_state = (snap: MsgSnap, requested: string[]) => {
  if (!snap.member) return null;
  const have = new Set(snap.rows.map((r) => r.id));
  return {
    mods: snap.rows.filter((r) => r.deleted_at !== null).map((r) => ({ id: r.id, mod_seq: r.mod_seq })),
    current: snap.rows.map((r) => ({ id: r.id, seq: r.seq, mod_seq: r.mod_seq, deleted_at: r.deleted_at, hidden: r.hidden })),
    missing: requested.filter((id) => !have.has(id)),
  };
};

const run_delete_everyone = async (uid: string, i: Extract<Intent, { kind: "delete_everyone" }>): Promise<R> => {
  // Only ids of THIS chat go to the delete (it authorises per message's chat).
  const before = await messages_state_sql(pg_client, uid, i.chat_id, i.message_ids);
  if (before.rows.length === 0) return result(i, "rejected", 404, delete_state(before, i.message_ids), "message_not_found");
  const was_deleted = new Set(before.rows.filter((r) => r.deleted_at !== null).map((r) => r.id));
  const res = await soft_delete_message(before.rows.map((r) => r.id), uid);
  const after = await messages_state_sql(pg_client, uid, i.chat_id, i.message_ids);
  const state = delete_state(after, i.message_ids);
  if (res.code >= 500) return result(i, "retry", res.code, state, "server_error");
  // A row still live after the delete was refused (not the sender, not an
  // admin / owner / staff, not a member): terminal; the client undeletes it.
  if (after.rows.some((r) => r.deleted_at === null)) return result(i, "rejected", 403, state, "not_allowed");
  const changed = after.rows.some((r) => !was_deleted.has(r.id));
  return result(i, changed ? "applied" : "noop", 200, state);
};

const run_delete_me = async (uid: string, i: Extract<Intent, { kind: "delete_me" }>): Promise<R> => {
  const before = await messages_state_sql(pg_client, uid, i.chat_id, i.message_ids);
  if (!before.member) return result(i, "rejected", 403, null, "not_a_member");
  if (before.rows.length === 0) return result(i, "rejected", 404, delete_state(before, i.message_ids), "message_not_found");
  const res = await delete_message_for_me(before.rows.map((r) => r.id), uid, i.chat_id);
  if (res.code >= 500) return result(i, "retry", res.code, delete_state(before, i.message_ids), "server_error");
  if (res.code === 403) return result(i, "rejected", 403, null, "not_a_member");
  if (res.code !== 200) return result(i, "rejected", res.code, delete_state(before, i.message_ids), "message_not_found");
  const after = { member: true, rows: before.rows.map((r) => ({ ...r, hidden: true })) };
  return result(i, before.rows.every((r) => r.hidden) ? "noop" : "applied", 200, delete_state(after, i.message_ids));
};

// ── dispatcher ───────────────────────────────────────────────────────────────

const run_one = async (uid: string, i: Intent): Promise<R> => {
  try {
    switch (i.kind) {
      case "clear": return await run_clear(uid, i);
      case "pin": return await run_pin(uid, i);
      case "react": return await run_react(uid, i);
      case "delete_everyone": return await run_delete_everyone(uid, i);
      case "delete_me": return await run_delete_me(uid, i);
      case "receipt": return (await run_receipts(uid, [i]))[0]!;
    }
  } catch (err) {
    return transient(i, err);
  }
};

const receipt_state = (s: ChatState | undefined) => s && s.member
  ? { read_seq: s.read_seq, delivered_seq: s.delivered_seq, unread: s.unread, seq_head: s.seq_head, last_seq: s.last_seq }
  : null;

const clear_state = (s: ChatState | undefined) => s && s.member
  ? { cleared_seq: s.cleared_seq, read_seq: s.read_seq, delivered_seq: s.delivered_seq, unread: s.unread }
  : null;

/**
 * Process up to INTENTS_MAX raw intents for the AUTHENTICATED user, in order.
 * Never throws: every intent gets a result.
 */
export const process_intents = async (uid: string, raw: unknown[]): Promise<R[]> => {
  const parsed: ParsedIntent[] = raw.map(parse_intent);
  const out: R[] = new Array(parsed.length);
  let k = 0;
  while (k < parsed.length) {
    const p = parsed[k]!;
    if (!p.ok) {
      out[k] = p.result;
      k++;
      continue;
    }
    if (p.intent.kind === "receipt") {
      const idx: number[] = [];
      while (k < parsed.length) {
        const q = parsed[k]!;
        if (!q.ok || q.intent.kind !== "receipt") break;
        idx.push(k++);
      }
      const run = idx.map((j) => (parsed[j] as { ok: true; intent: Extract<Intent, { kind: "receipt" }> }).intent);
      const res = await run_receipts(uid, run);
      idx.forEach((j, n) => (out[j] = res[n]!));
      continue;
    }
    out[k] = await run_one(uid, p.intent);
    k++;
  }

  // Authoritative watermark state for receipt / clear results, one statement.
  const need = Array.from(new Set(
    out.filter((r) => (r.kind === "receipt" || r.kind === "clear") && r.code !== 400 && r.chat_id)
      .map((r) => r.chat_id as string),
  ));
  if (need.length > 0) {
    try {
      const states = await chat_state_sql(pg_client, uid, need);
      for (const r of out) {
        if (r.kind === "receipt" && r.chat_id) r.state = receipt_state(states.get(r.chat_id));
        else if (r.kind === "clear" && r.chat_id) r.state = clear_state(states.get(r.chat_id));
      }
    } catch (err: any) {
      // The intents are applied; only the echo is missing. Without state the
      // client cannot retire them, so mark applied/noop receipts retryable:
      // a replay is a cheap noop that returns the state.
      console.error(`[INTENT] state read failed: ${err?.message ?? err}`);
      for (const r of out) {
        if ((r.kind === "receipt" || r.kind === "clear") && (r.status === "applied" || r.status === "noop")) {
          r.status = "retry";
          r.code = 503;
          r.reason = "state_unavailable";
        }
      }
    }
  }
  // Bounded counter names: a malformed intent's kind is client text.
  for (const r of out) {
    count("INTENT", `${INTENT_KINDS.includes(r.kind as IntentKind) ? r.kind : "invalid"}_${r.status}`);
  }
  return out;
};
