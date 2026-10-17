import type { VitalWSMessage } from "@/types/socket.types";
import { store_pending_message_for_users } from "@/cache-management/polling.cache";
import { pending_store_recipients } from "@/services/sync/pending-suppress";
import { drop_test_users } from "@/services/load-test-registry";
import {
  close_replaced,
  is_local_online,
  opening,
  polling_connections,
  socket_connections,
} from "@/sockets/connections";
import { ws_send } from "@/sockets/ws-send";
import { handle_poll_inbox, nudge_after_fanout, poll_v2_possible } from "@/cache-management/sync-nudge";
import { chat_of_frame } from "@/services/sync/poll-core";
import { count } from "@/utils/counters";
import { is_sole_worker, worker_known_alive } from "./beat";
import { bus } from "./bus";
import { WORKER_ID } from "./identity";
import { k } from "./keys";
import { track } from "./lifecycle";
import { ROUTING_MODE, presence_authoritative } from "./mode";
import * as presence from "./presence";
import { PRESENCE_DEADLINE_MS, type Presence, type WsPresence } from "./presence-core";
import { deadline, rfast } from "./redis-fast";
import { create_inbox_publisher } from "./presence-store";
import { remote_waiters_by_wid } from "@/cache-management/sync-nudge-core";
import {
  ReplaceDamper,
  apply_liveness,
  bucket_arrays,
  classify_presence,
  decode_inbox,
  new_buckets,
  poll_lease_verdict,
  lease_seen_ms,
  type BucketArrays,
  type Buckets,
  type Liveness,
} from "./router-core";

// =============================================================================
// Cross-worker delivery (SYNC_V2 §13.6)
// =============================================================================
// broadcast_message (sockets/socket.handlers.ts) resolves the recipient list
// and hands the serialised frame here. Order of work:
//   1. local fast path — every recipient with an open socket on THIS worker
//      gets the frame synchronously, before any await (no Redis round trip,
//      exactly as before RC-2);
//   2. the pending-queue store for every recipient starts (store-for-
//      everyone is unchanged: a send into a ghost socket "succeeds");
//   3. the rest is classified:
//        local mode, or `on` with no live sibling → this worker's poll leases
//          (today's rule, no Redis);
//        `on` with siblings → presence lookup under a hard deadline, one
//          PUBLISH per remote worker inbox + a liveness check, all in one
//          pipeline (§13.6.3);
//        shadow → as local, plus a sampled comparison against the registry;
//   4. the buckets (online / offline / polling / background) go back to the
//      caller, which decides FCM from them (P-4).
// WS stays at-most-once (P-2): a frame to a socket that moved is dropped and
// repaired by the pending store / FCM / Sync v2 pull.

const STORE_DEADLINE_MS = 1_000;
const SHADOW_SAMPLE = (() => {
  const v = parseFloat(process.env.CLUSTER_SHADOW_SAMPLE ?? "0.1");
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.1;
})();

// §13.6.5 steps 4–5: per-user damper on closing replaced sockets.
const replace_damper = new ReplaceDamper();

// Who was just handed a vital frame over an open socket of THIS worker
// (services/fcm-ack-fallback.ts arms its ack deadline from it; the deadline
// lives where the socket lives). `local`: the fan-out's own sockets, with the
// frame object; `remote`: sockets reached through this worker's inbox, with
// the serialised frame. Registered at boot; null = nobody listens (tests,
// scripts) and deliver() does no extra work.
type DeliveryObserver = {
  local: (uids: string[], msg: VitalWSMessage) => void;
  remote: (uids: string[], frame: string) => void;
};
let delivery_observer: DeliveryObserver | null = null;
const set_delivery_observer = (o: DeliveryObserver | null): void => {
  delivery_observer = o;
};

// ---------------------------------------------------------------------------
// classification helpers
// ---------------------------------------------------------------------------

// Today's single-process rule for recipients without a local socket: a v1
// poll lease fresher than 10 s → polling (+ background if announced), a
// stale lease → evicted, offline; no lease → offline.
const classify_local = (rest: string[], b: Buckets, now = Date.now()) => {
  for (const uid of rest) {
    const lease = polling_connections.get(uid);
    if (!lease) {
      b.offline.add(uid);
      continue;
    }
    if (poll_lease_verdict(lease_seen_ms(lease), now) === "polling") {
      b.polling.add(uid);
      // A backgrounded app keeps polling until the OS freezes it, but
      // notifications are painted only from FCM — push it too.
      if (lease.connection_status === "background") b.background.add(uid);
    } else {
      polling_connections.delete(uid);
      b.offline.add(uid);
    }
  }
};

