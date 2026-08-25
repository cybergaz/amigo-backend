import { Elysia } from "elysia";
import "dotenv/config";
import cors from "@elysiajs/cors";
import "@/config/db";
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
import web_socket_server from "./sockets/socket.server";
import { chat_dm_routes } from "./routes/chat-dm.routes";
import { chat_group_routes } from "./routes/chat-group.routes";
import { chat_poll_routes } from "./routes/chat-poll.routes";
import { message_routes } from "./routes/message.routes";
import { start_receipts_flush } from "./cache-management/receipt-flush";
import { start_message_status_flush } from "./cache-management/message-status-flush";
import { start_disappearing_sweeper } from "./cache-management/disappearing-sweeper";
import { LivekitService } from "./services/livekit.service";
const SERVER_PORT = parseInt(process.env.SERVER_PORT || "5000");

if (!SERVER_PORT || isNaN(SERVER_PORT)) {
  throw new Error("SERVER_PORT environment variable is not set or invalid");
}
const app = new Elysia({ prefix: "/api" })

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
  .use(app_version_routes)
  .use(web_socket_server)
  .listen({ port: SERVER_PORT, reusePort: true });

console.log(`🦊 Elysia is running at port ${app.server?.url} (PID: ${process.pid})`);

LivekitService.get_all_active_calls();

const receipts_flush_stop = start_receipts_flush();
const message_status_flush_stop = start_message_status_flush();
const disappearing_sweeper_stop = start_disappearing_sweeper();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  receipts_flush_stop();
  message_status_flush_stop();
  disappearing_sweeper_stop();
  await app.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  receipts_flush_stop();
  message_status_flush_stop();
  disappearing_sweeper_stop();
  process.exit(0);
});
