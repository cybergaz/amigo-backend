// =============================================================================
// FCM fallback for unacked foreground WS deliveries — I/O binding
// =============================================================================
// Rules and the why: fcm-ack-fallback-core.ts. Here: the flag, the timer,
// the router / pending-store hooks and the real lookups.
//
//   app_settings.sync_v2_ack_fallback (default off): nothing is armed and no
//     timer work happens while it is off — the hooks return at the flag check.
//   FCM_ACK_FALLBACK_MS (env, default 10000, clamped 3000..120000): deadline.
//
// Push: the same message:new frame the fan-out built, through the FCM batcher,
// with the fan-out's §14.13 priority rule: HIGH for a push that notifies,
// NORMAL only for the silent (muted) one. The target is a frozen / dozing
// phone, which Android delays normal-priority data until a maintenance
// window; the probe (server socket:ping, core header) is what keeps live
// foreground apps from receiving these high-priority pushes needlessly.
//
// Drain: the wheel keeps arming / firing while the sockets are handed over,
// then one final pass (fire_all) runs once they are closed, as tracked work.
//
// Counters ([FCM]): ack_fallback_armed / _acked / _sent / _skipped_alive /
// _probed / _skipped_acked (incl. _v2_acked) / _v2_unacked / _v2_lease_failed /
// _skipped_no_token / _skipped_deleted / _skipped_system / _skipped_off /
// _skipped_overflow / _check_failed / _live_check_failed / _token_check_failed /
// _failed / _final_pass / _dropped.
// =============================================================================
import { sync_v2_flags } from "@/services/app-settings.service";
import { socket_connections } from "@/sockets/connections";
import { deadline, rfast } from "@/cluster/redis-fast";
import { drain_sleep, is_draining, is_fast_drain, track } from "@/cluster/lifecycle";
import { set_delivery_observer } from "@/cluster/router";
import { on_pending_drain } from "@/cache-management/polling.cache";
import { fetch_fcm_tokens } from "@/cache-management/fcm-token.cache";
import { get_muted_user_ids } from "@/cache-management/chat-mute.cache";
import { pg_client } from "@/config/db";
import { count } from "@/utils/counters";
import { ws_send } from "@/sockets/ws-send";
import { proto_leases } from "@/services/sync/proto-lease";
import { queue_message_fcm } from "./fcm-batch.service";
import {
  ACK_FALLBACK_TICK_MS,
  clamp_delay_ms,
  create_ack_fallback,
  create_pending_checker,
  create_v2_aware_checker,
  delivered_upto_sql,
  live_message_ids_sql,
  type LocalConn,
} from "./fcm-ack-fallback-core";

const DELAY_MS = clamp_delay_ms(process.env.FCM_ACK_FALLBACK_MS);
const LOOKUP_DEADLINE_MS = 1_500;

const local_conn = (uid: string): LocalConn => {
  const c = socket_connections.get(uid);
  if (!c || c.ws.readyState !== 1) return null;
  return { background: c.is_background === true, last_inbound_at: c.last_inbound_at };
};

// The cluster-wide "not acked yet" check: the pending store, and for proto-2
// lease holders (whose entry §3.13 may never have stored) the delivered
// watermark (core: create_pending_checker / create_v2_aware_checker).
const still_pending = create_v2_aware_checker({
  pending: create_pending_checker(rfast, (p) => deadline(p, LOOKUP_DEADLINE_MS, "ack fallback pending check")),
  leases: proto_leases,
  delivered: (conv_id, seq, uids) =>
    deadline(delivered_upto_sql(pg_client, conv_id, seq, uids), LOOKUP_DEADLINE_MS, "ack fallback delivered check"),
  count: (name, n) => count("FCM", name, n),
});

// A server socket:ping on the suspect's open socket here (both app builds
// answer socket:pong; any inbound frame moves last_inbound_at). Not a
// keepalive ping: missed_pings / last_ping_at are left to the keepalive tick.
const probe = (uid: string): boolean => {
  const c = socket_connections.get(uid);
  if (!c || c.ws.readyState !== 1) return false;
  ws_send(c.ws, { type: "socket:ping", ws_timestamp: new Date().toISOString() }, c, uid);
  return true;
};

