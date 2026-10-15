// =============================================================================
// Receipt effects in sync_v2 'on' (SYNC_V2_PROTOCOL.md §3.7 step 1–2, §4.1)
// =============================================================================
// Once the PG watermarks are the truth (mode 'on' + the backfill / index
// markers: flags-core derived_ready), every legacy receipt effect is derived
// from what apply_receipts COMMITTED — its prev/new windows — instead of from
// the frame's ids and the Redis LWW cursor:
//
//   read window (prev_read, read_seq]
//     - message_info read rows (mark_read_upto by seq)
//     - conversation:join to the distinct other senders in the window, with
//       additive reader_id / read_seq; last_read_msg_id = the visible row
//       with the max seq <= read_seq
//     - Redis reset_unread (until R4; the chat list serves derived unread)
//   delivered window (prev_deliv, delivered_seq], newest 200 rows
//     - message:status:ack 'delivered' to each other sender, for its rows
//       ABOVE the new read_seq (rows at or below it just got the join), with
//       additive reader_id / delivered_seq / read_seq / seqs
//     - pending drain: the reader's message:new keys (v2 intents only: a
//       legacy input either drained exactly its acked ids on arrival
//       (status:ack, FCM delivered) or acked no id at all (join / mark_read)
//       and must not drop copies of messages the device never received),
//       the senders' sent:ack keys (and a broadcast copy's parent) —
//       exactly the deterministic keys the legacy ack path drains
//     - legacy per-id DELIVERED acks (status:ack, POST /message/delivered)
//       get none of the delivered-window frames / sender drains: their
//       handlers keep the per-id relay, so a 4.2.2 sender is never told
//       "delivered" for rows below the acked one that the device missed
//
// A non-advancing receipt (a replayed outbox frame, a stale ack) has empty
// windows: nothing is re-read, re-acked or re-broadcast — the S1/S2 fix for
// old clients. Everything runs after the commit, fire-and-forget and tracked
// (the state is already durable; a lost effect is repaired by heads / delta
// for v2 clients and by the next receipt for old ones).
//
// chat:wm: when the receipt mins rise, each counted member with a proto-2
// lease gets {conv_id, others_read_seq, others_delivered_seq} on its live
// WS — never stored, never pushed. With sync_v2_proto_lease off (default)
// nobody holds a lease and nothing is sent or even looked up.
// =============================================================================
import { pg_client } from "@/config/db";
import { sync_v2_flags } from "@/services/app-settings.service";
import { broadcast_message } from "@/sockets/socket.handlers";
import { deliver } from "@/cluster/router";
import { remove_pending_messages_batch } from "@/cache-management/polling.cache";
import { reset_unread } from "@/cache-management/chat-meta.cache";
import { get_conversation_members } from "@/cache-management/conv.cache";
import { count } from "@/utils/counters";
import { track } from "@/cluster/lifecycle";
import { derived_ready } from "./flags-core";
import { proto_leases } from "./proto-lease";
import { nudge_users, poll_waiters_possible } from "@/cache-management/sync-nudge";
import {
  others_from_mins,
  mins_rise,
  receipt_windows_sql,
  type MinsRow,
  type ReceiptOutcome,
} from "./write-queries";
import { plan_receipt_effects, windows_of } from "./receipt-plan";

export { plan_receipt_effects, windows_of };

/** Are receipt effects derived from the windows (and the legacy relays off)? */
export const window_effects_active = (): boolean => derived_ready(sync_v2_flags());

const lc = (s: string) => s.toLowerCase();

/**
 * The legacy effects of committed receipts (window_effects_active only).
 * Fire-and-forget: one statement for every advanced chat of the call, then
 * the frames / drains. Never throws.
 */
export const run_receipt_effects = (
  user_id: string,
  outcomes: ReceiptOutcome[],
  at: Date,
  opts: { reader_drain?: boolean; delivered_relay?: boolean } = {},
): void => {
  const wins = windows_of(outcomes);
  if (wins.length === 0) return;
  track(
    (async () => {
      const res = await receipt_windows_sql(pg_client, user_id, wins, at);
      const plan = plan_receipt_effects(user_id, wins, res, at, opts);
      count("RCPT", "effects_windows", wins.length);
      if (res.marked) count("RCPT", "effects_marked", res.marked);
      if (plan.capped) count("RCPT", "effects_window_capped", plan.capped);
      for (const chat of plan.reset_unread) void reset_unread(user_id, chat); // never rejects
      const work: Promise<unknown>[] = [];
      for (const [uid, keys] of plan.drains) {
        work.push(remove_pending_messages_batch(uid, keys));
      }
      for (const f of plan.frames) {
        count("RCPT", f.message.type === "conversation:join" ? "effects_join" : "effects_status_ack");
        work.push(broadcast_message({ to: "users", user_ids: f.to, message: f.message }));
      }
      const settled = await Promise.allSettled(work);
      for (const s of settled) {
        if (s.status === "rejected") console.error(`[RCPT] effect failed: ${(s.reason as Error)?.message ?? s.reason}`);
      }
    })().catch((err: any) => {
      count("RCPT", "effects_failed");
      console.error(`[RCPT] receipt effects failed user=${user_id}: ${err?.code ?? ""} ${err?.message ?? err}`);
    }),
  );
};

