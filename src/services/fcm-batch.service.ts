import { WSMessage } from '@/types/socket.types';
import FCMService from './fcm.service';

const MAX_MESSAGES = 4;
const WINDOW_MS = 4000;
// Reserve ~300 bytes for FCM envelope overhead (token, type, android config, etc.)
const MAX_WS_MESSAGES_BYTES = 3700;

interface UserBatch {
  messages: WSMessage[];
  timer: ReturnType<typeof setTimeout>;
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
  });
}

/**
 * Queue a ws-message FCM for a single user.
 * Batches are flushed when MAX_MESSAGES is reached, WINDOW_MS elapses,
 * or the accumulated ws_messages JSON would exceed MAX_WS_MESSAGES_BYTES.
 * In the size-overflow case the overflowing message starts the next batch.
 */
export async function queue_message_fcm(user_id: string, ws_message: WSMessage): Promise<void> {
  // console.log(`[FCM-BATCH] Queuing ${ws_message.type} for offline user ${user_id}`);
  let batch = batches.get(user_id);

  if (!batch) {
    batch = {
      messages: [],
      timer: setTimeout(() => flush(user_id), WINDOW_MS),
    };
    batches.set(user_id, batch);
  }

  // Check size before adding
  const projected = [...batch.messages, ws_message];
  if (ws_messages_byte_size(projected) > MAX_WS_MESSAGES_BYTES && batch.messages.length > 0) {
    // Current batch is full by size — sail it, start fresh with the new message
    clearTimeout(batch.timer);
    const to_flush = [...batch.messages];
    batches.set(user_id, {
      messages: [ws_message],
      timer: setTimeout(() => flush(user_id), WINDOW_MS),
    });
    // Flush old batch (fire-and-forget — failure is logged inside send_notification)
    FCMService.send_notification({
      type: 'ws-message',
      fcm_mode: 'data-only',
      user_ids: [user_id],
      ws_messages: to_flush,
    }).catch(err => console.error('[FCM-BATCH] flush on size overflow failed:', err));
    return;
  }

  batch.messages.push(ws_message);

  if (batch.messages.length >= MAX_MESSAGES) {
    await flush(user_id);
  }
}
