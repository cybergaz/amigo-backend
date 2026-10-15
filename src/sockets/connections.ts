import type { PollingConnection, UserConnection, WebSocketData } from "@/types/socket.types";

// =============================================================================
// This worker's live connections (SYNC_V2 §13.7 A1/A4)
// =============================================================================
// The two maps used to live in socket.server.ts; they moved here so the
// router (src/cluster/router.ts) can read them without importing the socket
// server (socket.server → socket.handlers → router would be a cycle).
// socket.server.ts re-exports them, so existing imports keep working.
//
// At N>1 they hold only THIS worker's users; who is connected anywhere is the
// presence registry (src/cluster/presence.ts). The polling map stays for the
// local fast path, the `local` routing mode and stats.

const socket_connections = new Map<string, UserConnection>(); // user_id -> WebSocket
const polling_connections = new Map<string, PollingConnection>(); // user_id -> v1 lease

// cids of sockets between "user_id set" and "presence claimed" (§13.6.5
// steps 3–5). The router must not release a ws key naming one of them as
// stale: it is a socket that is about to be registered, not a leftover.
const opening = new Set<string>();

// Does THIS worker hold an open socket for the user? Synchronous, no Redis.
const is_local_online = (user_id: string): boolean => {
  const conn = socket_connections.get(user_id);
  return !!conn && conn.ws.readyState === 1;
};

export { socket_connections, polling_connections, opening, is_local_online };

// Close a socket that a newer socket of the same user replaced (§13.6.5 step
// 4, inbox evict, heartbeat ghost). `replaced` tells the close callback that
// the user is NOT leaving: no offline broadcast, no last_seen, no presence
// release (the key already names the new socket). 4009 + "replaced:<new cid>"
// is the App H contract: a client ignores it on a socket that is no longer
// its current one and reconnects after 2–5 s if it is; old builds treat it as
// any non-4003 close and reconnect at once.
const close_replaced = (
  user_id: string,
  conn: UserConnection,
  new_cid: string | undefined,
): void => {
  (conn.ws.data as WebSocketData).replaced = true;
  if (socket_connections.get(user_id) === conn) socket_connections.delete(user_id);
  try {
    conn.ws.close(4009, `replaced:${new_cid ?? "?"}`);
  } catch { }
};

export { close_replaced };
