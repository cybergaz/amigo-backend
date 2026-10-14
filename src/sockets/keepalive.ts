import type {
  ConnectionStatusPayload,
  KeepaliveMode,
  UserConnection,
} from "@/types/socket.types";

// =============================================================================
// Server-driven keepalive (SYNC_V2 §14.5 item 3) — pure decision logic
// =============================================================================
// Kept free of sockets/timers so it can be unit-tested (tests/keepalive.test.ts);
// socket.server.ts runs it from its tick and performs the side effects.
//
// Rules:
// - ONE keepalive per idle interval: the server sends its socket:ping only if
//   it received nothing on that socket within the interval. A chatty
//   foreground client (which pings on its own) therefore costs no server
//   pings at all; a silent backgrounded client still gets a packet every
//   interval, which is what keeps the Wi-Fi router's NAT mapping and
//   Cloudflare's 100 s proxy window open while the phone's CPU sleeps (Dart
//   timers do not fire then, so the client cannot be relied on).
// - The interval is per connection: fg 20 s, bg 45 s, announced by the client
//   in connection:status {mode, ka_s}. Old clients announce nothing → 20 s.
//   Every interval stays within [20 s, 50 s], well inside Cloudflare's 100 s.
// - Close after MAX_MISSED_PINGS silent intervals (≈ 60 s in the foreground).
// - A socket that stays congested (ws.send backpressure, never drained) for
//   CONGESTED_CLOSE_MS is closed with 4008 so the app stops trusting it.
//   One that dropped a frame (over backpressureLimit) is closed on the next
//   tick, drained or not: only a reconnect replays what it lost.

const KEEPALIVE_TICK_MS = 5_000;
const KEEPALIVE_FG_MS = 20_000;
const KEEPALIVE_BG_MS = 45_000;
const KEEPALIVE_MIN_MS = 20_000;
const KEEPALIVE_MAX_MS = 50_000;
const MAX_MISSED_PINGS = 3;
const CONGESTED_CLOSE_MS = 30_000;

type KeepaliveDecision = "wait" | "skip" | "ping" | "stale" | "congested";

// Parse the optional keepalive announcement of a connection:status payload.
// Returns null when the client announced nothing usable (old clients) — the
// connection then keeps whatever it had (default fg / 20 s).
const resolve_keepalive = (
  payload: unknown,
): { mode: KeepaliveMode; keepalive_ms: number } | null => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<ConnectionStatusPayload>;
  const mode = p.mode;
  if (mode !== "fg" && mode !== "bg" && mode !== "reliable") return null;
  // 'reliable' (server-learned interval) is a later release; until then it
  // gets the background interval.
  let keepalive_ms = mode === "fg" ? KEEPALIVE_FG_MS : KEEPALIVE_BG_MS;
  if (typeof p.ka_s === "number" && Number.isFinite(p.ka_s)) {
    keepalive_ms = Math.min(
      KEEPALIVE_MAX_MS,
      Math.max(KEEPALIVE_MIN_MS, Math.round(p.ka_s * 1000)),
    );
  }
  return { mode, keepalive_ms };
};

// What the tick should do with this connection right now.
//   wait      — the link was active (either direction) within the interval;
//   skip      — same as wait, but this is the moment the server would have
//               pinged and inbound traffic made it unnecessary. Returned at
//               most once per interval, only so it can be counted;
//   ping      — idle for a full interval: send socket:ping;
//   stale     — nothing received for MAX_MISSED_PINGS intervals (the server
//               probed in between and got no answer): evict;
//   congested — backpressure has not drained for CONGESTED_CLOSE_MS, or a
//               frame was dropped: close 4008.
//
// The idle clock runs from the latest activity in either direction (last
// inbound frame or our last ping), so pings go out every `interval` while the
// client is silent: inbound at 0 → ping ≈20 s → ping ≈40 s → stale ≈60 s (fg,
// plus up to one KEEPALIVE_TICK_MS of tick granularity).
const keepalive_decision = (
  conn: Pick<
    UserConnection,
    | "missed_pings"
    | "last_inbound_at"
    | "last_ping_at"
    | "last_keepalive_at"
    | "keepalive_ms"
    | "congested_since"
    | "dropped_at"
  >,
  now: number,
): KeepaliveDecision => {
  if (conn.dropped_at !== undefined) return "congested";
  if (
    conn.congested_since !== undefined &&
    now - conn.congested_since >= CONGESTED_CLOSE_MS
  ) {
    return "congested";
  }
  const interval = conn.keepalive_ms ?? KEEPALIVE_FG_MS;
  const last_in = conn.last_inbound_at ?? 0;
  const last_ping = conn.last_ping_at ?? 0;

  if (now - Math.max(last_in, last_ping) < interval) {
    if (
      now - last_ping >= interval &&
      now - (conn.last_keepalive_at ?? 0) >= interval
    ) {
      return "skip";
    }
    return "wait";
  }
  // Require that we actually probed (missed_pings) before evicting, so an
  // interval change (bg 45 s → fg 20 s) can never evict a socket unprobed.
  if (
    now - last_in >= MAX_MISSED_PINGS * interval &&
    conn.missed_pings >= MAX_MISSED_PINGS - 1
  ) {
    return "stale";
  }
  return "ping";
};

export {
  KEEPALIVE_TICK_MS,
  KEEPALIVE_FG_MS,
  KEEPALIVE_BG_MS,
  KEEPALIVE_MIN_MS,
  KEEPALIVE_MAX_MS,
  MAX_MISSED_PINGS,
  CONGESTED_CLOSE_MS,
  resolve_keepalive,
  keepalive_decision,
};
export type { KeepaliveDecision };
