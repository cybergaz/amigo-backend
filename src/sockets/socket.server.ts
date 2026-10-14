import { authenticate_jwt } from "@/middleware";
import { WSMessageSchema } from "@/types/socket.elysia-schema";
import Elysia, { t } from "elysia";
import { ElysiaWS } from "elysia/dist/ws";
import {
  broadcast_message,
  get_ws_data,
  set_ws_data,
  socket_message_handler,
} from "./socket.handlers";
// import { handle_user_disconnected_midcall } from "./socket.service";
// import { StreamCallService } from "@/services/stream-call.service";
import {
  ConnectionStatusPayload,
  PollingConnection,
  UserConnection,
  WSMessage,
} from "@/types/socket.types";
import {
  touch_users_last_seen,
  update_user_details,
} from "@/services/user.services";
// import { sync_missed_messages } from "@/services/chat.services";
import {
  start_cleanup_cron,
  stop_cleanup_cron,
} from "@/cache-management/polling.cache";
import { get_user_peers } from "@/cache-management/user-peer.cache";
import { is_device_token_current } from "@/services/session.service";
import { AuthError } from "@/constants/auth-codes";
import { get_user_name } from "@/cache-management/user-name.cache";
import { count, flush_counters, observe_ms } from "@/utils/counters";
import { ws_send } from "./ws-send";
import {
  KEEPALIVE_FG_MS,
  KEEPALIVE_TICK_MS,
  keepalive_decision,
  resolve_keepalive,
} from "./keepalive";
import { is_draining, track } from "@/cluster/lifecycle";

// Connection maps for different transport types
const socket_connections = new Map<string, UserConnection>(); // user_id -> UserConnection (WebSocket)
const polling_connections = new Map<string, PollingConnection>(); // user_id -> PollingConnection

// Give the Stream busy-registry a socket-liveness probe so it can lazily
// clear leaked "user is on a call" entries (see StreamCallService.isUserBusy).
// Injected here — the service must not import socket internals (cycle).
// StreamCallService.setLivenessProbe((user_id: string) => {
//   const conn = socket_connections.get(user_id);
//   return !!conn && conn.ws.readyState === 1;
// });

// configuration
// Keepalive / liveness constants live in ./keepalive.ts (SYNC_V2 §14.5): one
// server ping per idle interval (fg 20 s / bg 45 s), evict after ~3 silent
// intervals, close 4008 after 30 s of undrained backpressure.
const STATS_LOGGING_INTERVAL_MS = 600000;
const OFFLINE_STATUS_BROADCAST_DELAY_MS = 8000;
// The port is chosen and bound by server.ts boot() (listen only after deps
// are ready, SYNC_V2 §13.9.2) — this module only defines the app.

// Frames a client may send before its socket is registered (§14.5 item 5).
// The old app sleeps 200/700 ms after connect before sending, so in practice
// this only holds a handful of frames while `open` awaits the device check.
const EARLY_FRAME_LIMIT = 32;
// Inbound frame cap. Text messages are split client-side at 3.5 KB, so a
// legitimate frame is far below this; Bun closes the socket (1009) above it.
const WS_MAX_PAYLOAD_BYTES = 256 * 1024;
// Per-socket send buffer before ws.send starts dropping (returns 0). 1 MiB is
// minutes of chat traffic; a socket that far behind is congested (§14.5).
const WS_BACKPRESSURE_LIMIT_BYTES = 1_048_576;
// Sync protocol this server speaks, announced in socket:ready. 1 = legacy
// (pending-queue replay). Sync v2 raises it for clients that connect with
// ?proto=2.
const SERVER_SYNC_PROTO = 1;
// last_seen for newly-opened sockets is written in batches (see
// flush_last_seen_on_open) instead of inline in `open`.
const LAST_SEEN_FLUSH_INTERVAL_MS = 30_000;
const LAST_SEEN_FLUSH_CHUNK = 1000;

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;
let lastSeenInterval: ReturnType<typeof setInterval> | null = null;

// Users whose socket opened since the last last_seen flush.
const pending_last_seen_on_open = new Set<string>();

// 12-hex per-connection nonce (§13.6.5 step 1): ties log lines of one socket
// together; RC-2 also carries it in the 4009 close reason.
const new_cid = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

