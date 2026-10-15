// =============================================================================
// set_pin: the single pin writer (SYNC_V2_PROTOCOL.md §3.12)
// =============================================================================
// Replaces the bodies of pin_message / unpin_message (message.services.ts,
// which keep their exact legacy response shapes as thin wrappers) and serves
// the `pin` intent of POST /chat/sync/intents.
//
//   UPDATE chats SET pinned_msg_id = $msg
//    WHERE id = $chat AND pinned_msg_id IS DISTINCT FROM $msg
//      AND ($base IS NULL OR pin_seq = $base)               -- seq-CAS (v2 intents)
//      AND ($unpin_target IS NULL OR pinned_msg_id = $unpin_target)   -- atomic legacy unpin
//      AND ($msg IS NULL OR <msg is a live row of this chat>)
//
// The chats_bu_pin trigger allocates pin_seq from the chat clock when the
// value changes. Nothing changed → classified from a fresh read (noop / 409
// stale base or wrong unpin target / 425 target not stored yet / 404 / 403)
// and NOTHING is broadcast. Changed → `message:pin` broadcast once, after the
// commit, with the authenticated actor.
//
// Round trips: applied = 1 statement (membership + CAS + the pinned body);
// not applied = 2 (+ the classifying read).
// =============================================================================
import { pg_client } from "@/config/db";
import { broadcast_message } from "@/sockets/socket.handlers";
import { sync_v2_flags } from "@/services/app-settings.service";
import type { MessagePinPayload } from "@/types/socket.types";
import type { MessageType } from "@/types/chat.types";
import { count } from "@/utils/counters";
import { classify_pin_miss, type PinOutcome } from "./read-core";
import { pin_state_sql, set_pin_sql, type Row } from "./read-queries";
import { run_fanout } from "@/sockets/vital-chain";

export type PinState = { pinned_msg_id: string | null; pin_seq: number; pinned_message: Row | null };

export type SetPinRequest = {
  chat_id: string;
  actor_id: string;              // the AUTHENTICATED id, never a payload field
  message_id: string | null;     // null = unpin
  base_pin_seq?: number | null;  // v2 intents: the pin_seq the client last saw
  unpin_target?: string | null;  // legacy unpin: only if this is still the pin
};

export type SetPinResult = {
  outcome: PinOutcome;
  state: PinState | null;
  // The message the legacy frame names (the pinned one, or the one unpinned)
  // and its type; set only when applied.
  frame_message_id?: string;
  message_type?: string | null;
};

const PIN_COUNTER: Record<PinOutcome, string> = {
  applied: "applied",
  noop: "noop",
  conflict: "409",
  not_stored: "425",
  not_found: "404",
  forbidden: "403",
  unsupported: "400",
  no_chat: "404",
};

export const set_pin = async (req: SetPinRequest): Promise<SetPinResult> => {
  const base_pin_seq = req.base_pin_seq ?? null;
  const unpin_target = req.unpin_target ?? null;
  const applied = await set_pin_sql(pg_client, {
    chat_id: req.chat_id,
    actor_id: req.actor_id,
    message_id: req.message_id,
    base_pin_seq,
    unpin_target,
  });

  if (!applied) {
    const s = await pin_state_sql(pg_client, req.actor_id, req.chat_id, req.message_id);
    const outcome = classify_pin_miss(s, { message_id: req.message_id, base_pin_seq, unpin_target });
    count("PIN", PIN_COUNTER[outcome]);
    // State only for callers allowed to read the chat.
    const state = s.chat_exists && s.member
      ? { pinned_msg_id: s.pinned_msg_id, pin_seq: s.pin_seq, pinned_message: s.pinned_message }
      : null;
    return { outcome, state };
  }

  count("PIN", "applied");
  const frame_message_id = applied.pinned_msg_id ?? applied.prev_pinned_msg_id ?? unpin_target ?? "";
  const payload: MessagePinPayload & { pin_seq?: number } = {
    conv_id: req.chat_id,
    message_id: frame_message_id,
    message_type: (applied.message_type ?? "text") as MessageType,
    sender_id: req.actor_id,
    pin: applied.pinned_msg_id !== null,
  };
  // Additive field (§4.1), only once Sync v2 is on: old apps ignore it, but
  // with every flag at its default the frame stays byte-identical.
  // pinned_message is NOT on the stored frame: broadcast_message stores vital
  // frames for offline recipients and the spec keeps bodies out of pending /
  // FCM entries (live_message below carries it to open sockets only); v2
  // clients also get it from the intent result, the delta `pin` block or
  // GET /message/pinned.
  const v2 = sync_v2_flags().mode === "on";
  if (v2) payload.pin_seq = applied.pin_seq;
  // The fan-out, detached behind the actor's earlier fan-outs into this chat
  // when this runs as a serial vital frame (a "send then pin" reaches every
  // member in that order), awaited inline otherwise.
  await run_fanout(req.actor_id, req.chat_id, async () => {
    try {
      const ws_timestamp = new Date();
      await broadcast_message({
        to: "conversation",
        conv_id: req.chat_id,
        message: { type: "message:pin", payload, ws_timestamp },
        // §3.12 ('on'): the pinned body on the LIVE frame only; the stored
        // copy (pending store / poll) stays without it.
        ...(v2 && applied.pinned_message
          ? { live_message: { type: "message:pin" as const, payload: { ...payload, pinned_message: applied.pinned_message }, ws_timestamp } }
          : {}),
      });
    } catch (err: any) {
      // Committed already; heads / delta repair any member who missed the frame.
      console.error(`[PIN] broadcast failed conv=${req.chat_id}: ${err?.message ?? err}`);
    }
  });
  return {
    outcome: "applied",
    state: { pinned_msg_id: applied.pinned_msg_id, pin_seq: applied.pin_seq, pinned_message: applied.pinned_message },
    frame_message_id,
    message_type: applied.message_type,
  };
};

/** GET /message/pinned/:conversation_id body (PD-3: regardless of clear / join floors). */
export const get_pin_state = async (
  user_id: string,
  chat_id: string,
): Promise<{ code: 200 | 403 | 404; state: PinState | null }> => {
  const s = await pin_state_sql(pg_client, user_id, chat_id, null);
  if (!s.chat_exists) return { code: 404, state: null };
  if (!s.member) return { code: 403, state: null };
  return { code: 200, state: { pinned_msg_id: s.pinned_msg_id, pin_seq: s.pin_seq, pinned_message: s.pinned_message } };
};
