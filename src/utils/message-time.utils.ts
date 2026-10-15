import type { MessageType } from "@/types/chat.types";

// Pure helpers for the server-side message timestamp rule. Kept free of any
// db / redis import so both send paths (store_message and the broadcast
// fan-out) share ONE implementation — and so it can be unit-tested without a
// database.

// Message types whose payload is a file the client uploads BEFORE emitting
// message:new (the app's MediaUploadManager). These are ordered by server
// arrival — see resolve_stored_sent_at.
const UPLOADED_MEDIA_TYPES: ReadonlySet<string> = new Set<MessageType>([
  "image",
  "video",
  "audio",
  "document",
  "media",
  "attachment",
]);

/**
 * The sent_at the server persists for an incoming message.
 *
 * Client clocks can be skewed (users with a fast device clock were producing
 * sent_at minutes in the future, shown verbatim to recipients). Server time is
 * the authority for the upper bound: never store a future or unparseable
 * sent_at. Past values are kept — offline-queued messages legitimately carry
 * an older client stamp.
 *
 * Uploaded media is the exception: it is stamped with the time the SERVER
 * received it, not the client's tap-send time. The client stamps sent_at
 * before the upload, so a slow upload landed at its old tap time — above every
 * message sent while it uploaded — and recipients never saw it arrive. Every
 * reader orders by sent_at (history, pagination, read cursors, last-message
 * pointer), so stamping it here makes all of them order media by arrival with
 * no query changes.
 */
const resolve_stored_sent_at = (
  msg_type: string,
  client_sent_at: unknown,
  now: Date = new Date(),
): Date => {
  const client = new Date(client_sent_at as string | number | Date);
  return UPLOADED_MEDIA_TYPES.has(msg_type) ||
    Number.isNaN(client.getTime()) ||
    client > now
    ? now
    : client;
};

/**
 * expires_at for a new message in a chat with disappearing messages on
 * (null duration = off → null).
 *
 * server_time (SYNC_V2 §3.10, app_settings.sync_v2_server_expiry or
 * sync_v2 = 'on'): the server's arrival time + duration. Legacy: the stored
 * sent_at + duration — and the stored sent_at keeps an offline-composed
 * message's old client stamp, so a message written offline for longer than
 * the duration arrived already expired and was swept before anyone saw it.
 */
const resolve_expires_at = (
  duration_sec: number | null | undefined,
  stored_sent_at: Date,
  server_time: boolean,
  now: Date = new Date(),
): Date | null =>
  duration_sec == null
    ? null
    : new Date((server_time ? now : stored_sent_at).getTime() + duration_sec * 1000);

export { UPLOADED_MEDIA_TYPES, resolve_stored_sent_at, resolve_expires_at };