// WebSocket server
const web_socket_server = new Elysia({
  websocket: {
    idleTimeout: 60, // x seconds of inactivity before closing the connection
    sendPings: true,
    perMessageDeflate: true, // RFC 7692 compression — reduces mobile fragmentation risk
    // SYNC_V2 §14.5 item 4. Without these Bun buffers up to 16 MB per socket
    // for a peer that stopped reading (dead Wi-Fi, frozen app) and accepts
    // 16 MB inbound frames. closeOnBackpressureLimit:false → over the limit
    // send() drops (returns 0) and ws-send.ts marks the socket congested; the
    // keepalive tick closes it with 4008 if it never drains.
    maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
    backpressureLimit: WS_BACKPRESSURE_LIMIT_BYTES,
    closeOnBackpressureLimit: false,
  },
})
  .onError(({ error, path }) => {
    const err = error as any;
    switch (err.code) {
      case "NOT_FOUND":
        console.error("[SOCKET] WebSocket server endpoint not found");
        return {
          type: "socket:error",
          message: "WebSocket endpoint not found",
        };

      case "VALIDATION":
        console.error("[SOCKET] WebSocket server validation error at", path);
        // console.error(err);
        return {
          type: "socket:error",
          message: "WebSocket validation error",
          error: {
            expected: err.expected,
            received: err.value,
            valueError: {
              field: err.valueError?.path,
              message: err.valueError?.message,
            },
          },
        };

      case "INTERNAL_SERVER_ERROR":
        console.error("[SOCKET] WebSocket server internal server error");
        return {
          type: "socket:error",
          message: "WebSocket internal server error",
        };
    }
  })

  .ws("/chat", {
    // schema validations
    body: WSMessageSchema,
    // `proto` (Sync v2 capability, §4.3) is accepted now so a newer app that
    // already sends it can connect; this release does not act on it.
    query: t.Object({ token: t.String(), proto: t.Optional(t.String()) }),

    error: ({ error }) => {
      const err = error as any;
      switch (err.code) {
        case "VALIDATION":
          console.error("[SOCKET] Validation error:", {
            expected: err.expected,
            received: err.value,
            valueError: {
              field: err.valueError?.path,
              message: err.valueError?.message,
            },
          });
          // console.log(err);
          return {
            type: "socket:error",
            message: "WebSocket validation error",
            error: {
              expected: err.expected,
              received: err.value,
              valueError: {
                field: err.valueError?.path,
                message: err.valueError?.message,
              },
            },
          };
      }
    },

    open: async (ws) => {
      const opened_at = Date.now();
      try {
        // Extract and validate JWT token
        const url = new URL(ws.data.request.url);
        const token = url.searchParams.get("token");

        if (token == "websocket-connectivity-check") {
          ws.close(4200, "Connectivity check - no authentication needed");
          // console.log("[SOCKET] Received connectivity check ping, responded with health check message");
          return;
        }

        if (!token) {
          ws.send(
            {
              type: "socket:error",
              error_code: "AUTH_REQUIRED",
              auth_error: AuthError.TOKEN_MISSING,
              message: "Authentication token is required",
              timestamp: new Date().toISOString(),
            },
            true,
          );
          ws.close(4001, "Missing authentication token");
          return;
        }

        // Verify JWT token
        const auth_result = authenticate_jwt(token);
        if (!auth_result.success || !auth_result.data) {
          // Forward the specific auth_error (TOKEN_EXPIRED/TOKEN_INVALID). These are
          // NON-terminal on the socket: the client reconnects, it does not log out.
          ws.send({
            type: 'socket:error',
            error_code: 'AUTH_INVALID',
            auth_error: (auth_result as { auth_error?: string; }).auth_error ?? AuthError.TOKEN_INVALID,
            message: 'Invalid or expired authentication token',
            timestamp: new Date().toISOString()
          }, true);
          ws.close(4001, "Invalid authentication token");
          return;
        }

        // §13.6.5 step 1: from here until step 6 the socket exists but is NOT
        // registered — any frame the client sends meanwhile is buffered by the
        // `message` callback, never processed. `user_id` stays unset until the
        // device check below passes, so nothing can act as this user early.
        set_ws_data(ws, { cid: new_cid(), registered: false });

        // Single-device enforcement (mobile device tokens only). A device token
        // carries device_id + token_version; if they no longer match the current
        // auth_devices row (checked via Redis, DB fallback on miss), this device was
        // superseded by a newer login → reject. Old/admin/web tokens lack these
        // claims → skipped (dual-run). Runs BEFORE the socket registers so a
        // rejected connection never enters socket_connections / presence.
        const device_id = auth_result.data.device_id;
        const token_version = auth_result.data.token_version;
        if (device_id != null && token_version != null) {
          const uid = auth_result.data.id;
          // Shared with the HTTP long-polling guard (middleware/enforce_device_token)
          // so the socket and its fallback transport enforce the SAME rule.
          const ok = await is_device_token_current(uid, device_id, token_version);
          if (!ok) {
            // Frames buffered from a superseded device are discarded unread.
            set_ws_data(ws, { early_frames: undefined });
            // Terminal: single-device supersede. Send the labeled frame before the
            // close so a client reading it gets the reason; close(4003) remains the
            // primary logout trigger.
            ws.send(
              {
                type: "socket:error",
                auth_error: AuthError.DEVICE_SUPERSEDED,
                message: "Session superseded on another device",
                timestamp: new Date().toISOString(),
              },
              true,
            );
            ws.close(4003, "Session superseded on another device");
            return;
          }
        }

        // §13.6.5 step 3. Store user_id in WebSocket data using type-safe helper.
        const user_id = auth_result.data.id;
        set_ws_data(ws, { user_id });

        // The name comes from the name cache, NOT from the old
        // update_user_details(last_seen) round-trip: that row-locking UPDATE
        // on every connect turned each reconnect herd into an RDS write burst
        // (D-C4). last_seen is now batched below (pending_last_seen_on_open)
        // and still written on close/offline as before.
        const user_name = await get_user_name(user_id);
        set_ws_data(ws, { user_name });

        // The client may have gone away while we awaited the device check /
        // name. Registering it now would put a dead socket in the map and
        // announce a user "online" who already left.
        if (get_ws_data(ws, "closed") === true) {
          console.log(
            `[WS] socket closed during open for user ${user_id} (cid=${get_ws_data(ws, "cid")}), not registering`,
          );
          return;
        }

        // The drain started while this socket was opening (the listener is
        // already stopped, so only in-flight handshakes get here). Do not
        // register a socket that the drain would close a moment later: send
        // it straight to the sibling / the next process. Never registered →
        // the close callback does no offline broadcast and no last_seen.
        if (is_draining()) {
          set_ws_data(ws, { early_frames: undefined });
          send_restart_and_close(ws);
          return;
        }

        // Extract client IP for logging/diagnostics
        const request = ws.data.request;
        const client_ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip") ||
          "unknown";

        // §13.6.5 step 4. Add to active socket connections with new tracking
        // fields. A fresh connection always starts foreground
        // (is_background:false, 20 s keepalive); a reconnect therefore clears
        // any prior background flag / announced mode automatically.
        const now_ms = Date.now();
        const connection: UserConnection = {
          ws,
          missed_pings: 0,
          is_background: false,
          last_inbound_at: now_ms,
          last_keepalive_at: now_ms,
          keepalive_ms: KEEPALIVE_FG_MS,
          keepalive_mode: "fg",
          // connection_status: "online",
          // transport_type: "ws",
          // connected_at: new Date(),
          // client_ip
        };
        socket_connections.set(user_id, connection);

        // removing from polling connections if exists (in case user switched transport without closing previous connection properly)
        if (polling_connections.has(user_id)) {
          polling_connections.delete(user_id);
          console.log(
            `[WS] User ${user_id} switched from polling to WebSocket, removed from polling connections`,
          );
        }

        // last_seen ≥ connect time, written off the open path in one batched
        // UPDATE (flush_last_seen_on_open).
        pending_last_seen_on_open.add(user_id);

        // §13.6.5 step 6: registered → process the frames that arrived early
        // (in arrival order), then tell the client the socket is fully live.
        // Old apps ignore socket:ready (unknown type → dropped by their parser).
        set_ws_data(ws, { registered: true });
        count("WS", "opens");
        observe_ms("WS", "open_ms", Date.now() - opened_at);
        drain_early_frames(ws);
        ws_send(
          ws,
          {
            type: "socket:ready",
            proto: SERVER_SYNC_PROTO,
            server_time: new Date().toISOString(),
            cid: get_ws_data(ws, "cid"),
          },
          connection,
          user_id,
        );

        // notify all connected users about this user being online
        const connected_users = await get_user_peers(user_id);

        const message_payload: ConnectionStatusPayload = {
          sender_id: user_id,
          status: "online",
        };

        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: Array.from(connected_users),
          message: {
            type: "connection:status",
            payload: message_payload,
            ws_timestamp: new Date(),
          },
        });

        // Presence snapshot: send current online status of B's peers back to B
        // so B's UI reflects who's already online. Without this, B only ever
        // learns about peers when they toggle state (connect/disconnect) —
        // peers already online before B connected would appear offline forever.
        const snapshot_at = new Date();
        for (const peer_id of connected_users) {
          const peer_conn = socket_connections.get(peer_id);
          if (peer_conn && peer_conn.ws.readyState === 1) {
            ws_send(
              ws,
              {
                type: "connection:status",
                payload: {
                  sender_id: peer_id,
                  status: "online",
                } as ConnectionStatusPayload,
                ws_timestamp: snapshot_at,
              },
              connection,
              user_id,
            );
          }
        }

        // logConnectionSuccess('ws', user_id, client_ip, { user_name });

        // =============================================================================
        // Message Sync on Reconnection
        // =============================================================================
        // Sync missed messages to the user (this also marks them as delivered)
        // This is critical for users who temporarily lost connection
        // await sync_missed_messages(user_id);
      } catch (error) {
        set_ws_data(ws, { early_frames: undefined });
        const request = ws.data.request;
        const client_ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip") ||
          "unknown";
        logConnectionError("ws_open", undefined, client_ip, error);
        ws.close(4000, "Connection error");
      }
    },

    message: async (ws, message) => {
      // §14.5 item 5: until `open` has registered the socket (auth + device
      // check passed, entry in socket_connections) frames are only buffered.
      // Before R0.1 they ran with user_id unset and were silently dropped —
      // the first frames after every reconnect (often outbox replays) were lost.
      if (get_ws_data(ws, "registered") !== true) {
        buffer_early_frame(ws, message);
        return;
      }
      // heavy lifting is done in the handler. Tracked so a drain waits for
      // a frame that is mid-handling (e.g. a send already committed but not
      // yet fanned out) before closing the pools (SYNC_V2 B6).
      await track(process_frame(ws, message as WSMessage));
    },

    // Bun calls drain once a socket that reported backpressure (send() → -1)
    // has flushed its buffer: it is healthy again (§14.5 item 4). A socket
    // that dropped a frame keeps dropped_at and is still closed by the tick.
    drain: (ws) => {
      const user_id = get_ws_data(ws, "user_id") as string | undefined;
      if (!user_id) return;
      const conn = socket_connections.get(user_id);
      if (conn && conn.ws.raw === ws.raw && conn.congested_since !== undefined) {
        observe_ms("WS", "congested_ms", Date.now() - conn.congested_since);
        conn.congested_since = undefined;
      }
    },
    // idleTimeout: 60, // x seconds of inactivity before closing the connection
    // sendPings: true,
    // ping(message) {
    //   console.log('[WS] Received ping');
    //
    // },
    // pong(message) {
    //   console.log('[WS] Received pong');
    // },

    close: async (ws, code) => {
      // Mark first: an `open` still awaiting the device check / name lookup
      // sees this and does not register a dead socket.
      set_ws_data(ws, { closed: true, early_frames: undefined });
      count("WS", `close_code_${code ?? "none"}`);

      // Never registered (auth rejected, closed mid-open, connectivity check):
      // it was never in socket_connections and never announced online, so
      // there is nothing to evict and no offline/last_seen to write.
      if (get_ws_data(ws, "registered") !== true) return;

      const user_id = get_ws_data(ws, "user_id") as string;
      if (user_id) {
        // Compare-and-delete (SYNC_V2 R0): only evict the entry if it is THIS
        // socket. On a reconnect the new socket's `open` overwrites the entry
        // before the old socket's close lands; an unconditional delete evicted
        // the live socket (its frames then went nowhere) and the debounce below
        // broadcast "offline" for a user who was online. Elysia wraps the Bun
        // socket in a fresh ElysiaWS per callback, so compare the raw socket.
        const current = socket_connections.get(user_id);
        if (current && current.ws.raw !== ws.raw) {
          console.log(
            `[WS] close of a superseded socket for user ${user_id} — live socket kept, no offline broadcast`,
          );
          return;
        }
        socket_connections.delete(user_id);

        // Closed by the drain with 1012 (SYNC_V2 §13.7 A6): the user is not
        // leaving, they are moving to the sibling / the next process within
        // seconds. Skip the offline debounce and the last_seen write — an
        // "offline" here would flap the user's status to every peer (and,
        // at N=1, nothing would ever re-announce them online if their
        // reconnect raced the 8 s timer on the sibling).
        if (get_ws_data(ws, "draining") === true) return;

        // CALLS — INSTANT, no debounce. If this user was in a CONNECTED call,
        // open the 30s rejoin window and tell the peer ("Reconnecting…") right
        // now. We deliberately do NOT wait out OFFLINE_STATUS_BROADCAST_DELAY_MS
        // here: a debounce would stack on top of itself and delay the peer's
        // "Reconnecting" by 8s+. The 30s rejoin window is the only timer that
        // governs a mid-call drop. No-op if the user wasn't in a connected call.
        // await handle_user_disconnected_midcall(user_id);

        // PRESENCE (non-call) — keep the reconnect-grace debounce so a brief WS
        // restart doesn't flap the user's online/offline status to peers.
        setTimeout(async () => {
          // If user has reconnected, a new entry will be in socket_connections
          if (socket_connections.has(user_id)) {
            console.log(
              `[CONNECTION-DISCONNECT] User ${user_id} reconnected within ${OFFLINE_STATUS_BROADCAST_DELAY_MS}, skipping offline broadcast`,
            );
            return;
          }

          // Notify all connected users about this user being offline
          const connected_users = await get_user_peers(user_id);
          const message_payload: ConnectionStatusPayload = {
            sender_id: user_id,
            status: "offline",
          };
          // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
          await broadcast_message({
            to: "users",
            user_ids: Array.from(connected_users),
            message: {
              type: "connection:status",
              payload: message_payload,
              ws_timestamp: new Date(),
            },
            exclude_user_ids: [user_id],
          });

          // update the online status of user in the DB
          await update_user_details(user_id, { last_seen: new Date() });

          // const stats = getConnectionStats();
          // console.log(`[CONNECTION-DISCONNECT] ${JSON.stringify({
          //   timestamp: new Date().toISOString(),
          //   ...stats,
          // })}`);
        }, OFFLINE_STATUS_BROADCAST_DELAY_MS);
      }
    },
  });

