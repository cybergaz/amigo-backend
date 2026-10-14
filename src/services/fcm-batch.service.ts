import { WSMessage } from '@/types/socket.types';
import FCMService from './fcm.service';

const MAX_MESSAGES = 4;
const WINDOW_MS = 4000;
// Reserve ~300 bytes for FCM envelope overhead (token, type, android config, etc.)
const MAX_WS_MESSAGES_BYTES = 3700;

interface UserBatch {
  messages: WSMessage[];
  timer: ReturnType<typeof setTimeout>;
  // Whether this batch is targeting a recipient who has the source chat muted.
  // When true, the eventual send_notification flushes with silent=true so the
  // app skips painting a local notification (message still lands in the DB).
  // A toggle mid-batch flushes the current batch and starts a new one — see
  // queue_message_fcm.
  silent: boolean;
}

const batches = new Map<string, UserBatch>();

function ws_messages_byte_size(messages: WSMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

// [FCM] oversize_stubbed counter (per process, since start).
let oversize_stubbed_total = 0;

/**
 * Single-oversize stub (SYNC_V2 R0). A message:new that ALONE exceeds
 * MAX_WS_MESSAGES_BYTES used to be sent anyway (the size check only splits
 * when the batch already holds something), so FCM rejected the whole push
 * (4KB data limit) and the recipient got nothing. It is replaced by a minimal
 * stub: ids + chat id + type + the first 200 chars of body (notification
 * text; <= ~800 bytes even at 4 bytes/char), `partial: true`.
 *
 * Deliberately no `sent_at` either: old app builds parse message:new with
 * `DateTime.parse(json['sent_at'] as String)` and INSERT OR IGNORE the row —
 * a stub they could parse would be stored as a permanent empty bubble that
 * the real message (same id) could never overwrite. Without sent_at their
 * parser rejects it, so for them it is exactly today's "push lost" (they get
 * the message from the pending queue / history as before). Newer builds key
 * on `partial` and fetch the message instead of storing the stub.
 */
function make_oversize_stub(ws_message: WSMessage): WSMessage | null {
  if (ws_message.type !== 'message:new') return null;
  const p = (ws_message.payload ?? {}) as Record<string, any>;
  if (!p.id || !p.conv_id) return null;
  return {
    type: 'message:new',
    payload: {
      id: p.id,
      conv_id: p.conv_id,
      sender_id: p.sender_id,
      msg_type: p.msg_type,
      body: typeof p.body === 'string' ? p.body.slice(0, 200) : undefined,
      partial: true,
    } as any,
    ws_timestamp: ws_message.ws_timestamp,
  };
}

async function flush(user_id: string): Promise<void> {
  const batch = batches.get(user_id);
  if (!batch) return;

  clearTimeout(batch.timer);
  batches.delete(user_id);

  if (batch.messages.length === 0) return;

  // console.log(`[FCM-BATCH] Flushing ${batch.messages.length} messages to user ${user_id}`);
  await FCMService.send_notification({
    type: 'ws-message',
    fcm_mode: 'data-only',
    user_ids: [user_id],
    ws_messages: batch.messages,
    silent: batch.silent,
  });
}

/**
 * Queue a ws-message FCM for a single user.
 * Batches are flushed when MAX_MESSAGES is reached, WINDOW_MS elapses,
 * or the accumulated ws_messages JSON would exceed MAX_WS_MESSAGES_BYTES.
 * In the size-overflow case the overflowing message starts the next batch.
 *
 * `silent` defaults to false. When true, the eventual FCM data payload
 * carries `silent: '1'` so the app processes the message into local state
 * without painting a notification — the muted-chat path. A change in
 * `silent` mid-batch forces an early flush so we never mix silent and
 * non-silent messages into the same FCM.
 */
export async function queue_message_fcm(
  user_id: string,
  ws_message: WSMessage,
  options: { silent?: boolean } = {},
): Promise<void> {
  const silent = options.silent === true;
  // console.log(`[FCM-BATCH] Queuing ${ws_message.type} for offline user ${user_id} (silent=${silent})`);

  // A single message too big for FCM on its own → send a stub, ALONE (never
  // batched: an old client's parser aborts the rest of a ws_messages array at
  // the stub, so it must not share a push with real messages). Whatever is
  // already batched is flushed first so per-user order is kept.
  if (ws_messages_byte_size([ws_message]) > MAX_WS_MESSAGES_BYTES) {
    const stub = make_oversize_stub(ws_message);
    if (stub) {
      oversize_stubbed_total++;
      console.warn(
        `[FCM] oversize_stubbed user=${user_id} msg=${(stub.payload as any).id} bytes=${ws_messages_byte_size([ws_message])} total=${oversize_stubbed_total}`,
      );
      await flush(user_id);
      FCMService.send_notification({
        type: 'ws-message',
        fcm_mode: 'data-only',
        user_ids: [user_id],
        ws_messages: [stub],
        silent,
      }).catch(err => console.error('[FCM-BATCH] oversize stub send failed:', err));
      return;
    }
  }

  let batch = batches.get(user_id);

  // Mute toggled (or first message). Flush the existing batch first so the
  // silent flag for the next batch is unambiguous.
  if (batch && batch.silent !== silent) {
    await flush(user_id);
    batch = undefined;
  }

  if (!batch) {
    batch = {
      messages: [],
      timer: setTimeout(() => flush(user_id), WINDOW_MS),
      silent,
    };
    batches.set(user_id, batch);
  }

  // Check size before adding
  const projected = [...batch.messages, ws_message];
  if (ws_messages_byte_size(projected) > MAX_WS_MESSAGES_BYTES && batch.messages.length > 0) {
    // Current batch is full by size — sail it, start fresh with the new message
    clearTimeout(batch.timer);
    const to_flush = [...batch.messages];
    const flush_silent = batch.silent;
    batches.set(user_id, {
      messages: [ws_message],
      timer: setTimeout(() => flush(user_id), WINDOW_MS),
      silent,
    });
    // Flush old batch (fire-and-forget — failure is logged inside send_notification)
    FCMService.send_notification({
      type: 'ws-message',
      fcm_mode: 'data-only',
      user_ids: [user_id],
      ws_messages: to_flush,
      silent: flush_silent,
    }).catch(err => console.error('[FCM-BATCH] flush on size overflow failed:', err));
    return;
  }

  batch.messages.push(ws_message);

  if (batch.messages.length >= MAX_MESSAGES) {
    await flush(user_id);
  }
}

/**
 * Drain (SYNC_V2 §13.9.3, D1): send every open batch now instead of losing it
 * when the process exits. A batch waits up to WINDOW_MS (4 s) for more
 * messages; on a restart those pushes are the only copy an offline (often
 * FCM-only, Wi-Fi-flaky) recipient would get before the pending queue is
 * replayed on their next connect. Returns how many batches were flushed.
 */
export async function flush_all(): Promise<number> {
  const user_ids = [...batches.keys()];
  const results = await Promise.allSettled(user_ids.map((id) => flush(id)));
  for (const r of results) {
    if (r.status === 'rejected') console.error('[FCM-BATCH] flush_all send failed:', r.reason);
  }
  return user_ids.length;
}
