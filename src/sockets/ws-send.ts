import { ElysiaWS } from "elysia/dist/ws";
import type { UserConnection } from "@/types/socket.types";
import { count } from "@/utils/counters";

// =============================================================================
// ws.send with backpressure accounting (SYNC_V2 §14.5 item 4)
// =============================================================================
// Bun's ServerWebSocket.send returns:
//   > 0  bytes written to the kernel — fine;
//   -1   enqueued, but the socket is under backpressure (the peer / NAT / slow
//        Wi-Fi is not draining) — the frame WILL go out once the buffer drains;
//    0   dropped: the socket is closed, or the buffered amount is already past
//        `backpressureLimit` (we run closeOnBackpressureLimit:false, so Bun
//        drops instead of closing).
// Dropped vital frames are not lost: broadcast_message stores them in the
// pending queue for every recipient, and the client drains that on reconnect.
// What we must not do is keep a socket that has been congested for a long
// time — every frame to it is either queued behind a stalled pipe or dropped,
// while the app believes it is connected. The keepalive tick closes such a
// socket with 4008 (CONGESTED_CLOSE_MS) so the app falls back / reconnects.
// A socket that DROPPED a frame is closed on the next tick even if it drains
// first: the replay that recovers the frame only runs on reconnect, so a
// socket that recovered on its own would hide the gap for hours.
//
// Never throws: a send failure on one socket must not break a fan-out loop.

const WS_SEND_BACKPRESSURE = -1;
const WS_SEND_DROPPED = 0;

const ws_send = (
  ws: ElysiaWS,
  data: string | object,
  conn?: UserConnection,
  user_id?: string,
): number => {
  let result: number;
  try {
    // compress=true matches every existing send (perMessageDeflate is on).
    result = ws.send(data as any, true) as unknown as number;
  } catch (error) {
    count("WS", "send_error");
    console.error(`[WS] send error for user ${user_id ?? "?"}:`, error);
    return WS_SEND_DROPPED;
  }

  if (result === WS_SEND_BACKPRESSURE || result === WS_SEND_DROPPED) {
    if (result === WS_SEND_BACKPRESSURE) count("WS", "backpressure");
    else count("WS", "dropped");
    // Only an OPEN socket can be congested; a 0 from a closing socket is just
    // a late send and the close path cleans it up.
    if (
      conn &&
      result === WS_SEND_DROPPED &&
      ws.raw.readyState === 1 &&
      conn.dropped_at === undefined
    ) {
      conn.dropped_at = Date.now();
    }
    if (conn && ws.raw.readyState === 1 && conn.congested_since === undefined) {
      conn.congested_since = Date.now();
      // Logged on the edge only (not per frame) so a stalled big-group
      // recipient cannot flood the log.
      console.warn(
        `[WS] ${result === WS_SEND_BACKPRESSURE ? "backpressure" : "dropped"} user=${user_id ?? "?"} buffered=${safe_buffered(ws)}`,
      );
    }
  }
  return result;
};

const safe_buffered = (ws: ElysiaWS): number | string => {
  try {
    return (ws.raw as any).getBufferedAmount?.() ?? "?";
  } catch {
    return "?";
  }
};

export { ws_send, WS_SEND_BACKPRESSURE, WS_SEND_DROPPED };