// =============================================================================
// Early frames + per-frame prologue (SYNC_V2 §13.6.5 / §14.5)
// =============================================================================

// Hold a frame that arrived before `open` registered the socket.
// Overflow closes the socket (1013) instead of silently dropping: the app's
// vital-event outbox retires backups when a later socket:pong proves "the
// server got everything before this ping" (R0 delivery proof). A dropped
// early frame followed by an answered ping would retire a backup the server
// never processed. Closing keeps that proof honest — the app reconnects and
// replays. In practice the buffer holds a few frames, so this is a guard.
function buffer_early_frame(ws: ElysiaWS, message: unknown) {
  if (get_ws_data(ws, "closed") === true) return;
  const buffered = (get_ws_data(ws, "early_frames") as unknown[] | undefined) ?? [];
  if (buffered.length >= EARLY_FRAME_LIMIT) {
    count("WS", "early_frames_dropped");
    console.warn(
      `[WS] early-frame buffer overflow (cid=${get_ws_data(ws, "cid")}, ${buffered.length} frames) — closing 1013`,
    );
    set_ws_data(ws, { early_frames: undefined });
    try {
      ws.close(1013, "Early frame overflow");
    } catch (e) { }
    return;
  }
  buffered.push(message);
  set_ws_data(ws, { early_frames: buffered });
  count("WS", "early_frames_buffered");
}

