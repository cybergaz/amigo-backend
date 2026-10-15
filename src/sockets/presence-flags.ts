import type { ConnectionStatusType } from "@/types/socket.types";

// =============================================================================
// Background flag on connect / poll (SYNC_V2 R0.1, field bug F2-5)
// =============================================================================
// Client contract: while the app lifecycle is not 'resumed', the app adds
// `bg=1` to the WS URL and to every poll request. In the foreground it sends
// `bg=0` on every poll request (not on the WS URL: a fresh socket already
// starts foreground). It still sends the connection:status frames it always
// did.
//
// Why: the client announced background only on the pause TRANSITION. A
// socket opened or a lease created during a background wake (an FCM push
// woke the frozen process) therefore started as foreground — and a
// foreground recipient gets no FCM, only a ws.send / pending entry that the
// phone, whose network Android cuts ~5-10 s later, may never read.
//
// Pure helpers + one small in-process hint map; no socket / redis imports, so
// tests/poll-ack-drain.test.ts can cover them.

// Accepts the contract's "1" plus the obvious spellings, so a client that
// sends bg=true is not silently treated as foreground.
const is_bg_flag = (v: unknown): boolean =>
  v === true || v === 1 || v === "1" || v === "true";

// Explicit foreground (`bg=0`). Only new clients send it, so absence still
// means "unknown" (old 4.2.2 builds), never "foreground". Why it exists: the
// resume 'online' frame is sent while the carrier is still closed for the
// background and is dropped, so without it a lease that went 'background'
// stayed so for the whole foreground session (FCM + a delivered POST for
// every message, doubling traffic on cheap Wi-Fi).
const is_fg_flag = (v: unknown): boolean =>
  v === false || v === 0 || v === "0" || v === "false";

// Last status a user ANNOUNCED (connection:status frame or bg=1), kept past
// the lease / socket it was set on. Only used to start a NEW polling lease
// that arrived without bg=1: old app builds (4.2.2) never send bg, so a lease
// re-created during their background wake would otherwise start 'online'
// and get no FCM. Bounded: one small entry per user, dropped after a week.
const HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HINT_MAX = 50_000;
const status_hints = new Map<string, { status: ConnectionStatusType; at: number }>();

const note_announced_status = (
  user_id: string,
  status: ConnectionStatusType,
  now: number = Date.now(),
): void => {
  // Re-insert so Map order is oldest-first for the size trim below.
  status_hints.delete(user_id);
  status_hints.set(user_id, { status, at: now });
  if (status_hints.size > HINT_MAX) {
    const oldest = status_hints.keys().next().value;
    if (oldest !== undefined) status_hints.delete(oldest);
  }
};

const hinted_background = (user_id: string, now: number = Date.now()): boolean => {
  const h = status_hints.get(user_id);
  if (!h) return false;
  if (now - h.at > HINT_TTL_MS) {
    status_hints.delete(user_id);
    return false;
  }
  return h.status === "background";
};

const clear_status_hints = (): void => status_hints.clear(); // tests

// Status of a polling lease after this poll / send.
//   bg=1                → 'background' (the client says so, every request);
//   bg=0                → 'online' (a new client in the foreground);
//   no bg, lease exists → unchanged: old clients set background with a frame
//                         on pause and send no bg, so resetting it here would
//                         undo their announcement on the next poll;
//   no bg, new lease    → 'background' if the last announcement was
//                         background, else 'online'. Worst case (an old
//                         client whose resume 'online' frame was lost while
//                         offline) a foreground poller also gets FCM, which
//                         prod gave every poller before R0 anyway; the
//                         client dedupes WS / poll / FCM by message id.
const next_lease_status = (
  existing: ConnectionStatusType | undefined,
  bg: boolean,
  hinted_bg: boolean,
  fg: boolean = false,
): ConnectionStatusType => {
  if (bg) return "background";
  if (fg) return "online";
  if (existing) return existing;
  return hinted_bg ? "background" : "online";
};

export {
  is_bg_flag,
  is_fg_flag,
  note_announced_status,
  hinted_background,
  clear_status_hints,
  next_lease_status,
};
