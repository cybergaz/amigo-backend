// =============================================================================
// Receipt effects plan (SYNC_V2_PROTOCOL.md §3.7 step 2) — PURE
// =============================================================================
// What to emit for one user's committed receipt windows: the frames
// (conversation:join, message:status:ack 'delivered'), the Redis
// reset_unread chats and the pending drains. No db / redis / socket imports,
// so the rules are unit-tested directly; receipt-effects.ts runs the plan.
// =============================================================================
import type { ConvJoinPayload, MessageStatusAckPayload, WSMessage } from "@/types/socket.types";
import Snowflake from "@/utils/snowflake.utils";
import {
  RECEIPT_READ_WINDOW_CAP,
  RECEIPT_WINDOW_CAP,
  type ReceiptOutcome,
  type ReceiptWindow,
  type ReceiptWindowResult,
} from "./write-queries";

const lc = (s: string) => s.toLowerCase();


/** The windows of the APPLIED outcomes (pure). */
export const windows_of = (outcomes: ReceiptOutcome[]): ReceiptWindow[] =>
  outcomes
    .filter((o) => o.status === "applied")
    .map((o) => ({
      chat_id: lc(o.chat_id),
      rp: o.prev_read ?? 0,
      rn: o.read_seq ?? o.prev_read ?? 0,
      dp: o.prev_deliv ?? 0,
      dn: o.delivered_seq ?? o.prev_deliv ?? 0,
    }))
    .filter((w) => w.rn > w.rp || w.dn > w.dp);

export type PlannedFrame = { to: string[]; message: WSMessage };
export type EffectsPlan = {
  frames: PlannedFrame[];
  reset_unread: string[];                 // chat ids
  drains: Map<string, string[]>;          // user → correlation keys
  capped: number;                         // windows wider than their cap (read / delivered)
};

/**
 * What to emit for one user's applied windows (pure, so the rules are unit
 * tested without a database). `res` is receipt_windows_sql's result.
 */
export const plan_receipt_effects = (
  user_id: string,
  wins: ReceiptWindow[],
  res: ReceiptWindowResult,
  at: Date,
  // reader_drain false: never drain the reader's message:new keys (legacy
  //   inputs: the device acked specific ids, or none at all for a join, so a
  //   window drain would remove copies of messages it never received).
  // delivered_relay false: no delivered frames / sender drains from the
  //   delivered window (legacy per-id delivered acks: the handler relays
  //   exactly the acked ids, as before sync v2; a window frame would claim
  //   every row up to the highest acked seq, received or not).
  opts: { reader_drain?: boolean; delivered_relay?: boolean } = {},
): EffectsPlan => {
  const reader_drain = opts.reader_drain !== false;
  const delivered_relay = opts.delivered_relay !== false;
  const me = lc(user_id);
  const plan: EffectsPlan = { frames: [], reset_unread: [], drains: new Map(), capped: 0 };
  const drain = (uid: string, key: string) => {
    const list = plan.drains.get(uid) ?? [];
    list.push(key);
    plan.drains.set(uid, list);
  };
  for (const w of wins) {
    if (w.rn > w.rp) {
      if (w.rn - w.rp > RECEIPT_READ_WINDOW_CAP) plan.capped++;
      plan.reset_unread.push(w.chat_id);
      const senders = (res.senders.get(w.chat_id) ?? []).filter((s) => lc(s) !== me);
      const last = res.last_read.get(w.chat_id);
      if (senders.length > 0 && last) {
        const payload: ConvJoinPayload = {
          user_id,
          conv_id: w.chat_id,
          last_read_msg_id: last,
          reader_id: user_id,
          read_seq: w.rn,
        };
        plan.frames.push({ to: senders, message: { type: "conversation:join", payload, ws_timestamp: at } });
      }
    }
    if (w.dn > w.dp && (delivered_relay || reader_drain)) {
      if (w.dn - w.dp > RECEIPT_WINDOW_CAP) plan.capped++;
      const rows = res.delivered.get(w.chat_id) ?? [];
      const per_sender = new Map<string, { ids: string[]; seqs: number[] }>();
      for (const r of rows) {
        if (reader_drain) drain(user_id, Snowflake.correlationId(user_id, "message:new", r.id));
        if (!delivered_relay || !r.sender_id || lc(r.sender_id) === me) continue;
        drain(r.sender_id, Snowflake.correlationId(r.sender_id, "message:sent:ack", r.id));
        if (r.broadcast_msg_id) {
          drain(r.sender_id, Snowflake.correlationId(r.sender_id, "message:sent:ack", r.broadcast_msg_id));
        }
        if (r.seq <= w.rn) continue; // just read: the conversation:join covers it
        const g = per_sender.get(r.sender_id) ?? { ids: [], seqs: [] };
        g.ids.push(r.id);
        g.seqs.push(r.seq);
        per_sender.set(r.sender_id, g);
      }
      for (const [sender, g] of per_sender) {
        const payload: MessageStatusAckPayload = {
          recipient_id: user_id,
          at,
          acks: [{ chat_id: w.chat_id, msg_ids: g.ids, status: ["delivered"], seqs: g.seqs }],
          reader_id: user_id,
          delivered_seq: w.dn,
          read_seq: w.rn,
        };
        plan.frames.push({ to: [sender], message: { type: "message:status:ack", payload, ws_timestamp: at } });
      }
    }
  }
  for (const [uid, keys] of plan.drains) plan.drains.set(uid, Array.from(new Set(keys)));
  return plan;
};