// Run the buffered frames in arrival order, the same way the `message`
// callback runs live ones (each starts in order; none is awaited before the
// next starts, exactly like Bun dispatching consecutive frames).
function drain_early_frames(ws: ElysiaWS) {
  const buffered = get_ws_data(ws, "early_frames") as unknown[] | undefined;
  set_ws_data(ws, { early_frames: undefined });
  if (!buffered || buffered.length === 0) return;
  for (const frame of buffered) {
    track(process_frame(ws, frame as WSMessage)).catch((error) => {
      console.error("[WS] Error processing early frame:", error);
    });
  }
}

// Every frame on a registered socket goes through here.
async function process_frame(ws: ElysiaWS, message: WSMessage): Promise<void> {
  const user_id = get_ws_data(ws, "user_id") as string;

  // Any inbound frame proves the client is alive (§14.5 item 2) — not just
  // socket:pong: under a burst the pong can queue behind data frames, and
  // killing a socket that is busy delivering was a false "stale". Only the
  // socket that is CURRENT for this user counts: a superseded socket's frames
  // must not keep the live entry's counter at zero (compare .raw — Elysia
  // creates a fresh wrapper per callback).
  const conn = socket_connections.get(user_id);
  const is_current = !!conn && conn.ws.raw === ws.raw;
  if (is_current) {
    conn.missed_pings = 0;
    conn.last_inbound_at = Date.now();
  }

  if (message.type === "socket:ping") {
    // Answer on the socket the ping arrived on (§14.5 item 1). The old path
    // went through broadcast_message → the uid's map entry, which during a
    // reconnect race is another socket (or none), so the pinging socket got
    // no pong and the client declared it dead. `t` (client clock) is echoed
    // for RTT; `srv` is the server clock. Old apps ignore both fields.
    count("WS", "pong_direct");
    ws_send(
      ws,
      {
        type: "socket:pong",
        ...(typeof message.t === "number" ? { t: message.t } : {}),
        srv: Date.now(),
        ws_timestamp: new Date().toISOString(),
      },
      is_current ? conn : undefined,
      user_id,
    );
    return;
  }

  if (message.type === "socket:pong") {
    // Liveness was refreshed above (for the current socket only).
    return;
  }

  if (message.type === "connection:status" && is_current) {
    // Optional keepalive announcement {mode, ka_s} (§14.5 item 3). Old
    // clients send none → the connection keeps 20 s. The status itself is
    // still handled below exactly as before.
    const ka = resolve_keepalive(message.payload);
    if (ka) {
      conn.keepalive_mode = ka.mode;
      conn.keepalive_ms = ka.keepalive_ms;
    }
  }

  await socket_message_handler(
    {
      user_id,
      user_name: get_ws_data(ws, "user_name") as string,
      // user_pfp: get_ws_data(ws, "user_pfp") as string,
    },
    message,
  );
}

