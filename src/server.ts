import { Elysia } from "elysia";
import "dotenv/config";
import cors from "@elysiajs/cors";
import type { Server } from "bun";
import { wait_for_db } from "@/config/db";
import { wait_for_redis } from "@/config/redis";
import auth_routes from "./routes/auth.routes";
import user_routes from "./routes/user.routes";
import chat_routes from "./routes/chat.routes";
import media_routes from "./routes/media.routes";
import community_routes from "./routes/community.routes";
// import call_routes from "./routes/call.routes.ts.bak";
import livekit_routes from "./routes/livekit.routes";
import admin_routes from "./routes/admin.routes";
import sub_admin_routes from "./routes/sub-admin.routes";
import app_version_routes from "./routes/app-version.routes";
import health_routes from "./routes/health.routes";
import web_socket_server, {
  polling_connections,
  socket_connections,
  start_socket_timers,
} from "./sockets/socket.server";
// Explicit: its Redis subscriber (global broadcasts, single-device force
// logout) must register on every worker. It used to load only as a side
// effect of admin.routes importing it (SYNC_V2 §13.7 "new").
import "./sockets/ws-broadcast";
import { chat_dm_routes } from "./routes/chat-dm.routes";
import { chat_group_routes } from "./routes/chat-group.routes";
import { chat_broadcast_routes } from "./routes/chat-broadcast.routes";
import { chat_poll_routes } from "./routes/chat-poll.routes";
import { message_routes } from "./routes/message.routes";
import { start_receipts_flush } from "./cache-management/receipt-flush";
import { start_message_status_flush } from "./cache-management/message-status-flush";
import { start_disappearing_sweeper } from "./cache-management/disappearing-sweeper";
import { start_ring_deadlines } from "./services/livekit.service";
import {
  CLUSTER_MAX,
  GIT_REV,
  REDIS_NS,
  SERVER_PORT,
  SOCKET_PORT,
  WORKER_ID,
} from "./cluster/identity";
import {
  drain_sleep,
  install_signal_handlers,
  is_draining,
  start_lag_sampler,
  state,
} from "./cluster/lifecycle";
import { wait_for_rfast } from "./cluster/redis-fast";
import { beat_now, run_boot_guard, start_beat } from "./cluster/beat";
import { register_drain_resources, run_drain } from "./cluster/drain";
import { admit_upload, release_upload } from "./utils/upload-gate";

if (!SERVER_PORT || isNaN(SERVER_PORT)) {
  throw new Error("SERVER_PORT environment variable is not set or invalid");
}
if (!SOCKET_PORT || isNaN(SOCKET_PORT)) {
  throw new Error("SOCKET_PORT environment variable is not set or invalid");
}

// HTTP keep-alive idle timeout (s). Above Elysia's 30 s default so an idle
// keep-alive from nginx is not cut mid-reuse; below Cloudflare's 100 s.
const HTTP_IDLE_TIMEOUT_S = 40;
const LISTEN_RETRY_MS = 2_000;