// After a registry classification: a user the registry calls offline but
// who polled THIS worker within 10 s is a poller (the fire-and-forget
// set_poll may have failed or not landed yet). Never the other way round.
const merge_local_leases = (rest: string[], b: Buckets, now = Date.now()) => {
  for (const uid of rest) {
    if (!b.offline.has(uid)) continue;
    const lease = polling_connections.get(uid);
    if (!lease || poll_lease_verdict(lease_seen_ms(lease), now) !== "polling") continue;
    b.offline.delete(uid);
    b.polling.add(uid);
    if (lease.connection_status === "background") b.background.add(uid);
  }
};

// PUBLISH + liveness in one pipeline on rfast (presence-store.ts).
const inbox = create_inbox_publisher(rfast);

// Returns the recipients' parked poll v2 requests held by OTHER workers
// (R3, §13.17.3) when `waiters` is asked for — read in the same pipeline as
// the presence keys, so a nudge costs no extra round trip.
const route_via_presence = async (
  rest: string[],
  frame: string,
  b: Buckets,
  waiters: boolean,
): Promise<Map<string, string[]> | null> => {
  let pres: Presence[];
  try {
    pres = await presence.lookup(rest, { waiters });
  } catch {
    // P-7: Redis slow or down → local-only delivery + FCM for the rest.
    count("CLUSTER", "router_deadline_hit");
    classify_local(rest, b);
    return null;
  }
  const plan = classify_presence(b, rest, pres, WORKER_ID, (cid) => opening.has(cid));
  merge_local_leases(rest, b);
  for (const s of plan.stale_self) presence.release_stale_soon(s.uid, s.ws.cid);
  const remote_waiters = waiters ? remote_waiters_by_wid(rest, pres.map((p) => p?.waiter), WORKER_ID) : null;
  if (plan.remote.size === 0) return remote_waiters;

  let res: Map<string, Liveness> | null = null;
  try {
    res = await deadline(inbox.publish_and_check(plan.remote, frame), PRESENCE_DEADLINE_MS, "router publish");
  } catch {
    count("CLUSTER", "router_deadline_hit");
  }
  const { dead, stats } = apply_liveness(b, plan.remote, res);
  for (const [name, n] of Object.entries(stats)) if (n) count("CLUSTER", name, n);
  for (const d of dead) presence.release_owned_by_soon(d.wid, d.uids);
  // users just reclassified offline may still be polling this worker
  if (dead.length || stats.wedged_reclass || stats.liveness_unknown) merge_local_leases(rest, b);
  return remote_waiters;
};

// Shadow mode (gate item 5): classify a sample of fan-outs against the
// registry too and count disagreements with the local decision. Never awaited,
// never changes a bucket.
const shadow_compare = (rest: string[], b: Buckets) => {
  const local_verdict = rest.map((uid) => (b.polling.has(uid) ? "polling" : "offline"));
  presence
    .lookup(rest)
    .then((pres) => {
      count("CLUSTER", "shadow_samples");
      rest.forEach((uid, i) => {
        const ws = pres[i]?.ws;
        const poll = pres[i]?.poll;
        const remote = !!ws && ws.wid !== WORKER_ID;
        const verdict = remote ? "online" : poll ? "polling" : "offline";
        if (verdict !== local_verdict[i]) {
          count("CLUSTER", "presence_mismatch");
          count("CLUSTER", `presence_mismatch_${local_verdict[i]}_vs_${verdict}`);
        }
        // a key naming us without a local socket is a leftover
        if (ws && ws.wid === WORKER_ID && !opening.has(ws.cid)) {
          presence.release_stale_soon(uid, ws.cid);
        }
      });
    })
    .catch(() => count("CLUSTER", "shadow_lookup_failed"));
};

// ---------------------------------------------------------------------------
// deliver (§13.6.3)
// ---------------------------------------------------------------------------

/**
 * Deliver an already-serialised frame to `recipients` wherever they are
 * connected and classify them for FCM. `store_msg` (a vital event) is queued
 * in the pending store for EVERY recipient.
 * Never throws for a delivery problem; a slow Redis costs at most the
 * presence deadline (on) — in local mode nothing here waits on Redis except
 * the pending store, exactly as before.
 */
type DeliverOptions = {
  // Wake parked poll v2 requests of the recipients for a frame that is not a
  // stored vital event but changes their pulled state (chat:wm). Vital
  // events (store_msg) always nudge.
  nudge_chat?: string;
};

