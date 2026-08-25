import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { message_model } from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUIDv7 } from "bun";
import { broadcast_message } from "@/sockets/socket.handlers";
import { queue_message_fcm } from "@/services/fcm-batch.service";
import { get_conversation_members } from "@/cache-management/conv.cache";
import { get_muted_user_ids } from "@/cache-management/chat-mute.cache";
import {
  set_disappearing_after_sec,
  set_last_message,
} from "@/cache-management/chat-meta.cache";
import {
  ChatMessagePayload,
  ConversationDisappearingPayload,
  WSMessage,
} from "@/types/socket.types";

// Allowed durations match the WhatsApp UX: off / 24h / 7d / 90d. Anything
// else is rejected at the endpoint. Keeps the surface small and lets the
// client UI build a fixed picker.
//
// TEMPORARY: 120s ("2 minutes") is included for end-to-end testing of the
// sweeper — short enough to verify message:delete fan-out, last_msg_id
// repoint, and chat_meta refresh in a single sitting. Remove before GA.
const ALLOWED_DURATIONS = new Set<number>([
  120,                    // TEMP: 2-minute test option
  24 * 60 * 60,
  7 * 24 * 60 * 60,
  90 * 24 * 60 * 60,
]);

const is_valid_duration = (n: number | null): boolean => n === null || ALLOWED_DURATIONS.has(n);

// Apply the disappearing-messages setting to a chat.
//
// 1. Verifies the caller is a member of the chat.
// 2. Writes chats.disappearing_after_sec.
// 3. Refreshes the chat_meta Redis hash so the send path doesn't have to do a
//    DB read on the next message.
// 4. Inserts a system message in the chat noting the change.
// 5. Broadcasts both the new system message (message:new — existing pipeline)
//    and a conversation:disappearing event for clients that want to update
//    their settings UI without re-parsing the system message body.
//
// Already-sent messages are not retroactively given an expires_at; that
// matches WhatsApp and avoids any messy backfill.
const set_chat_disappearing = async (
  chat_id: string,
  actor_id: string,
  duration_sec: number | null,
): Promise<{ success: boolean; code: number; message: string; }> => {
  if (!is_valid_duration(duration_sec)) {
    return { success: false, code: 400, message: "Invalid duration" };
  }

  // Membership check — must be an active member of the chat to change settings.
  const [member] = await db
    .select({ id: chat_member_model.id })
    .from(chat_member_model)
    .where(and(
      eq(chat_member_model.chat_id, chat_id),
      eq(chat_member_model.user_id, actor_id),
      isNull(chat_member_model.removed_at),
    ))
    .limit(1);
  if (!member) {
    return { success: false, code: 403, message: "Not a member of this chat" };
  }

  // Persist the setting.
  const result = await db
    .update(chat_model)
    .set({ disappearing_after_sec: duration_sec })
    .where(eq(chat_model.id, chat_id))
    .returning({ id: chat_model.id });
  if (result.length === 0) {
    return { success: false, code: 404, message: "Chat not found" };
  }

  // Refresh cache so the next store_message picks up the new duration
  // without a DB read.
  await set_disappearing_after_sec(chat_id, duration_sec);

  // Insert a system message announcing the change. Goes through the regular
  // message_model so existing chat history / sync / FCM pipelines handle it.
  // sender_id is null (system); type='system'.
  const now = new Date();
  const actor_name = await db
    .select({ name: user_model.name })
    .from(user_model)
    .where(eq(user_model.id, actor_id))
    .limit(1)
    .then(r => r[0]?.name ?? "Someone");

  const sys_body = duration_sec == null
    ? `${actor_name} turned off disappearing messages`
    : `${actor_name} set disappearing messages to ${human_duration(duration_sec)}`;

  const sys_msg_id = randomUUIDv7();
  const [stored] = await db.insert(message_model).values({
    id: sys_msg_id,
    chat_id,
    sender_id: null,
    type: "system",
    body: sys_body,
    sent_at: now,
    // System message itself follows the chat's new setting — if disappearing
    // is on, this notice also disappears, matching WhatsApp's behaviour.
    expires_at: duration_sec != null ? new Date(now.getTime() + duration_sec * 1000) : null,
  }).returning();

  // Update chat last_msg pointers + chat_meta so the chat list reflects the
  // system message as the most recent entry. One writer keeps the Postgres
  // pointer and the Redis preview from drifting apart.
  await set_last_message(chat_id, {
    id: stored.id,
    body: stored.body ?? "",
    type: "system",
    sender_id: actor_id,                       // system has no sender
    sent_at: (stored.sent_at ?? now).toISOString(),
    attachments: null,
  });

  // Broadcast the system message as a normal message:new so clients render it
  // inline in the conversation. We don't go through handle_message_new because
  // it does sender-side ack work that doesn't apply for system messages.
  const new_msg_payload: ChatMessagePayload = {
    id: stored.id,
    conv_id: chat_id,
    sender_id: actor_id,
    msg_type: "system",
    body: stored.body ?? "",
    attachments: null,
    sent_at: stored.sent_at ?? now,
    expires_at: stored.expires_at ?? null,
  };
  const new_msg_ws: WSMessage = {
    type: "message:new",
    payload: new_msg_payload,
    ws_timestamp: now,
  };
  await broadcast_message({
    to: "conversation",
    conv_id: chat_id,
    message: new_msg_ws,
    exclude_user_ids: [actor_id]
  });

  // Separate conversation:disappearing event for clients that want to update
  // their settings UI without parsing system-message bodies.
  const setting_payload: ConversationDisappearingPayload = {
    conv_id: chat_id,
    actor_id,
    duration_sec,
    changed_at: now,
  };
  const setting_ws: WSMessage = {
    type: "conversation:disappearing",
    payload: setting_payload,
    ws_timestamp: now,
  };
  await broadcast_message({
    to: "conversation",
    conv_id: chat_id,
    message: setting_ws,
    // exclude_user_ids: [actor_id]
  });

  // FCM/missed-ws fan-out for offline + polling members. Mirrors the pattern
  // used in broadcast_deletion / handle_message_new for vital events. Muted
  // members get silent FCMs so they still receive the events but don't see a
  // local notification — chat settings updates shouldn't ping a muted chat.
  const [members, muted] = await Promise.all([
    get_conversation_members(chat_id),
    get_muted_user_ids(chat_id),
  ]);
  for (const member_id of members) {
    if (member_id === actor_id) continue; // No need to notify the actor of their own change — they already know!
    const silent = muted.has(member_id);
    await queue_message_fcm(member_id, new_msg_ws, { silent });
    await queue_message_fcm(member_id, setting_ws, { silent });
  }

  return { success: true, code: 200, message: "Disappearing setting updated" };
};

const human_duration = (sec: number): string => {
  if (sec === 86_400) return "24 hours";
  if (sec % 86_400 === 0) return `${sec / 86_400} days`;
  if (sec % 3600 === 0) return `${sec / 3600} hours`;
  if (sec % 60 === 0) return `${sec / 60} minutes`;   // 120s → "2 minutes"
  return `${sec} seconds`;
};

export { set_chat_disappearing, ALLOWED_DURATIONS };
