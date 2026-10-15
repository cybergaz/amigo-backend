import type { ConnectionStatusType } from "@/types/socket.types";
import { polling_connections } from "./connections";
import { set_poll_soon } from "@/cluster/presence";
import { POLL_LEASE_FRESH_MS } from "@/cluster/router-core";
import {
  hinted_background,
  is_bg_flag,
  is_fg_flag,
  next_lease_status,
  note_announced_status,
} from "./presence-flags";

// =============================================================================
// The caller's polling lease (poll v1 routes and, from R3, poll v2)
// =============================================================================
// Moved out of chat-poll.routes.ts unchanged so POST /chat/sync/poll (R3)
// refreshes the SAME lease — a v2 long-poller is a poller for FCM bucketing
// exactly like a v1 one. v1 calls it without options: byte-for-byte the old
// behaviour.

type LeaseOptions = {
  // Poll v2: epoch ms until which the parked long-poll keeps the lease fresh
  // (router-core lease_seen_ms). The 10 s v1 freshness would otherwise call
  // a foreground long-poller offline (FCM + eviction) halfway through its
  // 25 s wait.
  held_until?: number;
  // Poll v2: presence:{uid}:poll TTL (wait + 15 s, §13.17.2) instead of v1's 12 s.
  presence_ttl_s?: number;
};

// Create or refresh the caller's polling lease (what broadcast_message reads
// to bucket a poller, and to decide FCM). `bg` is the client's background
// flag (?bg=1, SYNC_V2 R0.1): a lease created or refreshed during a
// background wake must say 'background', or FCM routing treats the phone as
// a foreground poller and sends it no push. New clients send ?bg=0 in the
// foreground, which clears it. See presence-flags.ts.
const touch_poll_lease = (
  user_id: string,
  client_ip: string,
  raw_bg: unknown,
  opts: LeaseOptions = {},
): void => {
  const bg = is_bg_flag(raw_bg);
  const fg = is_fg_flag(raw_bg);
  if (bg) note_announced_status(user_id, "background");
  else if (fg) note_announced_status(user_id, "online");
  const existing_connection = polling_connections.get(user_id);
  let status: ConnectionStatusType;
  if (existing_connection) {
    existing_connection.last_poll_at = new Date();
    existing_connection.client_ip = client_ip;
    existing_connection.connection_status = next_lease_status(
      existing_connection.connection_status, bg, false, fg,
    );
    if (opts.held_until !== undefined) existing_connection.held_until = opts.held_until;
    status = existing_connection.connection_status;
  } else {
    status = next_lease_status(undefined, bg, hinted_background(user_id), fg);
    polling_connections.set(user_id, {
      connection_status: status,
      last_poll_at: new Date(),
      client_ip,
      // connected_at: new Date(),
      ...(opts.held_until !== undefined ? { held_until: opts.held_until } : {}),
    });
  }
  // The same lease in the presence registry (SYNC_V2 §13.7 A4,
  // presence:{uid}:poll = "wid|bg", EX 12 s), so a fan-out on ANY worker
  // buckets this user as a (background) poller. Only an explicit bg / fg
  // flag writes bg there; without one (every 4.2.2 poll) the registry keeps
  // its value, because THIS worker's lease may never have seen the status
  // frame that landed on another worker. Fire-and-forget: a poll never
  // waits on it; a no-op with CLUSTER_ROUTING=local.
  set_poll_soon(user_id, bg ? true : fg ? false : null, status === "background", opts.presence_ttl_s);
};

// Poll v2: the parked request answered; from now on the lease ages like a
// v1 one (fresh for 10 s from this moment — the client re-polls at once).
// Only moves held_until back if it is still ours (a newer request of the
// same user may have extended it meanwhile).
const end_poll_hold = (user_id: string, held_until: number, now: number = Date.now()): void => {
  const lease = polling_connections.get(user_id);
  if (lease && lease.held_until === held_until) lease.held_until = now;
};

// Poll v2: the parked request's client is gone (request.signal aborted: the
// app was killed or its connection reset). Holding the lease to held_until
// (+ the 10 s freshness) would keep bucketing the user as a foreground
// poller — no FCM — for ~35 s after the phone left; age it out now instead,
// so the next fan-out pushes. Only if the lease is still this request's (a
// newer request of the same user re-set held_until and owns it).
const drop_poll_hold = (user_id: string, held_until: number, now: number = Date.now()): void => {
  const lease = polling_connections.get(user_id);
  if (!lease || lease.held_until !== held_until) return;
  const stale_at = now - POLL_LEASE_FRESH_MS;
  lease.held_until = stale_at;
  if (lease.last_poll_at && lease.last_poll_at.getTime() > stale_at) lease.last_poll_at = new Date(stale_at);
};

export { touch_poll_lease, end_poll_hold, drop_poll_hold };
export type { LeaseOptions };
