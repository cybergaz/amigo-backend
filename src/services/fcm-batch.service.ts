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
