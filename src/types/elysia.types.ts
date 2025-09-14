import { Cookie } from "elysia";
import { RoleType } from "./user.types";

interface ElysiaMiddlewareType {
  cookie: Record<string, Cookie<string | undefined | unknown>>;
  headers: Record<string, string | undefined>;
  allowed?: RoleType[];
}

export { ElysiaMiddlewareType };