// =============================================================================
// Keepalive / liveness (SYNC_V2 §14.5)
// =============================================================================
// One tick every KEEPALIVE_TICK_MS walks the map; keepalive_decision() (pure,
// ./keepalive.ts) says per connection whether to wait, skip (traffic flowed),
// ping, evict as stale, or close as congested. Server pings keep the NAT /
// Cloudflare path open for silent (backgrounded) clients; chatty clients cost
// no pings.

// Evict a socket that stopped answering (or is no longer open): close it,
// tell peers it is offline, record last_seen. Unchanged from the old
// heartbeat except the map delete is compare-and-delete (a reconnect may
// already have replaced the entry).
async function evict_stale_connection(user_id: string, connection: UserConnection) {
  console.log(
    `[WS-HEARTBEAT] User ${user_id} missed ${connection.missed_pings} pings (mode=${connection.keepalive_mode ?? "fg"}), closing connection`,
  );
  count("WS", "stale_evicted");

  try {
    connection.ws.close(4000, "Connection timeout - no pong response");
  } catch (e) { }
  if (socket_connections.get(user_id) === connection) {
    socket_connections.delete(user_id);
  }

  try {
    const connected_users = await get_user_peers(user_id);
    // Reconnected during the await (SYNC_V2 R0) — same check as the
    // close-handler debounce; don't announce a live user offline.
    if (socket_connections.has(user_id)) {
      console.log(
        `[WS-HEARTBEAT] User ${user_id} reconnected, skipping offline broadcast`,
      );
      return;
    }
    const message_payload: ConnectionStatusPayload = {
      sender_id: user_id,
      status: "offline",
    };
    await broadcast_message({
      to: "users",
      user_ids: Array.from(connected_users),
      message: {
        type: "connection:status",
        payload: message_payload,
        ws_timestamp: new Date(),
      },
      // exclude_user_ids: [user_id]
    });
  } catch (e) {
    console.error(
      `[WS-HEARTBEAT] Error notifying about stale connection for user ${user_id}:`,
      e,
    );
  }

  await update_user_details(user_id, { last_seen: new Date() });
  console.log(
    `[WS-HEARTBEAT] Cleaned up stale connection for user ${user_id}. Total connections: ${socket_connections.size}`,
  );
}

