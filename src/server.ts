import { Elysia } from "elysia";
import "dotenv/config";
import cors from "@elysiajs/cors";
import "@/config/db";
import auth_routes from "./routes/auth.routes";
import user_routes from "./routes/user.routes";
import chat_routes from "./routes/chat.routes";
import media_routes from "./routes/media.routes";
import community_routes from "./routes/community.routes";
import web_socket from "./sockets/web-socket";
import { hash_password, parse_phone } from "./utils/general.utils";
import admin_routes from "./routes/admin.routes";

const SERVER_PORT = process.env.SERVER_PORT;
if (!SERVER_PORT) {
  throw new Error("SERVER_PORT environment variable is not set");
}
const app = new Elysia({ prefix: "/api" })
  .get("/", () => "Elysia Server is running")
  .use(cors({
    origin: ["http://192.168.137.1", "http://172.24.137.187", "http://localhost:3001", "http://localhost:3000"],
    credentials: true,
  }))
  .use(auth_routes)
  .use(user_routes)
  .use(chat_routes)
  .use(media_routes)
  .use(community_routes)
  .use(admin_routes)
  .use(web_socket)
  .listen(SERVER_PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

// console.log(((await hash_password("Admin@123"))))
