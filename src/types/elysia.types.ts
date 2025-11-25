import { Cookie } from "elysia";
import { RoleType } from "./user.types";
import { WebSocketData } from "./socket.types";

interface ElysiaMiddlewareType {
  cookie: Record<string, Cookie<string | undefined | unknown>>;
  headers: Record<string, string | undefined>;
  allowed?: RoleType[];
}

// Extended WebSocket type with proper typing
interface TypedElysiaWS {
  data: WebSocketData;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
}

export { ElysiaMiddlewareType, TypedElysiaWS };