function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(() => {
    const now = Date.now();

    socket_connections.forEach((connection, user_id) => {
      if (connection.ws.readyState !== 1) {
        evict_stale_connection(user_id, connection).catch((e) =>
          console.error(`[WS-HEARTBEAT] evict failed for user ${user_id}:`, e),
        );
        return;
      }

      switch (keepalive_decision(connection, now)) {
        case "wait":
          return;

        case "skip":
          // Inbound traffic within the interval already proved liveness and
          // kept the NAT mapping warm — no ping needed (§14.5 "one keepalive
          // per idle interval").
          connection.last_keepalive_at = now;
          count("WS", "server_ping_skipped");
          return;

        case "congested":
          // Backpressure never drained for 30 s: frames are queued behind a
          // stalled pipe or dropped while the app thinks it is connected.
          // 4008 → old apps reconnect (generic close); new apps fall back to
          // long-polling. The close callback does presence + last_seen.
          count("WS", "congested_closed");
          console.warn(
            `[WS] closing congested socket for user ${user_id} (congested ${Math.round((now - (connection.congested_since ?? now)) / 1000)}s${connection.dropped_at !== undefined ? ", dropped frames" : ""})`,
          );
          try {
            connection.ws.close(4008, "Congested");
          } catch (e) { }
          return;

        case "stale":
          evict_stale_connection(user_id, connection).catch((e) =>
            console.error(`[WS-HEARTBEAT] evict failed for user ${user_id}:`, e),
          );
          return;

        case "ping":
          connection.last_ping_at = now;
          connection.last_keepalive_at = now;
          connection.missed_pings++;
          count("WS", "server_ping");
          ws_send(
            connection.ws,
            {
              type: "socket:ping",
              ws_timestamp: new Date(now).toISOString(),
            },
            connection,
            user_id,
          );
          return;
      }
    });
  }, KEEPALIVE_TICK_MS);

  console.log(
    `[WS-HEARTBEAT] Started keepalive tick (${KEEPALIVE_TICK_MS}ms, default interval ${KEEPALIVE_FG_MS}ms)`,
  );
}