const with_token = async (uids: string[]): Promise<Set<string>> => {
  const map = await fetch_fcm_tokens(uids);
  const out = new Set<string>();
  for (const [uid, token] of map) if (token) out.add(uid);
  return out;
};

const fallback = create_ack_fallback({
  enabled: () => sync_v2_flags().ack_fallback,
  delay_ms: DELAY_MS,
  local_conn,
  still_pending,
  with_token,
  live_ids: (ids) => live_message_ids_sql(pg_client, ids),
  muted: get_muted_user_ids,
  probe,
  send: (uid, msg, { silent }) => {
    queue_message_fcm(uid, msg, { silent, normal_priority: silent }).catch((err) => {
      count("FCM", "ack_fallback_failed");
      console.error("[FCM] ack fallback queue failed:", err);
    });
  },
  count: (name, n) => count("FCM", name, n),
});

let timer: ReturnType<typeof setInterval> | null = null;

// Socket hand-over budget: the slow drain closes sockets over ≤ ~48 s.
const HANDOVER_MAX_MS = 50_000;
// After the last socket closed: time for healthy clients to reconnect to a
// sibling and ack there before the final pass (skipped in a fast drain).
const HANDOVER_GRACE_MS = 3_000;

// Drain (started by the stopper at t0, tracked so the drain's tracked-work
// phase waits for it before the FCM batches are flushed): keep firing due
// entries (arming continues through the router hook) while this worker still
// holds sockets, then one final pass over everything left.
const handover = async (off_drain: () => void): Promise<void> => {
  const until = Date.now() + HANDOVER_MAX_MS;
  try {
    while (socket_connections.size > 0 && Date.now() < until && !is_fast_drain()) {
      const p = fallback.tick();
      if (p) await p;
      await drain_sleep(ACK_FALLBACK_TICK_MS);
    }
    const st = fallback.stats();
    if (!is_fast_drain() && st.pending + st.probing > 0) await drain_sleep(HANDOVER_GRACE_MS);
  } finally {
    set_delivery_observer(null);
    await fallback.fire_all();
    off_drain();
  }
};

/**
 * Boot: hook the router (local + inbox deliveries) and the pending-store
 * drain (acks), start the 1 s tick. Returns the drain stopper, which hands
 * the wheel to `handover` (tracked) instead of dropping it — see the core's
 * header.
 */
const start_ack_fallback = (): (() => Promise<void>) => {
  if (timer) return async () => { };
  fallback.resume();
  set_delivery_observer({
    local: (uids, msg) => {
      fallback.arm(uids, msg);
    },
    remote: (uids, frame) => {
      fallback.arm_frame(uids, frame);
    },
  });
  const off_drain = on_pending_drain((uid, keys) => fallback.note_drained(uid, keys));
  timer = setInterval(() => {
    if (is_draining()) return;
    const p = fallback.tick();
    if (p) track(p);
  }, ACK_FALLBACK_TICK_MS);
  timer.unref?.();
  console.log(`[FCM] ack fallback ready (deadline ${DELAY_MS} ms; active while sync_v2_ack_fallback is on)`);
  return async () => {
    if (timer) clearInterval(timer);
    timer = null;
    const st = fallback.stats();
    if (!sync_v2_flags().ack_fallback && st.pending + st.probing === 0) {
      // Flag off (the default): nothing to hand over; the drain is unchanged.
      set_delivery_observer(null);
      off_drain();
      fallback.drop();
      return;
    }
    if (st.pending + st.probing > 0) console.log(`[FCM] ack fallback: ${st.pending + st.probing} pending at drain, handing over`);
    track(handover(off_drain)).catch((err: any) => console.error(`[FCM] ack fallback handover failed: ${err?.message ?? err}`));
  };
};

const ack_fallback_stats = () => ({ delay_ms: DELAY_MS, ...fallback.stats() });

export { start_ack_fallback, ack_fallback_stats };