const deliver = async (
  recipients: string[],
  frame: string,
  store_msg?: VitalWSMessage,
  opts: DeliverOptions = {},
): Promise<BucketArrays> => {
  // Poll v2 (R3): every committed vital event, and any frame the caller
  // flags, wakes the recipients' parked long-polls once it is stored.
  const nudge_chat = store_msg ? chat_of_frame(store_msg) : opts.nudge_chat;
  let remote_waiters: Map<string, string[]> | null = null;
  const b = new_buckets();
  const rest: string[] = [];
  // Only message:new arms the ack fallback; everything else skips the list.
  const observed: string[] | null =
    delivery_observer && store_msg?.type === "message:new" ? [] : null;

  // 1) local fast path
  for (const uid of recipients) {
    const c = socket_connections.get(uid);
    if (c && c.ws.readyState === 1) {
      b.online.add(uid);
      // Backgrounded clients keep a live WS (so they get the frame), but the
      // OS may have frozen the socket, so they ALSO need a push.
      if (c.is_background) b.background.add(uid);
      // ws_send never throws and marks the connection congested on
      // backpressure (§14.5 item 4); a dropped vital frame is still covered
      // by the pending store below.
      ws_send(c.ws, frame, c, uid);
      observed?.push(uid);
    } else {
      rest.push(uid);
    }
  }
  if (observed && observed.length > 0) {
    try {
      delivery_observer?.local(observed, store_msg!);
    } catch (err) {
      console.error("[CLUSTER] delivery observer failed:", err);
    }
  }

  // 2) pending store (off the classification path). Every recipient, except
  //    that with sync_v2 'on' + the proto lease, proto-2 lease holders get
  //    only the events heads/delta cannot rebuild (§3.13,
  //    pending-suppress.ts; a no-op returning `recipients` otherwise).
  //    Load-test users (+99900…, never connect) are left out of the store
  //    only: nobody would ever drain their copies (load-test-registry.ts).
  const store_rcpts = store_msg ? drop_test_users(recipients) : recipients;
  const store_p =
    store_msg && store_rcpts.length > 0
      ? pending_store_recipients(store_rcpts, store_msg)
        .then((uids) => (uids.length > 0 ? store_pending_message_for_users(uids, store_msg) : undefined))
        .catch((err) => {
          console.error("[BROADCAST] Error storing pending messages:", err);
        })
      : null;

  // 3) everyone else
  if (rest.length > 0) {
    if (presence_authoritative() && !is_sole_worker()) {
      // poll:waiter GETs ride the presence pipeline only while some user
      // can be on poll v2 (gate open for a bucket).
      remote_waiters = await route_via_presence(rest, frame, b, nudge_chat !== undefined && poll_v2_possible());
    } else {
      classify_local(rest, b);
      if (ROUTING_MODE === "shadow" && Math.random() < SHADOW_SAMPLE) shadow_compare(rest, b);
    }
  }

  if (store_p) {
    if (presence_authoritative()) {
      // §13.6.3: the store is awaited with a 1 s deadline, then left running
      // as tracked work (the drain waits for it) — a slow Redis must not
      // hold every caller of broadcast_message.
      track(store_p);
      await deadline(store_p, STORE_DEADLINE_MS, "pending store").catch(() => {
        count("CLUSTER", "store_slow");
      });
    } else {
      await store_p;
    }
  }
  // After the store settled (or its deadline passed): a woken waiter reads
  // the pending queue, so it must find this frame there. In-process for
  // waiters here (no Redis), one inbox PUBLISH per worker holding others.
  if (nudge_chat !== undefined) nudge_after_fanout(recipients, nudge_chat, remote_waiters);
  return bucket_arrays(b);
};

// ---------------------------------------------------------------------------
// presence questions other modules ask
// ---------------------------------------------------------------------------

const worker_alive = async (wid: string): Promise<boolean> => {
  const known = worker_known_alive(wid);
  if (known !== undefined) return known;
  try {
    return (await deadline(rfast.exists(k.worker(wid)), PRESENCE_DEADLINE_MS, "worker alive")) === 1;
  } catch {
    return false;
  }
};

/**
 * Does the user hold an open WebSocket anywhere (§13.6.3)? Local map first;
 * in `on` mode with siblings, the registry's ws key naming a live worker.
 * Errors / deadline → false (callers then use FCM, which is the safe side).
 */
const is_user_online = async (user_id: string): Promise<boolean> => {
  if (is_local_online(user_id)) return true;
  if (!presence_authoritative() || is_sole_worker()) return false;
  let ws: WsPresence | null | undefined;
  try {
    ws = (await presence.lookup([user_id]))[0]?.ws;
  } catch {
    count("CLUSTER", "router_deadline_hit");
    return false;
  }
  if (!ws || ws.wid === WORKER_ID) return false;
  return worker_alive(ws.wid);
};

/**
 * Is the user present anywhere (socket or fresh poll lease)? For the offline
 * debounce / eviction (§13.7 A6/A7). null = unknown (Redis failed): the
 * caller keeps its pre-RC-2 behaviour.
 */