// Stop the heartbeat mechanism
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log("[WS-HEARTBEAT] Stopped heartbeat interval");
  }
}

// Handle pong response from client - reset missed ping counter
function handlePongResponse(user_id: string) {
  const connection = socket_connections.get(user_id);
  if (connection) {
    connection.missed_pings = 0;
    // console.log(`[WS-HEARTBEAT] Received pong from user ${user_id}`);
  }
}

// =============================================================================
// Connection Statistics & Enhanced Logging
// =============================================================================

// Log detailed connection error with context
function logConnectionError(
  context: string,
  user_id: string | undefined,
  client_ip: string | undefined,
  error: any,
  additional_info?: Record<string, any>,
) {
  const errorLog = {
    timestamp: new Date().toISOString(),
    context,
    user_id,
    client_ip,
    error: error?.message || String(error),
    error_stack: error?.stack,
    connection_stats: {
      total_ws_cnx: socket_connections.size,
      total_polling_cnx: polling_connections.size,
    },
    ...additional_info,
  };

  console.error(`[CONNECTION-ERROR] ${JSON.stringify(errorLog)}`);
}

function startStatsLogging() {
  if (statsInterval) {
    clearInterval(statsInterval);
  }

  statsInterval = setInterval(() => {
    let congested = 0;
    let background_mode = 0;
    for (const conn of socket_connections.values()) {
      if (conn.congested_since !== undefined) congested++;
      if (conn.keepalive_mode && conn.keepalive_mode !== "fg") background_mode++;
    }
    console.log(
      `[CONNECTION-STATS] ${JSON.stringify({
        timestamp: new Date().toISOString(),
        total_ws_cnx: socket_connections.size,
        total_polling_cnx: polling_connections.size,
        ws_congested: congested,
        ws_bg_keepalive: background_mode,
      })}`,
    );
    // Per-window counters ([WS] opens/close_code_*/backpressure/…, [FCM]
    // priority_normal) — one line per tag, then reset (utils/counters.ts).
    flush_counters();
  }, STATS_LOGGING_INTERVAL_MS);

  console.log("[CONNECTION-STATS] Started periodic stats logging");
}

function stopStatsLogging() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

// =============================================================================
// last_seen for opened sockets, batched (SYNC_V2 D-C4)
// =============================================================================
// Replaces the inline UPDATE that every WS `open` used to await. Only users
// still connected at flush time are written — for them "now" is a true
// last-seen; anyone who disconnected meanwhile gets last_seen from the
// close/offline path, as before. A reconnect herd of N users becomes
// ceil(N / LAST_SEEN_FLUSH_CHUNK) statements, off the connect path.
async function flush_last_seen_on_open() {
  if (pending_last_seen_on_open.size === 0) return;
  const ids = Array.from(pending_last_seen_on_open).filter((id) =>
    socket_connections.has(id),
  );
  pending_last_seen_on_open.clear();
  for (let i = 0; i < ids.length; i += LAST_SEEN_FLUSH_CHUNK) {
    const chunk = ids.slice(i, i + LAST_SEEN_FLUSH_CHUNK);
    try {
      await touch_users_last_seen(chunk);
    } catch (error) {
      // Best effort: the next open/close of these users writes it again.
      console.error(
        `[WS] last_seen flush failed for ${chunk.length} users:`,
        error,
      );
    }
  }
}

