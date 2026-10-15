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
  WebSocketData,
  WSMessage,
} from "@/types/socket.types";
import { sync_v2_flags } from "@/services/app-settings.service";
import { v2_on } from "@/services/sync/flags-core";
import { SERIAL_VITAL_TYPES, chain_vital } from "./vital-chain";
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
import { is_bg_flag, note_announced_status } from "./presence-flags";
import { note_ws_connect_proto } from "@/services/sync/proto-lease";
import { ws_ready_proto } from "@/services/sync/read-core";
import {
  close_replaced,
  opening,
  polling_connections,
  socket_connections,
} from "./connections";
import { WORKER_ID } from "@/cluster/identity";
import { presence_authoritative, presence_writes } from "@/cluster/mode";
import * as presence from "@/cluster/presence";
import {
  PRESENCE_REFRESH_MS,
  REFRESH_BG_REPAIR,
  REFRESH_GHOST,
  REFRESH_SELFHEAL,
} from "@/cluster/presence-core";
import type { ClaimResult } from "@/cluster/presence-store";
import { lease_seen_ms } from "@/cluster/router-core";
import { register_reap_offline_notifier } from "@/cluster/reaper";
import {
  is_present,
  may_close_replaced,
  online_peers,
  send_evict,
} from "@/cluster/router";

// The connection maps live in ./connections (the router reads them too);
// re-exported below so existing imports of socket.server keep working.

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
// socket:ready `proto`: 1 = legacy (pending-queue replay); 2 for a client
// that connected with ?proto=2 while the Sync v2 gate is open for it
// (read-core ws_ready_proto). Every other connect gets 1, as before.
// last_seen for newly-opened sockets is written in batches (see
// flush_last_seen_on_open) instead of inline in `open`.
const LAST_SEEN_FLUSH_INTERVAL_MS = 30_000;
const LAST_SEEN_FLUSH_CHUNK = 1000;

// §13.6.5 step 4: a newer socket of the same user closes the previous one
// with 4009 (fixes the orphaned-handshake race: a handshake the app already
// gave up on completing late used to take over the user's map entry, and
// the live socket stopped receiving anything until the heartbeat noticed).
// Kill switch WS_CLOSE_REPLACED=0 restores "leave the old socket open".
// Damped per user (router-core ReplaceDamper) so two clients of one account
// cannot knock each other off in a loop.
const CLOSE_REPLACED = (process.env.WS_CLOSE_REPLACED ?? "1").trim() !== "0";

// §13.6.5 step 9: open admission. More than this many opens between JWT
// verify and registration on this worker → close 1013 (new apps back off
// 5–15 s, old apps retry with their normal backoff). Spreads a reconnect
// herd instead of letting it queue on Redis/RDS. 0 = off. Default on only
// with CLUSTER_ROUTING=on (each open then also awaits a presence claim), so
// `local` keeps today's behaviour.
const OPEN_MAX_INFLIGHT = Math.max(
  0,
  parseInt(process.env.WS_OPEN_MAX_INFLIGHT ?? (presence_authoritative() ? "64" : "0")) || 0,
);
let opens_in_flight = 0;

// `on` mode only: v1 poll leases nobody polled for this long are dropped
// from the local map. In local mode a stale lease is evicted by the next
// fan-out that classifies it (classify_local); with the registry routing,
// that path rarely runs, so without this the map would keep one entry per
// user that ever polled this worker.
const STALE_LEASE_MAX_AGE_MS = 10 * 60_000;
const STALE_LEASE_PRUNE_EVERY_TICKS = 12; // ≈ 60 s