const is_present = async (user_id: string): Promise<boolean | null> => {
  if (is_local_online(user_id)) return true;
  const lease = polling_connections.get(user_id);
  if (lease && poll_lease_verdict(lease_seen_ms(lease), Date.now()) === "polling") {
    return true;
  }
  if (is_sole_worker()) return false;
  try {
    const [p] = await presence.lookup([user_id]);
    if (p?.poll) return true;
    if (!p?.ws) return false;
    if (p.ws.wid !== WORKER_ID) return true;
    // A key naming THIS worker without a local socket is a leftover (its
    // release was lost) unless that socket is mid-open — it must not keep a
    // user who left "present" until the 45 s TTL.
    if (opening.has(p.ws.cid)) return true;
    presence.release_stale_soon(user_id, p.ws.cid);
    return false;
  } catch {
    return null;
  }
};

/**
 * Presence snapshot for a socket that just opened (§13.6.5 step 8, A5):
 * which of `peers` are online (socket anywhere or a fresh poll lease).
 * Registry failure → the local answer only.
 */
const online_peers = async (peers: string[]): Promise<string[]> => {
  const now = Date.now();
  const online: string[] = [];
  const unknown: string[] = [];
  for (const peer of peers) {
    const lease = polling_connections.get(peer);
    if (
      is_local_online(peer) ||
      (lease && poll_lease_verdict(lease_seen_ms(lease), now) === "polling")
    ) {
      online.push(peer);
    } else {
      unknown.push(peer);
    }
  }
  if (unknown.length === 0 || is_sole_worker()) return online;
  try {
    const pres = await presence.lookup(unknown);
    unknown.forEach((peer, i) => {
      const p = pres[i];
      if ((p?.ws && p.ws.wid !== WORKER_ID) || p?.poll) online.push(peer);
    });
  } catch {
    count("CLUSTER", "snapshot_lookup_failed");
  }
  return online;
};

// ---------------------------------------------------------------------------
// eviction (§13.6.5 steps 4–5)
// ---------------------------------------------------------------------------

// May this user's previous socket be closed with 4009 now? See ReplaceDamper.
const may_close_replaced = (user_id: string): boolean => {
  const ok = replace_damper.allow(user_id);
  if (!ok) count("CLUSTER", "evict_pingpong_suppressed");
  return ok;
};

// The claim found the user's previous socket on ANOTHER worker: ask it to
// close that socket (it does so only if the cid still matches).
const send_evict = (user_id: string, old: WsPresence, new_cid: string): void => {
  if (old.wid === WORKER_ID) return;
  if (!may_close_replaced(user_id)) return;
  count("CLUSTER", "evict_sent");
  deadline(inbox.publish_evict(old.wid, user_id, old.cid, new_cid), PRESENCE_DEADLINE_MS, "evict publish")
    .catch(() => count("CLUSTER", "evict_publish_failed"));
};

// ---------------------------------------------------------------------------
// inbox (§13.6.2)
// ---------------------------------------------------------------------------

const handle_inbox = (raw: string): void => {
  const m = decode_inbox(raw);
  if (!m) {
    count("CLUSTER", "inbox_malformed");
    return;
  }
  switch (m.kind) {
    case "deliver": {
      const delivered: string[] = [];
      for (const uid of m.uids) {
        const c = socket_connections.get(uid);
        if (c && c.ws.readyState === 1) {
          ws_send(c.ws, m.frame, c, uid);
          delivered.push(uid);
        } else {
          // moved / closed since the sender's lookup: at-most-once (§13.6.4)
          count("CLUSTER", "remote_miss");
        }
      }
      if (delivered.length) {
        count("CLUSTER", "remote_received", delivered.length);
        // The socket lives here, so its ack deadline does too.
        try {
          delivery_observer?.remote(delivered, m.frame);
        } catch (err) {
          console.error("[CLUSTER] delivery observer failed:", err);
        }
      }
      return;
    }
    case "evict": {
      const c = socket_connections.get(m.uid);
      if (c && c.cid === m.old_cid) {
        count("CLUSTER", "evicted_ghosts");
        close_replaced(m.uid, c, m.new_cid);
      } else {
        count("CLUSTER", "evict_miss");
      }
      return;
    }
    default:
      // nudge / supersede: poll v2 waiters (R3, cache-management/sync-nudge)
      if (!handle_poll_inbox(m)) count("CLUSTER", `inbox_unhandled_${m.kind}`);
  }
};

// The inbox is subscribed in every mode: it costs one channel on the shared
// subscriber, and a sibling switched to `on` first can already reach us.
bus.on(k.inbox(WORKER_ID), handle_inbox);

export {
  deliver,
  set_delivery_observer,
  is_user_online,
  is_present,
  online_peers,
  may_close_replaced,
  send_evict,
  handle_inbox,
};