const app = new Elysia({ prefix: "/api" })
  // While draining, ask clients/nginx not to reuse this connection: the next
  // request should open a new one, which lands on the sibling.
  .onRequest(({ request, set }) => {
    if (is_draining()) set.headers["connection"] = "close";
    // Large-body semaphore (SYNC_V2 §13.10.3): decided on Content-Length
    // BEFORE the body is read, so a refused upload costs no memory.
    const busy = admit_upload(request);
    if (busy) return busy;
  })
  // Runs after every response — success, validation error, 404, thrown
  // error (verified for Elysia 1.4.4 in tests/upload-gate.test.ts) — and
  // frees the upload permit. A missed release is reclaimed by the gate.
  .onAfterResponse(({ request }) => {
    release_upload(request);
  })

  .onError(({ error, set, path }) => {
    const err = error as any;
    switch (err.code) {
      case "VALIDATION":
        console.error("[SERVER] Endpoint validation error at", path);
        set.status = 422;
        return {
          success: false,
          code: 422,
          message: `Endpoint validation error`,
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
  })

  .get("/", ({ set }) => {
    set.status = 200;
    return { success: true, code: 200, message: "Welcome to AmigoChats API" };
  })

  // GET /api/ping, /api/healthz, /api/readyz — unauthenticated
  // (SYNC_V2 §13.9.1, §14.6).
  .use(health_routes)

  .use(
    cors({
      origin: [
        process.env.FRONTEND_URL || "http://localhost:3000",
        "https://amigochats.com",
        "https://www.amigochats.com",
        "https://admin.amigochats.com",
      ],
      credentials: true,
    }),
  )

  .use(auth_routes)
  .use(user_routes)
  .use(chat_routes)
  .use(chat_dm_routes)
  .use(chat_group_routes)
  .use(chat_broadcast_routes)
  .use(chat_poll_routes)
  .use(message_routes)
  .use(community_routes)
  .use(media_routes)
  // .use(call_routes)
  // LiveKit calling: status/accept/decline/end (used by the native
  // Android call screen when Flutter isn't running) + the protected
  // join-token and active-call endpoints. Without this mount every one
  // of them 404s, which silently breaks answering from a killed app.
  .use(livekit_routes)
  .use(admin_routes)
  .use(sub_admin_routes)
  .use(app_version_routes);
// The WS app is NOT mounted here any more. `.use(web_socket_server)` also
// exposed the socket at :5000/api/chat, which nothing uses (the app connects
// to /chat/ → nginx → :5002); it only meant two listeners shared one route
// set. It listens on its own port below.

// Bind one listener, retrying while the port is taken — e.g. the previous
// process (old build with reusePort:true, or a drain that has not released
// it yet) still holds it. reusePort:false is the point: two processes on one
// port would silently split traffic (SYNC_V2 §13.1). Returns null if a drain
// started first.
const listen_with_retry = async (
  label: string,
  listen: () => Server | undefined | null,
): Promise<Server | null> => {
  for (let attempt = 1; !is_draining(); attempt++) {
    try {
      const server = listen();
      if (server) return server;
      throw new Error("listen returned no server");
    } catch (err: any) {
      console.error(
        `[BOOT] ${label} listen failed (attempt ${attempt}), retrying in ${LISTEN_RETRY_MS}ms: ${err?.code ?? ""} ${err?.message ?? err}`,
      );
      await drain_sleep(LISTEN_RETRY_MS);
    }
  }
  return null;
};

// SYNC_V2 §13.9.2. Nothing listens until the DB and Redis answer and the boot
// guard passed, so nginx never routes to a process that cannot serve; a
// dependency outage at boot is retried with backoff instead of exiting into a
// crash loop.
async function boot() {
  // First: a Ctrl-C / SIGTERM while waiting for dependencies must drain
  // (here: just close pools and exit), never hang or exit mid-write.
  install_signal_handlers(run_drain);
  start_lag_sampler();
  console.log(
    `[BOOT] wid=${WORKER_ID} rev=${GIT_REV} ns=${REDIS_NS} cluster_max=${CLUSTER_MAX} pid=${process.pid} ports=${SERVER_PORT}/${SOCKET_PORT}`,
  );

  // 1–2. Dependencies.
  if (!(await wait_for_db(is_draining))) return;
  if (!(await wait_for_redis(is_draining))) return;
  if (!(await wait_for_rfast(is_draining))) return;

  // 3. Beat (ready:false until we listen, so nobody counts us yet).
  start_beat(() => ({ ws: socket_connections.size, poll: polling_connections.size }));

  // 4. Boot guard (CLUSTER_MAX=1): wait while another READY worker of this
  //    deployment is live and no swap was authorised.
  await run_boot_guard();
  if (is_draining()) return;

  // Background work starts only after the guard: a refused stray must not
  // run flushers / sweepers next to the live worker. (The old "recover
  // active calls" call here was a no-op HGETALL on a literal "*" key; ring
  // recovery is now the deadline ZSET tick + DB backstop.)
  register_drain_resources({
    stop_workers: [
      start_receipts_flush(),
      start_message_status_flush(),
      start_disappearing_sweeper(),
      start_ring_deadlines(),
    ],
  });
  start_socket_timers();

  // 5. Listen.
  const http_server = await listen_with_retry("HTTP", () =>
    app.listen({ port: SERVER_PORT, reusePort: false, idleTimeout: HTTP_IDLE_TIMEOUT_S }).server,
  );
  if (!http_server) return;
  register_drain_resources({ http_server });
  state.http_listening = true;
  console.log(`🦊 Elysia is running at port ${http_server.url} (PID: ${process.pid})`);

  const ws_server = await listen_with_retry("WS", () =>
    web_socket_server.listen({ port: SOCKET_PORT, reusePort: false }).server,
  );
  if (!ws_server) return;
  register_drain_resources({ ws_server });
  state.ws_listening = true;
  console.log(`🔌 WebSocket server is running at port ${SOCKET_PORT}`);

  state.ready = true;
  beat_now();
  console.log(`[BOOT] ready wid=${WORKER_ID}`);
}

boot().catch((err) => {
  // Dependency failures are retried inside boot(); reaching here is a bug.
  // Exit so the supervisor (systemd Restart=always) or the operator sees it,
  // rather than idling forever not-ready.
  console.error("[BOOT] unexpected failure:", err);
  process.exit(1);
});