// Presence refresh cadence in keepalive ticks (15 s / 5 s = every 3rd tick).
const PRESENCE_REFRESH_EVERY_TICKS = Math.max(1, Math.round(PRESENCE_REFRESH_MS / KEEPALIVE_TICK_MS));

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
    // `proto` (Sync v2 capability, §4.3/§3.13): with
    // app_settings.sync_v2_proto_lease on, ?proto=2 sets the proto:{uid}
    // lease and a connect without it clears it (sync/proto-lease.ts). Off
    // (default): ignored, exactly as before.
    // `bg` = "1" while the app is not resumed (SYNC_V2 R0.1, presence-flags.ts).
    // Undeclared params are stripped, never rejected, so old clients are fine.
    query: t.Object({
      token: t.String(),
      proto: t.Optional(t.String()),
      bg: t.Optional(t.String()),
    }),

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
      let admitted = false;
      let opening_cid: string | undefined;
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

        // §13.6.5 step 9 (checked here, at step 1): too many opens in flight.
        if (OPEN_MAX_INFLIGHT > 0 && opens_in_flight >= OPEN_MAX_INFLIGHT) {
          count("CLUSTER", "open_admission_1013");
          ws.close(1013, "Try again later");
          return;
        }
        opens_in_flight++;
        admitted = true;

        // §13.6.5 step 1: from here until step 6 the socket exists but is NOT
        // registered — any frame the client sends meanwhile is buffered by the
        // `message` callback, never processed. `user_id` stays unset until the
        // device check below passes, so nothing can act as this user early.
        const cid = new_cid();
        set_ws_data(ws, { cid, registered: false });

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

        // §13.6.5 step 3. From here until the presence claim landed the
        // router must not treat a ws key naming this cid as a leftover.
        opening.add(cid);
        opening_cid = cid;
        // Store user_id in WebSocket data using type-safe helper.
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
        // fields. A fresh connection starts foreground (is_background:false,
        // 20 s keepalive), so a reconnect clears any prior background flag /
        // announced mode — UNLESS the URL carries bg=1 (SYNC_V2 R0.1): a
        // socket opened during a background wake (FCM woke the frozen app)
        // used to start foreground and got no FCM; Android cut its network
        // ~5-10 s later, so messages sent into that ghost socket waited in
        // the pending queue until some later wake.
        // Old clients never send bg → unchanged. Keepalive stays fg until the
        // client announces a mode, as before.
        // The status hint follows the socket either way: a foreground open
        // must clear an earlier 'background', or the long-poll lease this
        // client falls back to on a flaky link starts 'background' and an
        // old (4.2.2) app shows a notification for every message in the
        // chat the user is reading.
        const opened_bg = is_bg_flag(url.searchParams.get("bg"));
        note_announced_status(user_id, opened_bg ? "background" : "online");
        const now_ms = Date.now();
        const connection: UserConnection = {
          ws,
          cid,
          missed_pings: 0,
          is_background: opened_bg,
          last_inbound_at: now_ms,
          last_keepalive_at: now_ms,
          keepalive_ms: KEEPALIVE_FG_MS,
          keepalive_mode: "fg",
          // connection_status: "online",
          // transport_type: "ws",
          // connected_at: new Date(),
          // client_ip
        };
        const previous = socket_connections.get(user_id);
        // Whether peers were ever told about that previous socket (it got
        // past registration) — decides the online edge below.
        const previous_announced_cid =
          previous && get_ws_data(previous.ws, "registered") === true ? previous.cid : undefined;
        socket_connections.set(user_id, connection);
        // A different socket of this user was registered here: it is either
        // a half-open leftover or an orphaned handshake. Close it with 4009
        // (no offline broadcast — the user is right here).
        if (previous && previous.ws.raw !== ws.raw) {
          count("CLUSTER", "replaced_local");
          if (CLOSE_REPLACED && may_close_replaced(user_id)) {
            close_replaced(user_id, previous, cid);
          }
        }

        // removing from polling connections if exists (in case user switched transport without closing previous connection properly)
        if (polling_connections.has(user_id)) {
          polling_connections.delete(user_id);
          console.log(
            `[WS] User ${user_id} switched from polling to WebSocket, removed from polling connections`,
          );
        }

        // §13.6.5 step 5: claim the presence key (also ends a poll lease).
        // `on`: awaited — the result decides the online edge and whether a
        // socket on another worker must be evicted. `shadow`: written, not
        // awaited (no decision depends on it). `local`: nothing.
        let claim_result: ClaimResult | null = null; // null = not claimed / failed
        if (presence_authoritative()) {
          try {
            claim_result = await presence.claim(user_id, cid, opened_bg);
          } catch (err: any) {
            count("CLUSTER", "presence_claim_failed");
            connection.presence_unclaimed = true;
          }
          if (claim_result?.old_ws && claim_result.old_ws.wid !== WORKER_ID) {
            send_evict(user_id, claim_result.old_ws, cid);
          }
          // Closed (or replaced) while the claim was in flight: the close
          // callback already removed the entry; do not register.
          if (get_ws_data(ws, "closed") === true) return;
        } else {
          presence.claim_soon(user_id, cid, opened_bg);
        }
        opening.delete(cid);
        opening_cid = undefined;

        // last_seen ≥ connect time, written off the open path in one batched
        // UPDATE (flush_last_seen_on_open).
        pending_last_seen_on_open.add(user_id);

        // Sync v2 capability lease (§3.13). No-op (no Redis call) while
        // sync_v2_proto_lease is off; fire-and-forget when on.
        const query_proto = url.searchParams.get("proto");
        note_ws_connect_proto(user_id, query_proto);

        // §13.6.5 step 6: registered → process the frames that arrived early
        // (in arrival order), then tell the client the socket is fully live.
        // Old apps ignore socket:ready (unknown type → dropped by their parser).
        set_ws_data(ws, { registered: true });
        opens_in_flight--;
        admitted = false;
        count("WS", "opens");
        observe_ms("WS", "open_ms", Date.now() - opened_at);
        drain_early_frames(ws);
        ws_send(
          ws,
          {
            type: "socket:ready",
            // The flags snapshot is in memory: no extra round trip.
            proto: ws_ready_proto(user_id, query_proto, sync_v2_flags()),
            server_time: new Date().toISOString(),
            cid: get_ws_data(ws, "cid"),
          },
          connection,
          user_id,
        );

        // notify all connected users about this user being online
        const connected_users = await get_user_peers(user_id);

        // §13.6.5 step 7 (`on` only): announce "online" on the EDGE — when
        // the claim found no previous socket of this user. A user whose old
        // socket was still registered (half-open, replaced, on another
        // worker) was never announced offline, so peers already show them
        // online. Exceptions that still announce:
        //   - a previous POLL lease (deliberate deviation from §13.6.5): a
        //     poll-only session may never have been announced, and a
        //     redundant "online" costs one frame per peer while a missing one
        //     leaves the user shown offline;
        //   - an old key naming THIS worker but not a socket that got past
        //     registration here (an orphan that never announced, or a
        //     leftover whose release was lost);
        //   - a failed claim (today's behaviour).
        const old_ws = presence_authoritative() ? claim_result?.old_ws : null;
        const announce_online =
          !old_ws ||
          (old_ws.wid === WORKER_ID && old_ws.cid !== previous_announced_cid);
        if (!announce_online) count("CLUSTER", "online_edge_suppressed");

        // Same value handle_connection_status would broadcast for the
        // background frame (peers render both as "online").
        const message_payload: ConnectionStatusPayload = {
          sender_id: user_id,
          status: opened_bg ? "background" : "online",
        };

        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        if (announce_online) {
          await broadcast_message({
            to: "users",
            user_ids: Array.from(connected_users),
            message: {
              type: "connection:status",
              payload: message_payload,
              ws_timestamp: new Date(),
            },
          });
        }

        // Presence snapshot: send current online status of B's peers back to B
        // so B's UI reflects who's already online. Without this, B only ever
        // learns about peers when they toggle state (connect/disconnect) —
        // peers already online before B connected would appear offline forever.
        // `on` (§13.6.5 step 8, A5): peers with a socket on ANY worker or a
        // fresh poll lease. Otherwise: this worker's sockets, as before.
        const snapshot_at = new Date();
        const snapshot_peers = presence_authoritative()
          ? await online_peers(Array.from(connected_users))
          : Array.from(connected_users).filter((peer_id) => {
            const peer_conn = socket_connections.get(peer_id);
            return !!peer_conn && peer_conn.ws.readyState === 1;
          });
        for (const peer_id of snapshot_peers) {
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

        // logConnectionSuccess('ws', user_id, client_ip, { user_name });

        // =============================================================================
        // Message Sync on Reconnection
        // =============================================================================
        // Sync missed messages to the user (this also marks them as delivered)
        // This is critical for users who temporarily lost connection
        // await sync_missed_messages(user_id);
      } catch (error) {
        set_ws_data(ws, { early_frames: undefined });
        // A socket that already took the map entry must not stay in it.
        const failed_uid = get_ws_data(ws, "user_id") as string | undefined;
        if (failed_uid && socket_connections.get(failed_uid)?.ws.raw === ws.raw) {
          socket_connections.delete(failed_uid);
          presence.release_soon(failed_uid, get_ws_data(ws, "cid") as string | undefined);
        }
        const request = ws.data.request;
        const client_ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip") ||
          "unknown";
        logConnectionError("ws_open", undefined, client_ip, error);
        ws.close(4000, "Connection error");
      } finally {
        if (admitted) opens_in_flight--;
        if (opening_cid) opening.delete(opening_cid);
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

      // Replaced by a newer socket of this user (4009, §13.6.5): the user is
      // not leaving. The map entry and the presence key already belong to
      // the new socket — no offline, no last_seen, no release.
      if (get_ws_data(ws, "replaced") === true) return;

      // Never registered (auth rejected, closed mid-open, connectivity check):
      // never announced online, so no offline/last_seen to write. A socket
      // closed while its presence claim was in flight is already in the map
      // (step 4 precedes the claim), so take it out again.
      if (get_ws_data(ws, "registered") !== true) {
        const mid_open_uid = get_ws_data(ws, "user_id") as string | undefined;
        if (mid_open_uid && socket_connections.get(mid_open_uid)?.ws.raw === ws.raw) {
          socket_connections.delete(mid_open_uid);
          presence.release_soon(mid_open_uid, get_ws_data(ws, "cid") as string | undefined);
        }
        return;
      }

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
        // Compare-delete this socket's presence key (no-op in local mode; a
        // newer socket's key — any worker — is never touched).
        presence.release_soon(user_id, get_ws_data(ws, "cid") as string | undefined);

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
          // A6 (`on`): reconnected to ANOTHER worker, or polling — present
          // anywhere means not offline. Unknown (Redis down) → as before.
          if (presence_authoritative() && (await is_present(user_id)) === true) {
            count("CLUSTER", "debounce_skip_present");
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

  const handle = () => socket_message_handler(
    {
      user_id,
      user_name: get_ws_data(ws, "user_name") as string,
      // user_pfp: get_ws_data(ws, "user_pfp") as string,
    },
    message,
  );

  // SYNC_V2 §3.3.5 (sync_v2 'on'): a socket's vital frames commit and ack in
  // arrival order; their fan-outs run detached (sockets/vital-chain.ts).
  // Off / shadow: every frame runs concurrently, as before.
  if (v2_on(sync_v2_flags()) && SERIAL_VITAL_TYPES.has(message.type)) {
    await chain_vital(ws.data as WebSocketData, handle);
    return;
  }
  await handle();
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
  // A7: compare-delete this socket's key; offline below only if nothing
  // else of this user remains anywhere.
  presence.release_soon(user_id, connection.cid);

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
    if (presence_authoritative() && (await is_present(user_id)) === true) {
      count("CLUSTER", "evict_skip_present");
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

// RC-3 reaper (cluster/reaper.ts, §13.6.6): users of a DEAD worker whose
// presence is gone everywhere. Their own close debounce died with that
// worker, so this is the offline announcement + last_seen it would have
// made. Bounded concurrency: a dead worker can leave ~2.6k users at once.
const REAP_ANNOUNCE_CONCURRENCY = 16;
const REAP_LAST_SEEN_CHUNK = 500;
async function announce_reaped_offline(uids: string[]) {
  // Reconnected here since the reaper's lookup: not offline.
  const gone = uids.filter((uid) => !socket_connections.has(uid));
  for (let i = 0; i < gone.length; i += REAP_ANNOUNCE_CONCURRENCY) {
    await Promise.all(
      gone.slice(i, i + REAP_ANNOUNCE_CONCURRENCY).map(async (user_id) => {
        try {
          const peers = await get_user_peers(user_id);
          const message_payload: ConnectionStatusPayload = { sender_id: user_id, status: "offline" };
          await broadcast_message({
            to: "users",
            user_ids: Array.from(peers),
            message: { type: "connection:status", payload: message_payload, ws_timestamp: new Date() },
            exclude_user_ids: [user_id],
          });
        } catch (e) {
          console.error(`[CLUSTER] reaped offline announce failed for ${user_id}:`, e);
        }
      }),
    );
  }
  for (let i = 0; i < gone.length; i += REAP_LAST_SEEN_CHUNK) {
    try {
      await touch_users_last_seen(gone.slice(i, i + REAP_LAST_SEEN_CHUNK));
    } catch (e) {
      console.error(`[CLUSTER] reaped last_seen write failed:`, e);
    }
  }
}
register_reap_offline_notifier(announce_reaped_offline);

function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  let tick_no = 0;
  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    if (++tick_no % PRESENCE_REFRESH_EVERY_TICKS === 0) refresh_presence();
    if (tick_no % STALE_LEASE_PRUNE_EVERY_TICKS === 0) prune_stale_poll_leases(now);

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

// §13.7 A7: one pipelined PRESENCE_REFRESH per 15 s for every registered
// socket (TTL 45 s). The reply also repairs the registry: a key that vanished
// is re-created (self-heal), a lost bg flip is rewritten, and a key that now
// names another socket means this one was replaced elsewhere and its evict
// message was lost → close it with 4009 (`on` only; shadow just counts).
let presence_refresh_running = false;
async function refresh_presence() {
  if (!presence_writes() || presence_refresh_running) return;
  const entries: { uid: string; cid: string; bg: boolean; }[] = [];
  const conns: UserConnection[] = [];
  const unclaimed: [string, UserConnection][] = [];
  for (const [uid, conn] of socket_connections) {
    if (!conn.cid || conn.ws.readyState !== 1) continue;
    if (get_ws_data(conn.ws, "draining") === true) continue;
    if (conn.presence_unclaimed) {
      unclaimed.push([uid, conn]);
      continue;
    }
    entries.push({ uid, cid: conn.cid, bg: conn.is_background === true });
    conns.push(conn);
  }
  if (entries.length === 0 && unclaimed.length === 0) return;
  presence_refresh_running = true;
  try {
    // Sockets whose open-time claim failed: claim now (newest socket wins,
    // exactly as the open would have), rather than REFRESH, which would see
    // the user's previous socket in the key and call THIS one the ghost.
    // Rare (a Redis blip during opens), so one awaited claim each is fine.
    for (const [uid, conn] of unclaimed) {
      if (socket_connections.get(uid) !== conn) continue;
      try {
        const r = await presence.claim(uid, conn.cid!, conn.is_background === true);
        conn.presence_unclaimed = false;
        count("CLUSTER", "presence_reclaimed");
        if (r.old_ws && r.old_ws.wid !== WORKER_ID && r.old_ws.cid !== conn.cid) send_evict(uid, r.old_ws, conn.cid!);
      } catch {
        count("CLUSTER", "presence_claim_failed");
      }
    }
    if (entries.length === 0) return;
    const replies = await presence.refresh_many(entries);
    replies.forEach((reply, i) => {
      if (reply === REFRESH_SELFHEAL) count("CLUSTER", "presence_selfheal");
      else if (reply === REFRESH_BG_REPAIR) count("CLUSTER", "presence_bg_repair");
      else if (reply === REFRESH_GHOST) {
        count("CLUSTER", "presence_ghost");
        const { uid } = entries[i];
        const conn = conns[i];
        if (
          presence_authoritative() &&
          CLOSE_REPLACED &&
          socket_connections.get(uid) === conn &&
          may_close_replaced(uid)
        ) {
          count("CLUSTER", "evicted_ghosts_refresh");
          close_replaced(uid, conn, undefined);
        }
      } else if (reply < 0) count("CLUSTER", "presence_refresh_item_failed");
    });
  } catch (err: any) {
    count("CLUSTER", "presence_refresh_failed");
  } finally {
    presence_refresh_running = false;
  }
}

function prune_stale_poll_leases(now: number) {
  if (!presence_authoritative()) return;
  for (const [uid, lease] of polling_connections) {
    const seen = lease_seen_ms(lease);
    if (seen === undefined || now - seen > STALE_LEASE_MAX_AGE_MS) {
      polling_connections.delete(uid);
    }
  }
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
// Fresh v1 poll leases on this worker (beat / stats). The map also keeps
// stale entries until a fan-out or a new poll touches them.
function fresh_poll_lease_count(now = Date.now()): number {
  let n = 0;
  for (const lease of polling_connections.values()) {
    const seen = lease_seen_ms(lease);
    if (seen !== undefined && now - seen < 10_000) n++;
  }
  return n;
}

export {
  socket_connections,
  polling_connections,
  fresh_poll_lease_count,
  startHeartbeat,
  stopHeartbeat,
  handlePongResponse,
  start_socket_timers,
  stop_socket_timers,
  final_last_seen_flush,
  close_sockets_for_restart,
  open_socket_count,
};