// ── chat:wm ─────────────────────────────────────────────────────────────────

const wm_frame = (conv_id: string, r: number, d: number): string =>
  JSON.stringify({
    type: "chat:wm",
    payload: { conv_id, others_read_seq: r, others_delivered_seq: d },
    ws_timestamp: new Date(),
  });

/**
 * chat:wm for chats whose mins rose (the mins runner, groups). Recipients:
 * the chat's members with a proto-2 lease; values per viewer from the mins
 * row (others_from_mins). Not stored: deliver() without a store message.
 */
export const emit_chat_wm = async (
  before: Map<string, MinsRow>,
  after: Map<string, MinsRow>,
): Promise<number> => {
  if (sync_v2_flags().mode !== "on") return 0;
  // Without the lease flag no chat:wm frame goes out, but a parked poll v2
  // request (R3) must still learn that its others_* moved (§3.11 "also
  // published on mins changes"): nudge only. Skipped entirely when no
  // waiter can exist (no member lookups at N=1 without pollers).
  const frames = sync_v2_flags().proto_lease;
  if (!frames && !poll_waiters_possible()) return 0;
  let sent = 0;
  for (const a of after.values()) {
    const rise = mins_rise(before.get(a.chat_id), a);
    if (!rise.all && rise.users.length === 0) continue;
    const members = rise.all ? Array.from(await get_conversation_members(a.chat_id)) : rise.users;
    if (members.length === 0) continue;
    if (!frames) {
      nudge_users(members, a.chat_id);
      continue;
    }
    let holders: Set<string>;
    try {
      holders = await proto_leases(members);
    } catch {
      count("RCPT", "wm_lease_lookup_failed");
      continue;
    }
    if (holders.size === 0) continue;
    // Members see one of two values: min1's (everybody else) or min2's (the
    // min1 users) — group them so a big group costs at most a few delivers.
    const by_value = new Map<string, string[]>();
    for (const uid of holders) {
      const o = others_from_mins(a, uid);
      const key = `${o.r}|${o.d}`;
      const list = by_value.get(key) ?? [];
      list.push(uid);
      by_value.set(key, list);
    }
    for (const [key, uids] of by_value) {
      const [r, d] = key.split("|").map(Number) as [number, number];
      // nudge_chat: a v2 long-poller (lease holder, no socket) is woken too.
      await deliver(uids, wm_frame(a.chat_id, r, d), undefined, { nudge_chat: a.chat_id });
      sent += uids.length;
    }
  }
  if (sent) count("RCPT", "wm_sent", sent);
  return sent;
};

/**
 * chat:wm for a DM after the reader's inline mins refresh: the peer's
 * "others" IS the reader, so the values come straight from the outcome — no
 * extra read. (They can be at most joined_seq below the mins row, never
 * above the truth, and clients max-merge.)
 */
export const emit_dm_wm = (user_id: string, outcomes: ReceiptOutcome[]): void => {
  if (sync_v2_flags().mode !== "on") return;
  // Lease flag off: no frame, but nudge the peer's parked poll v2 (as emit_chat_wm).
  const frames = sync_v2_flags().proto_lease;
  if (!frames && !poll_waiters_possible()) return;
  const dms = outcomes.filter((o) => o.status === "applied" && o.chat_type === "dm");
  if (dms.length === 0) return;
  track(
    (async () => {
      for (const o of dms) {
        const peers = Array.from(await get_conversation_members(o.chat_id)).filter((u) => lc(u) !== lc(user_id));
        if (peers.length === 0) continue;
        if (!frames) {
          nudge_users(peers, o.chat_id);
          continue;
        }
        const holders = await proto_leases(peers);
        if (holders.size === 0) continue;
        await deliver(Array.from(holders), wm_frame(o.chat_id, o.read_seq ?? 0, o.delivered_seq ?? 0), undefined, { nudge_chat: o.chat_id });
        count("RCPT", "wm_sent", holders.size);
      }
    })().catch((err: any) => console.error(`[RCPT] dm chat:wm failed: ${err?.message ?? err}`)),
  );
};
