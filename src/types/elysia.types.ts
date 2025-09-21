import { Cookie } from "elysia";
import { RoleType } from "./user.types";

interface ElysiaMiddlewareType {
  cookie: Record<string, Cookie<string | undefined | unknown>>;
  headers: Record<string, string | undefined>;
  allowed?: RoleType[];
}

// WebSocket data interface for type safety
interface WebSocketData {
  user_id?: number;
  request: Request;
  query: {
    token?: string;
  };
}

// Extended WebSocket type with proper typing
interface TypedElysiaWS {
  data: WebSocketData;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
}

export { ElysiaMiddlewareType, WebSocketData, TypedElysiaWS };

