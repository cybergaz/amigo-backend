import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { and, eq, isNull } from "drizzle-orm";
import { set_chat_mute, clear_chat_mute } from "@/cache-management/chat-mute.cache";

// "Forever" mute is stored as a far-future timestamp so the single muted_until
// column expresses both "muted for N hours" and "muted indefinitely" without
// needing a second boolean. Chosen ~100 years out — well past any reasonable
// session lifetime but still a valid timestamptz.
const FOREVER_EPOCH_MS = Date.UTC(2125, 0, 1);
const MUTED_FOREVER = new Date(FOREVER_EPOCH_MS);

// Membership check shared by both endpoints. Returns the row or null.
const find_active_membership = async (chat_id: string, user_id: string) => {
  const [row] = await db
    .select({ id: chat_member_model.id })
    .from(chat_member_model)
    .where(and(
      eq(chat_member_model.chat_id, chat_id),
      eq(chat_member_model.user_id, user_id),
      isNull(chat_member_model.removed_at),
    ))
    .limit(1);
  return row ?? null;
};

// Set/extend the mute on a chat for the calling user.
//
// `until` is an ISO timestamp; pass null for "forever". Past timestamps are
// rejected because that's almost certainly a client mistake (the user meant
// to unmute, or there's clock skew worth flagging).
const set_user_chat_mute = async (
  chat_id: string,
  user_id: string,
  until: Date | null,
): Promise<{ success: boolean; code: number; message: string; data?: { muted_until: string } }> => {
  const membership = await find_active_membership(chat_id, user_id);
  if (!membership) {
    return { success: false, code: 403, message: "Not a member of this chat" };
  }

  const target = until ?? MUTED_FOREVER;
  if (target.getTime() <= Date.now()) {
    return { success: false, code: 400, message: "muted_until must be in the future" };
  }

  await set_chat_mute(user_id, chat_id, target);

  return {
    success: true,
    code: 200,
    message: "Chat muted",
    data: { muted_until: target.toISOString() },
  };
};

// Clear the mute on a chat for the calling user.
// Idempotent: no-op if the user wasn't muted.
const clear_user_chat_mute = async (
  chat_id: string,
  user_id: string,
): Promise<{ success: boolean; code: number; message: string }> => {
  const membership = await find_active_membership(chat_id, user_id);
  if (!membership) {
    return { success: false, code: 403, message: "Not a member of this chat" };
  }

  await clear_chat_mute(user_id, chat_id);

  return { success: true, code: 200, message: "Chat unmuted" };
};

export {
  set_user_chat_mute,
  clear_user_chat_mute,
  MUTED_FOREVER,
};
