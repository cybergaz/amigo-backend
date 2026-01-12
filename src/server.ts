import { Elysia } from "elysia";
import "dotenv/config";
import cors from "@elysiajs/cors";
import "@/config/db";
import auth_routes from "./routes/auth.routes";
import user_routes from "./routes/user.routes";
import chat_routes from "./routes/chat.routes";
import media_routes from "./routes/media.routes";
import community_routes from "./routes/community.routes";
import call_routes from "./routes/call.routes";
import admin_routes from "./routes/admin.routes";
import unprotected_call_routes from "./routes/unprotected-calls.routes";
import web_socket_server from "./sockets/socket.server";
import { parse_phone } from "./utils/general.utils";

const SERVER_PORT = parseInt(process.env.SERVER_PORT || "5000");
if (!SERVER_PORT || isNaN(SERVER_PORT)) {
  throw new Error("SERVER_PORT environment variable is not set or invalid");
}
const app = new Elysia({ prefix: "/api" })
  .onError(({ error, set, path }) => {
    const err = error as any
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
            }
          },
        };
    }
  })

  .get("/", () => "Elysia Server is running")
  .use(cors({
    origin: [process.env.FRONTEND_URL || "http://localhost:3000", "https://amigochats.com", "https://www.amigochats.com", "https://admin.amigochats.com"],
    credentials: true,
  }))
  .use(auth_routes)
  .use(user_routes)
  .use(chat_routes)
  .use(media_routes)
  .use(community_routes)
  .use(call_routes)
  .use(admin_routes)
  .use(unprotected_call_routes)
  // .use(web_socket)
  .use(web_socket_server)
  .listen(SERVER_PORT);

console.log(
  `🦊 Elysia is running at port ${app.server?.port} (PID: ${process.pid})`
);

// console.log(parse_phone("+60103649584"));

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// console.log(((await hash_password("Admin@123"))))
