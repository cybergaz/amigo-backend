import { WSMessage } from '@/types/socket.types';
import FCMService from './fcm.service';
import { sync_v2_flags } from './app-settings.service';
import { v2_on } from './sync/flags-core';
import { strip_inline_thumbs } from '@/utils/attachment-thumbs';

const MAX_MESSAGES = 4;
const WINDOW_MS = 4000;
// Reserve ~300 bytes for FCM envelope overhead (token, type, android config, etc.)
const MAX_WS_MESSAGES_BYTES = 3700;

type ResultCallback = (ok: boolean) => void;

interface UserBatch {
  messages: WSMessage[];
  // Per-message on_result callbacks (the [FANOUT] log's sent/failed), called
  // once with the batch's send result.
  callbacks: ResultCallback[];
  timer: ReturnType<typeof setTimeout>;
  // Whether this batch is targeting a recipient who has the source chat muted.
  // When true, the eventual send_notification flushes with silent=true so the
  // app skips painting a local notification (message still lands in the DB).
  // A toggle mid-batch flushes the current batch and starts a new one — see
  // queue_message_fcm.
  silent: boolean;
  // android priority 'normal' for the whole batch (the ack fallback's pushes,
  // §14.13). Like `silent`, a change flushes the batch first.
  normal_priority: boolean;
}

const batches = new Map<string, UserBatch>();

function ws_messages_byte_size(messages: WSMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

// A callback must never break the send path.
function report(callbacks: ResultCallback[], ok: boolean): void {
  for (const cb of callbacks) {
    try {
      cb(ok);
    } catch (err) {
      console.error('[FCM-BATCH] on_result callback threw:', err);
    }
  }
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
/**
 * SYNC_V2 §3.14 FCM projection (sync_v2 'on' only; off / shadow push the
 * frame exactly as before): FCM is a 4 KB doorbell, never the source of
 * truth, so `meta` and `pinned_message` never ride a push.
 *
 * Deviation from §3.14: the replied-to preview's body is KEPT. 4.2.2 stores
 * the preview it receives and never refreshes it, so dropping the body would
 * leave every push-delivered reply with an empty quote on old phones; an
 * oversize message still goes out as the stub below.
 */
function project_for_fcm(input: WSMessage): WSMessage {
  // §14.7 item 5 (every mode): the inline `thumb` (~2 KB base64 per
  // attachment) never rides a push — with it a photo message would not fit
  // the 4 KB data limit and degrade to the `partial` stub. Only payloads that
  // carry a thumb (new apps) change; everything else stays byte-identical.
  let ws_message = input;
  const p0 = input.payload as Record<string, any> | undefined;
  if (input.type === 'message:new' && p0 && typeof p0 === 'object') {
    const stripped = strip_inline_thumbs(p0);
    if (stripped !== p0) ws_message = { ...input, payload: stripped as any };
  }
  if (!v2_on(sync_v2_flags())) return ws_message;
  const p = ws_message.payload as Record<string, any> | undefined;
  if (!p || typeof p !== 'object') return ws_message;
  // message:delete's `mods` / `pin` ('on' only) are derivable (v2 clients
  // repair them through delta / heads; old apps ignore them) and cost ~70
  // bytes per id: with them a delete push fits 33 ids instead of 89, and an
  // oversize delete has no stub, so FCM would reject it — losing the
  // background delete 4.2.2 phones rely on.
  const strip_delete = ws_message.type === 'message:delete' && ('mods' in p || 'pin' in p);
  if (!strip_delete && !('meta' in p) && !('pinned_message' in p)) return ws_message;
  const { meta: _meta, pinned_message: _pin, ...rest } = p;
  if (strip_delete) {
    delete (rest as Record<string, unknown>).mods;
    delete (rest as Record<string, unknown>).pin;
  }
  return { ...ws_message, payload: rest as any };
}

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
      // §3.14: the stub's seq (only 'on' payloads carry one).
      ...(p.seq != null ? { seq: p.seq } : {}),
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
  let ok = false;
  try {
    ok = await FCMService.send_notification({
      type: 'ws-message',
      fcm_mode: 'data-only',
      user_ids: [user_id],
      ws_messages: batch.messages,
      silent: batch.silent,
      ...(batch.normal_priority ? { priority: 'normal' as const } : {}),
    });
  } finally {
    report(batch.callbacks, ok);
  }
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
  options: { silent?: boolean; on_result?: ResultCallback; normal_priority?: boolean } = {},
): Promise<void> {
  const silent = options.silent === true;
  const normal_priority = options.normal_priority === true;
  const priority = normal_priority ? { priority: 'normal' as const } : {};
  const callbacks = options.on_result ? [options.on_result] : [];
  ws_message = project_for_fcm(ws_message);
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
        ...priority,
      })
        .then(ok => report(callbacks, ok))
        .catch(err => {
          report(callbacks, false);
          console.error('[FCM-BATCH] oversize stub send failed:', err);
        });
      return;
    }
  }

  let batch = batches.get(user_id);

  // Mute toggled (or first message), or a different priority. Flush the
  // existing batch first so the flags for the next batch are unambiguous.
  if (batch && (batch.silent !== silent || batch.normal_priority !== normal_priority)) {
    await flush(user_id);
    batch = undefined;
  }

  if (!batch) {
    batch = {
      messages: [],
      callbacks: [],
      timer: setTimeout(() => flush(user_id), WINDOW_MS),
      silent,
      normal_priority,
    };
    batches.set(user_id, batch);
  }

  // Check size before adding
  const projected = [...batch.messages, ws_message];
  if (ws_messages_byte_size(projected) > MAX_WS_MESSAGES_BYTES && batch.messages.length > 0) {
    // Current batch is full by size — sail it, start fresh with the new message
    clearTimeout(batch.timer);
    const to_flush = [...batch.messages];
    const flush_callbacks = batch.callbacks;
    const flush_silent = batch.silent;
    const flush_priority = batch.normal_priority ? { priority: 'normal' as const } : {};
    batches.set(user_id, {
      messages: [ws_message],
      callbacks,
      timer: setTimeout(() => flush(user_id), WINDOW_MS),
      silent,
      normal_priority,
    });
    // Flush old batch (fire-and-forget — failure is logged inside send_notification)
    FCMService.send_notification({
      type: 'ws-message',
      fcm_mode: 'data-only',
      user_ids: [user_id],
      ws_messages: to_flush,
      silent: flush_silent,
      ...flush_priority,
    })
      .then(ok => report(flush_callbacks, ok))
      .catch(err => {
        report(flush_callbacks, false);
        console.error('[FCM-BATCH] flush on size overflow failed:', err);
      });
    return;
  }

  batch.messages.push(ws_message);
  batch.callbacks.push(...callbacks);

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
