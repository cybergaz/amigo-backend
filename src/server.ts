import { Elysia } from "elysia";
import "dotenv/config";
import cors from "@elysiajs/cors";
import "@/config/db";
import auth_routes from "./routes/auth.routes";
import user_routes from "./routes/user.routes";

const SERVER_PORT = process.env.SERVER_PORT;
if (!SERVER_PORT) {
  throw new Error("SERVER_PORT environment variable is not set");
}
const app = new Elysia({ prefix: "/api" })
  .use(cors({ origin: "*", credentials: true, }))
  .use(auth_routes)
  .use(user_routes)
  .listen(SERVER_PORT);

console.log(
  `Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