let last_seen_flush_running = false;
function startLastSeenFlush() {
  if (lastSeenInterval) clearInterval(lastSeenInterval);
  lastSeenInterval = setInterval(() => {
    // Never overlap: a slow DB must not stack flushes.
    if (last_seen_flush_running) return;
    last_seen_flush_running = true;
    flush_last_seen_on_open().finally(() => {
      last_seen_flush_running = false;
    });
  }, LAST_SEEN_FLUSH_INTERVAL_MS);
}

function stopLastSeenFlush() {
  if (lastSeenInterval) {
    clearInterval(lastSeenInterval);
    lastSeenInterval = null;
  }
}

// =============================================================================
// Timers (started by server.ts boot(), stopped by the drain)
// =============================================================================
// These used to start at import time, before the DB/Redis were known to be
// up and in every process that merely imported this module; and each module
// installed its own SIGTERM/SIGINT handlers. boot() now starts them once the
// dependencies are ready and the boot guard passed; cluster/lifecycle.ts owns
// the signals.
function start_socket_timers() {
  // Keepalive tick (server pings, stale eviction, congestion close)
  startHeartbeat();
  // Periodic connection stats + per-window counters
  startStatsLogging();
  // Batched last_seen writer for newly-opened sockets
  startLastSeenFlush();
  // Daily cleanup of expired missed messages (>30 days old)
  start_cleanup_cron();
}

// Drain: stop every timer. Waits for a last_seen flush already running and
// then writes the remaining batch once, so users whose socket opened in the
// last 30 s keep a last_seen ≥ their connect time.
async function stop_socket_timers() {
  stopHeartbeat();
  stopStatsLogging();
  stopLastSeenFlush();
  stop_cleanup_cron();
  while (last_seen_flush_running) await Bun.sleep(25);
}

async function final_last_seen_flush() {
  if (last_seen_flush_running) return;
  last_seen_flush_running = true;
  try {
    await flush_last_seen_on_open();
  } finally {
    last_seen_flush_running = false;
  }
}

// =============================================================================
// Drain (SYNC_V2 §13.9.3)
// =============================================================================
// The client close-code contract: 1012 + socket:restart{retry_in_ms} means
// "the server is restarting, reconnect after retry_in_ms; your state is
// intact". New apps (App H) honour retry_in_ms and skip recovery work.
// Old apps (what users run today) parse socket:restart as an unknown frame
// (WSMessage.fromJson throws inside a try/catch → ignored) and treat 1012
// like any non-4003 close: reconnect at once (0–300 ms jitter, then 1→2→4→…
// 15 s backoff), falling back to long-polling after 3 failed WS attempts.
// The batched close spreads that reconnect herd over the drain window.
const RESTART_RETRY_MIN_MS = 500;
const RESTART_RETRY_MAX_MS = 4000;

function send_restart_and_close(ws: ElysiaWS, conn?: UserConnection, user_id?: string) {
  set_ws_data(ws, { draining: true });
  ws_send(
    ws,
    {
      type: "socket:restart",
      retry_in_ms:
        RESTART_RETRY_MIN_MS +
        Math.floor(Math.random() * (RESTART_RETRY_MAX_MS - RESTART_RETRY_MIN_MS + 1)),
      ws_timestamp: new Date().toISOString(),
    },
    conn,
    user_id,
  );
  try {
    ws.close(1012, "restart");
  } catch (e) { }
}

// Close up to `max` registered sockets (oldest first in Map order) with the
// restart contract. Returns how many were closed. The close callback removes
// each from socket_connections (compare-and-delete) without an offline
// broadcast or last_seen write (ws.data.draining).
function close_sockets_for_restart(max: number): number {
  let closed = 0;
  for (const [user_id, conn] of socket_connections) {
    if (closed >= max) break;
    if (get_ws_data(conn.ws, "draining") === true) continue;
    send_restart_and_close(conn.ws, conn, user_id);
    closed++;
  }
  return closed;
}

// Registered sockets the drain has not closed yet.
function open_socket_count(): number {
  let n = 0;
  for (const conn of socket_connections.values()) {
    if (get_ws_data(conn.ws, "draining") !== true) n++;
  }
  return n;
}

export default web_socket_server;
export {
  socket_connections,
  polling_connections,
  startHeartbeat,
  stopHeartbeat,
  handlePongResponse,
  start_socket_timers,
  stop_socket_timers,
  final_last_seen_flush,
  close_sockets_for_restart,
  open_socket_count,
};
