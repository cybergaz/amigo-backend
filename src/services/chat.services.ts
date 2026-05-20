import db from "@/config/db";
import {
  chat_model,
  chat_member_model,
  DBUpdateConversationType,
} from "@/models/chat.model";
import { message_model, message_info_model } from "@/models/message.model";
import { user_model } from "@/models/user.model";
import {
  ChatType,
} from "@/types/chat.types";
import { and, arrayContains, asc, desc, eq, gt, lt, inArray, isNotNull, isNull, ne, not, or, sql } from "drizzle-orm";
import { broadcast_message } from "@/sockets/socket.handlers";
import { ConversationActionPayload, DeleteMessagePayload, MembersType, WSMessage } from "@/types/socket.types";
import FCMService from "./fcm.service";
import { queue_message_fcm } from "./fcm-batch.service";
import { get_conversation_members } from "@/cache-management/conv.cache";
import { get_muted_user_ids } from "@/cache-management/chat-mute.cache";
import { get_chat_metas, get_all_unread } from "@/cache-management/chat-meta.cache";
import { get_message_statuses_bulk } from "@/cache-management/message.cache";
import { generate_unique_id } from "@/utils/general.utils";
import { randomUUIDv7 } from "bun";

const build_conversation_action_message = (
  action: ConversationActionPayload["action"],
  members: MembersType[],
  details?: { title?: string | null; profile_pic?: string | null; profile_pic_changed?: boolean },
) => {
  const names = members.map((m) => m.user_name).filter(Boolean);
  const target = names.length ? names.join(", ") : "Member";

  switch (action) {
    case "member_added":
      return `${target} added`;
    case "member_removed":
      return `${target} removed`;
    case "member_promoted":
      return `${target} promoted to admin`;
    case "member_demoted":
      return `${target} demoted to member`;
    case "chat_delete":
      return "This group was deleted";
    case "chat_details:update": {
      const renamed = details?.title !== undefined && details?.title !== null;
      const iconChanged = details?.profile_pic_changed === true;
      if (renamed && iconChanged) {
        return `Group renamed to "${details!.title}" and icon updated`;
      }
      if (renamed) return `Group renamed to "${details!.title}"`;
      if (iconChanged) {
        return details!.profile_pic ? "Group icon updated" : "Group icon removed";
      }
      return "Group details updated";
    }
    default:
      return target;
  }
};

const broadcast_conversation_action = async (data: {
  conv_id: string;
  conv_type: ChatType;
  action: ConversationActionPayload["action"];
  members: MembersType[];
  actor_id?: string;
  actor_name?: string;
  actor_pfp?: string;
  // Only meaningful for `chat_details:update`.
  title?: string | null;
  profile_pic?: string | null;
  previous_profile_pic?: string | null;
  // True when the pfp actually changed (incl. cleared). Distinguishes "no
  // pfp change in this update" (undefined) from "cleared to null".
  profile_pic_changed?: boolean;
}) => {
  // Member-action events require at least one member in the list (otherwise
  // there's nothing to announce). chat_details:update is the exception — it
  // describes the chat itself, not a member.
  if (data.action !== "chat_details:update" && !data.members.length) return;

  const action_at = new Date();
  const payload: ConversationActionPayload = {
    event_id: randomUUIDv7(),
    conv_id: data.conv_id,
    conv_type: data.conv_type,
    action: data.action,
    members: data.members,
    actor_id: data.actor_id,
    // actor_name: data.actor_name,
    // actor_pfp: data.actor_pfp,
    message: build_conversation_action_message(data.action, data.members, {
      title: data.title,
      profile_pic: data.profile_pic,
      profile_pic_changed: data.profile_pic_changed,
    }),
    action_at,
    ...(data.title !== undefined ? { title: data.title } : {}),
    ...(data.profile_pic_changed
      ? {
        profile_pic: data.profile_pic ?? null,
        previous_profile_pic: data.previous_profile_pic ?? null,
        profile_pic_changed: true,
      }
      : {}),
  };

  // For chat_delete the chat row is already gone, so the conversation member
  // cache lookup returns nothing → skip the conversation broadcast and rely
  // on the per-user broadcast below. For all other actions, broadcast to
  // the conversation (which fan-outs to current members via Redis cache).
  if (data.action !== "chat_delete") {
    await broadcast_message({
      to: "conversation",
      conv_id: data.conv_id,
      message: {
        type: "conversation:action",
        payload,
        ws_timestamp: action_at,
      },
    });
  }

  // For member_removed and chat_delete: the affected users are no longer in
  // the conv member cache (or the cache is gone), so the conversation
  // broadcast above either skips them or didn't run. Send the event direct
  // to user IDs so their client can mark themselves as removed / purge the
  // chat from local state.
  if (
    (data.action === "member_removed" || data.action === "chat_delete") &&
    data.members.length > 0
  ) {
    await broadcast_message({
      to: "users",
      user_ids: data.members.map(m => m.user_id),
      message: {
        type: "conversation:action",
        payload,
        ws_timestamp: action_at,
      },
    });
  }
};


// Compact preview of a replied-to message attached to history fetches and
// message:new broadcasts so the client can render the reply container on
// first paint without a local DB lookup falling through to "empty".
type RepliedToPreview = {
  id: string;
  sender_id: string | null;
  sender_name: string | null;
  type: string;
  body: string | null;
  attachments: unknown;
  sent_at: Date | null;
};

const fetch_replied_to_previews = async (
  ids: string[],
): Promise<Map<string, RepliedToPreview>> => {
  const out = new Map<string, RepliedToPreview>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: message_model.id,
      sender_id: message_model.sender_id,
      sender_name: user_model.name,
      type: message_model.type,
      body: message_model.body,
      attachments: message_model.attachments,
      sent_at: message_model.sent_at,
    })
    .from(message_model)
    .leftJoin(user_model, eq(user_model.id, message_model.sender_id))
    .where(inArray(message_model.id, ids));
  for (const r of rows) {
    out.set(r.id, r);
  }
  return out;
};

// Attach `replied_to_message` to each message that has a non-null replied_to,
// using a single batched query. Mutates and returns the input array for
// caller convenience.
const enrich_with_replied_to = async <
  T extends { replied_to: string | null;[key: string]: unknown },
>(
  messages: T[],
): Promise<(T & { replied_to_message: RepliedToPreview | null })[]> => {
  const ids = Array.from(
    new Set(
      messages
        .map(m => m.replied_to)
        .filter((id): id is string => !!id),
    ),
  );
  const previews = await fetch_replied_to_previews(ids);
  return messages.map(m => ({
    ...m,
    replied_to_message: m.replied_to ? previews.get(m.replied_to) ?? null : null,
  }));
};


const get_chat_list = async (user_id: string, type: string) => {
  try {
    // ── Single query: my memberships → chats, with DM peer via self-join ──
    // For DMs we self-join chat_members to get the other user in the same query.
    // For groups the peer columns come back null — no N+1.
    const is_deleted_dm = type === "deleted_dm";

    // dm_peer matches the *other* member of the DM. The peer's row should be
    // active (their removed_at is null) — even for the deleted_dm case where
    // it's the *current* user's row that has removed_at set.
    const dm_peer = db.$with("dm_peer").as(
      db.select({
        chat_id: chat_member_model.chat_id,
        user_id: chat_member_model.user_id,
      })
        .from(chat_member_model)
        .where(
          and(
            ne(chat_member_model.user_id, user_id),
            isNull(chat_member_model.removed_at),
          )
        )
    );

    const chats = await db
      .with(dm_peer)
      .select({
        conversationId: chat_model.id,
        type: chat_model.type,
        title: chat_model.title,
        profilePic: chat_model.profile_pic,
        lastMsgId: chat_model.last_msg_id,
        lastMsgAt: chat_model.last_msg_at,
        createrId: chat_model.creater_id,
        // Disappearing-messages duration (null = off). Shipped on every
        // chat-list payload so a fresh-login client can hydrate its local DB
        // and the input-border / avatar-badge UI without needing a separate
        // round-trip per chat.
        disappearingAfterSec: chat_model.disappearing_after_sec,

        role: chat_member_model.role,
        joinedAt: chat_member_model.joined_at,
        // For deleted DMs, expose the soft-delete timestamp so the UI can
        // show "deleted X ago". Null for active chats.
        deletedAt: chat_member_model.removed_at,
        // Per-user mute end time. Null when not muted. Far-future timestamp
        // represents "forever" (see mute.service.ts MUTED_FOREVER).
        mutedUntil: chat_member_model.muted_until,

        // DM peer info (null for groups)
        userId: user_model.id,
        userName: user_model.name,
        userPhone: user_model.phone,
        userProfilePic: user_model.profile_pic,
        lastSeen: user_model.last_seen,
      })
      .from(chat_member_model)
      .innerJoin(chat_model, eq(chat_model.id, chat_member_model.chat_id))
      .leftJoin(dm_peer, eq(dm_peer.chat_id, chat_model.id))
      .leftJoin(user_model, eq(user_model.id, dm_peer.user_id))
      .where(
        and(
          eq(chat_member_model.user_id, user_id),
          is_deleted_dm
            ? isNotNull(chat_member_model.removed_at)
            : isNull(chat_member_model.removed_at),
          isNull(chat_model.deleted_at),
          type !== "all"
            ? type === "group"
              ? eq(chat_model.type, "group")
              : type === "community_group"
                ? eq(chat_model.type, "community_group")
                : eq(chat_model.type, "dm")
            : undefined,
        )
      )
      .orderBy(desc(chat_model.last_msg_at));

    if (chats.length === 0) {
      return { success: false, code: 404, message: "No chats found" };
    }

    // ── Enrich from Redis: last message + unread counts ──────────────────
    const chat_ids = chats.map(c => c.conversationId);
    const [chat_metas, unread_counts] = await Promise.all([
      get_chat_metas(chat_ids),
      get_all_unread(user_id),
    ]);

    const enriched = chats.map(chat => {
      const meta = chat_metas.get(chat.conversationId);
      const unread = unread_counts.get(chat.conversationId) ?? 0;

      return {
        ...chat,
        // Clear DM peer fields for groups (they come back null anyway but be explicit)
        userId: chat.type === "dm" ? chat.userId : null,
        userName: chat.type === "dm" ? chat.userName : null,
        userPhone: chat.type === "dm" ? chat.userPhone : null,
        userProfilePic: chat.type === "dm" ? chat.userProfilePic : null,
        lastSeen: chat.type === "dm" ? chat.lastSeen : null,
        // Redis enrichment
        lastMessage: meta ?? null,
        unreadCount: unread,
      };
    });

    return {
      success: true,
      code: 200,
      data: enriched,
    };
  } catch (error) {
    console.error("get_chat_list error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_chat_list",
    };
  }
};


const update_conversation = async (conv_data: DBUpdateConversationType) => {
  try {
    if (!conv_data.id) {
      return {
        success: false,
        code: 400,
        message: "Conversation ID is required for update",
      };
    }

    const [updated_conversation] = await db
      .update(chat_model)
      .set(conv_data)
      .where(eq(chat_model.id, conv_data.id));

    return {
      success: true,
      code: 200,
      message: "Conversation updated successfully",
      data: updated_conversation,
    };


  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : update_conversation",
    };
  }
};

const soft_delete_chat = async (conversation_id: string, user_id: string) => {
  try {
    const [conversation] = await db
      .update(chat_model)
      .set({ deleted_at: new Date() })
      .where(eq(chat_model.id, conversation_id))
      .returning();

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: { conversation_id, deleted: false },
      };
    }

    return {
      success: true,
      code: 200,
      message: "Conversation soft deleted successfully",
      data: conversation
    };

  } catch (error) {
    console.error("delete conversation error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : soft_delete_conversation",
    };
  }
};

const revive_chat = async (conversation_id: string) => {
  try {
    // Verify conversation exists
    const [conversation] = await db
      .select({
        id: chat_model.id,
        deleted_at: chat_model.deleted_at,
      })
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id));

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: null,
      };
    }

    if (!conversation.deleted_at) {
      return {
        success: false,
        code: 400,
        message: "Conversation is not deleted",
        data: null,
      };
    }

    // Revive the conversation by clearing deleted_at
    const result = await db
      .update(chat_model)
      .set({ deleted_at: null })
      .where(eq(chat_model.id, conversation_id))
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 500,
        message: "Failed to revive conversation",
        data: null,
      };
    }

    return {
      success: true,
      code: 200,
      message: "Conversation revived successfully",
      data: result[0],
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : revive_chat",
      data: null,
    };
  }
};

// Shared fan-out for a batch of message ids that have already been
// soft-deleted at the DB level. Broadcasts message:delete to the chat,
// enqueues FCM for offline members, and repoints chat_model.last_msg_id /
// pinned_msg_id if any of the deleted ids matched.
//
// Callers:
//   - soft_delete_message (user-initiated): passes actor_id so the broadcast
//     excludes the sender (their UI already updated optimistically).
//   - disappearing sweeper (server-initiated): passes actor_id = null so
//     every chat member receives the event.
const broadcast_deletion = async (
  chat_id: string,
  message_ids: string[],
  actor_id: string | null,
): Promise<void> => {
  if (message_ids.length === 0) return;

  const payload: DeleteMessagePayload = {
    sender_id: actor_id ?? "",
    conv_id: chat_id,
    message_ids,
  };
  const ws_msg: WSMessage = {
    type: "message:delete",
    payload,
    ws_timestamp: new Date(),
  };

  // 1. WS broadcast to everyone connected in the conversation
  await broadcast_message({
    to: "conversation",
    conv_id: chat_id,
    message: ws_msg,
    exclude_user_ids: actor_id ? [actor_id] : [],
  });

  // 2. FCM / missed-ws enqueue for offline + polling members. queue_message_fcm
  //    is the existing path that also writes into missed_ws_messages, so this
  //    same call covers the "user comes back later via long-poll" case.
  //    Muted members get the FCM with silent=true so their app processes
  //    the deletion without painting a notification.
  const [members, muted] = await Promise.all([
    get_conversation_members(chat_id),
    get_muted_user_ids(chat_id),
  ]);
  for (const member_id of members) {
    await queue_message_fcm(member_id, ws_msg, { silent: muted.has(member_id) });
  }

  // 3. Repoint last_msg_id and pinned_msg_id if any of the deleted rows was
  //    the pointed-to message. Done in one round-trip select.
  const [conversation] = await db
    .select({
      id: chat_model.id,
      last_msg_id: chat_model.last_msg_id,
      last_msg_at: chat_model.last_msg_at,
      pinned_msg_id: chat_model.pinned_msg_id,
    })
    .from(chat_model)
    .where(eq(chat_model.id, chat_id))
    .limit(1);

  if (!conversation) return;

  const deleted_set = new Set(message_ids);
  const last_msg_hit = conversation.last_msg_id && deleted_set.has(conversation.last_msg_id);
  const pinned_hit = conversation.pinned_msg_id && deleted_set.has(conversation.pinned_msg_id);

  const updates: DBUpdateConversationType = {};

  if (last_msg_hit) {
    const [next] = await db
      .select({ id: message_model.id, sent_at: message_model.sent_at })
      .from(message_model)
      .where(and(
        eq(message_model.chat_id, chat_id),
        isNull(message_model.deleted_at),
      ))
      .orderBy(desc(message_model.created_at))
      .limit(1);
    updates.last_msg_id = next ? next.id : null;
    updates.last_msg_at = next ? next.sent_at : conversation.last_msg_at;
  }
  if (pinned_hit) {
    updates.pinned_msg_id = null;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(chat_model).set(updates).where(eq(chat_model.id, chat_id));
  }
};

const soft_delete_message = async (message_ids: string[], user_id: string, is_admin_or_staff?: boolean) => {
  try {
    // First, get the messages to retrieve chat_id and check if they exist
    const messagesToDelete = await db
      .select({
        id: message_model.id,
        chat_id: message_model.chat_id,
      })
      .from(message_model)
      .where(and(
        inArray(message_model.id, message_ids),
        isNull(message_model.deleted_at),
        !is_admin_or_staff ? eq(message_model.sender_id, user_id) : undefined,
      ));

    if (messagesToDelete.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Either message not found or you do not own this message",
        data: { message_id: message_ids, deleted: false },
      };
    }

    // Get unique chat IDs
    const conversationIds = [...new Set(messagesToDelete.map(m => m.chat_id))];

    // Soft delete the messages
    const deletedMessages = await db
      .update(message_model)
      .set({ deleted_at: new Date() })
      .where(and(
        inArray(message_model.id, message_ids),
        isNull(message_model.deleted_at),
        !is_admin_or_staff ? eq(message_model.sender_id, user_id) : undefined,
      ))
      .returning();

    if (!deletedMessages || deletedMessages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Either message not found or you do not own this message",
        data: { message_id: message_ids, deleted: false },
      };
    }

    // Fan out per conversation. broadcast_deletion handles WS + FCM +
    // last_msg/pinned repoint identically for user-initiated and sweeper-
    // initiated deletes — see its docs.
    for (const conversationId of conversationIds) {
      const ids_in_conv = messagesToDelete
        .filter(m => m.chat_id === conversationId)
        .map(m => m.id);
      await broadcast_deletion(conversationId, ids_in_conv, user_id);
    }

    return {
      success: true,
      code: 200,
      message: "Messages marked as deleted successfully",
      data: deletedMessages
    };

  } catch (error) {
    console.error("delete Message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : mark_as_delete_message",
    };
  }
};

const delete_message_for_me = async (
  message_ids: string[],
  user_id: string,
  conversation_id: string
) => {
  try {
    // Verify user is a member of the conversation
    const membership = await db
      .select()
      .from(chat_member_model)
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .limit(1);

    if (membership.length === 0) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Verify messages exist and belong to this conversation
    const messages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.chat_id,
      })
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, message_ids),
          eq(message_model.chat_id, conversation_id)
        )
      );

    if (messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Messages not found",
      };
    }

    // Update or insert message_info with deleted_at timestamp
    const updatedStatuses = await db
      .update(message_info_model)
      .set({
        deleted_at: new Date(),
      })
      .where(
        and(
          inArray(message_info_model.message_id, message_ids),
          eq(message_info_model.user_id, user_id),
          eq(message_info_model.chat_id, conversation_id)
        )
      )
      .returning();

    // For messages without existing status records, insert new ones
    const existingMessageIds = updatedStatuses.map(s => s.message_id);
    const messagesToInsert = messages.filter(
      m => !existingMessageIds.includes(m.id)
    );

    if (messagesToInsert.length > 0) {
      await db
        .insert(message_info_model)
        .values(
          messagesToInsert.map(msg => ({
            message_id: msg.id,
            user_id: user_id,
            chat_id: conversation_id,
            deleted_at: new Date(),
          }))
        )
        .onConflictDoUpdate({
          target: [
            message_info_model.message_id,
            message_info_model.user_id
          ],
          set: {
            deleted_at: new Date(),
          }
        });
    }

    return {
      success: true,
      code: 200,
      message: "Messages deleted for you",
      data: { deleted_count: messages.length }
    };

  } catch (error) {
    console.error("delete_message_for_me error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: delete_message_for_me",
    };
  }
};

const hard_delete_message = async (message_id: string) => {
  try {
    const result = await db
      .delete(message_model)
      .where(eq(message_model.id, message_id))
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message permanently deleted",
      data: result[0],
    };
  } catch (error) {
    console.error("permanently_delete_message_admin error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : permanently_delete_message_admin",
    };
  }
};

const get_conversation_history = async (
  conversation_id: string,
  user_id: string,
  limit: number = 100,
  before_message_id?: string,
  after_message_id?: string,
) => {
  try {
    // Verify membership with a lightweight single-row check
    const [membership] = await db
      .select({
        joining_date: chat_member_model.joined_at,
        last_read_msg_id: chat_member_model.last_read_msg_id,
        last_delivered_msg_id: chat_member_model.last_delivered_msg_id,
      })
      .from(chat_member_model)
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at),
        )
      )
      .limit(1);

    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // ── Cursor resolution ────────────────────────────────────────────────
    let anchor_created_at: Date | null = null;
    if (before_message_id || after_message_id) {
      const [anchor] = await db
        .select({ created_at: message_model.created_at })
        .from(message_model)
        .where(eq(message_model.id, (before_message_id ?? after_message_id)!));

      if (!anchor) {
        return { success: false, code: 404, message: "Anchor message not found" };
      }
      anchor_created_at = anchor.created_at;
    }

    // ── Single query: messages LEFT JOIN message_info for delete-for-me ──
    // The LEFT JOIN replaces the separate "fetch deleted IDs" query + NOT IN filter.
    const delete_for_me = db.$with("dfm").as(
      db.select({ message_id: message_info_model.message_id })
        .from(message_info_model)
        .where(
          and(
            eq(message_info_model.user_id, user_id),
            eq(message_info_model.chat_id, conversation_id),
            isNotNull(message_info_model.deleted_at),
          )
        )
    );

    const messages = await db
      .with(delete_for_me)
      .select({
        id: message_model.id,
        conversation_id: message_model.chat_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        replied_to: message_model.replied_to,
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        deleted_at: message_model.deleted_at,
        sender_name: user_model.name,
        sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(user_model, eq(user_model.id, message_model.sender_id))
      .leftJoin(delete_for_me, eq(delete_for_me.message_id, message_model.id))
      .where(
        and(
          eq(message_model.chat_id, conversation_id),
          isNull(message_model.deleted_at),
          isNull(delete_for_me.message_id), // exclude delete-for-me
          membership.joining_date
            ? gt(message_model.created_at, membership.joining_date)
            : undefined,
          // Cursor conditions
          anchor_created_at && before_message_id
            ? lt(message_model.created_at, anchor_created_at)
            : undefined,
          anchor_created_at && after_message_id
            ? gt(message_model.created_at, anchor_created_at)
            : undefined,
        )
      )
      .orderBy(
        before_message_id || !after_message_id
          ? desc(message_model.created_at)
          : asc(message_model.created_at)
      )
      .limit(limit);

    const has_more = messages.length === limit;

    // Reverse if we fetched backwards (before cursor) or initial load (newest first → oldest first for display)
    if (before_message_id || !after_message_id) messages.reverse();

    const enriched = await enrich_with_replied_to(messages);

    return {
      success: true,
      code: 200,
      data: {
        messages: enriched,
        has_more,
      },
    };

  } catch (error) {
    console.error("get_conversation_history error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_history",
    };
  }
};

const get_message_statuses = async (
  conversation_id: string,
  user_id: string,
  page: number = 1,
  limit: number = 1000
) => {
  try {
    // First, verify user is a member of this conversation
    const [member] = await db
      .select({
        user_id: chat_member_model.user_id,
      })
      .from(chat_member_model)
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .limit(1);

    if (!member) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Get all message statuses for this conversation from DB
    const statuses = await db
      .select()
      .from(message_info_model)
      .where(
        and(
          eq(message_info_model.chat_id, conversation_id)
        )
      )
      .orderBy(desc(message_info_model.delivered_at))
      .limit(limit)
      .offset(offset);

    // Enrich with unflushed Redis statuses
    const msg_ids = [...new Set(statuses.map(s => s.message_id))];
    const redis_statuses = await get_message_statuses_bulk(msg_ids);

    const enriched_statuses = statuses.map(s => {
      const redis_map = redis_statuses.get(s.message_id);
      if (!redis_map) return s;
      const redis_user = redis_map.get(s.user_id);
      if (!redis_user) return s;
      return {
        ...s,
        delivered_at: s.delivered_at ?? (redis_user.delivered_at ? new Date(redis_user.delivered_at) : null),
        read_at: s.read_at ?? (redis_user.read_at ? new Date(redis_user.read_at) : null),
      };
    });

    // Also add Redis-only entries (not yet in DB) for messages in this page
    for (const [msg_id, user_map] of redis_statuses) {
      for (const [uid, status] of user_map) {
        const exists = statuses.some(s => s.message_id === msg_id && s.user_id === uid);
        if (!exists && (status.delivered_at || status.read_at)) {
          enriched_statuses.push({
            message_id: msg_id,
            user_id: uid,
            chat_id: conversation_id,
            delivered_at: status.delivered_at ? new Date(status.delivered_at) : null,
            read_at: status.read_at ? new Date(status.read_at) : null,
            reaction: null,
            deleted_at: null,
          });
        }
      }
    }

    // Get total count for pagination info
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_info_model)
      .where(eq(message_info_model.chat_id, conversation_id));

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      success: true,
      code: 200,
      data: {
        statuses: enriched_statuses,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          limit,
          hasNextPage,
          hasPreviousPage,
        },
      },
    };

  } catch (error) {
    console.error("get_message_statuses error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_message_statuses",
    };
  }
};

// Helper function to get conversation details for a specific user
// Returns data in the same format as get_chat_list for consistency
const getConversationDetailsForUser = async (conversation_id: string, user_id: string) => {
  try {
    const [chat] = await db
      .select({
        conversationId: chat_model.id,
        type: chat_model.type,
        title: chat_model.title,
        lastMessageAt: chat_model.last_msg_at,
        role: chat_member_model.role,
        joinedAt: chat_member_model.joined_at,
        userId: user_model.id,
        userName: user_model.name,
        userPhone: user_model.phone,
        lastSeen: user_model.last_seen,
        userProfilePic: user_model.profile_pic,
      })
      .from(chat_member_model)
      .innerJoin(
        chat_model,
        eq(chat_model.id, chat_member_model.chat_id)
      )
      .leftJoin(
        user_model,
        and(
          eq(user_model.id, chat_member_model.user_id),
          ne(user_model.id, user_id)
        )
      )
      .where(
        and(
          eq(chat_model.id, conversation_id),
          eq(chat_member_model.user_id, user_id)
        )
      )
      .limit(1);

    if (!chat) return null;

    // For DMs, get the other user's info

    let final_chat_item: any;

    if (chat.type === "dm" && !chat.userId) {
      const [otherUser] = await db
        .select({
          userId: user_model.id,
          userName: user_model.name,
          userPhone: user_model.phone,
          lastSeen: user_model.last_seen,
          userProfilePic: user_model.profile_pic,
        })
        .from(chat_member_model)
        .innerJoin(user_model, eq(user_model.id, chat_member_model.user_id))
        .where(
          and(
            eq(chat_member_model.chat_id, conversation_id),
            ne(chat_member_model.user_id, user_id)
          )
        )
        .limit(1);

      final_chat_item = {
        ...chat,
        userId: otherUser?.userId || null,
        userName: otherUser?.userName || null,
        userPhone: otherUser?.userPhone || null,
        lastSeen: otherUser?.lastSeen || null,
        userProfilePic: otherUser?.userProfilePic || null,
      };
    }

    // For groups, clear user info
    if (chat.type === "group" || chat.type === "community_group") {
      // Also get group members for groups
      const members = await db
        .select({
          userId: user_model.id,
          userName: user_model.name,
          userPhone: user_model.phone,
          userProfilePic: user_model.profile_pic,
          role: chat_member_model.role,
          joinedAt: chat_member_model.joined_at,
        })
        .from(chat_member_model)
        .innerJoin(user_model, eq(user_model.id, chat_member_model.user_id))
        .where(eq(chat_member_model.chat_id, conversation_id))
        .orderBy(asc(chat_member_model.joined_at));

      final_chat_item = {
        ...chat,
        userId: null,
        userName: null,
        userPhone: null,
        lastSeen: null,
        userProfilePic: null,
        members: members.map(m => ({
          userId: m.userId,
          name: m.userName,
          profilePic: m.userProfilePic,
          role: m.role,
          joinedAt: m.joinedAt,
        })),
      };
    }

    return final_chat_item;
  } catch (error) {
    console.error('Error getting conversation details:', error);
    return null;
  }
};

const get_messages_around = async (
  conversation_id: string,
  message_id: string,
  user_id: string,
  before: number = 32,
  after: number = 32
) => {
  try {
    // 1. Verify user is a member of this conversation
    const members = await db
      .select({
        user_id: chat_member_model.user_id,
        name: user_model.name,
        profile_pic: user_model.profile_pic,
        group_role: chat_member_model.role,
        joining_date: chat_member_model.joined_at,
      })
      .from(chat_member_model)
      .leftJoin(
        user_model,
        eq(user_model.id, chat_member_model.user_id)
      )
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          isNull(chat_member_model.removed_at)
        )
      );

    if (!members.find(m => m.user_id === user_id)) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // 2. Get the target message
    const [targetMessage] = await db
      .select({
        id: message_model.id,
        created_at: message_model.created_at,
      })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, message_id),
          isNull(message_model.deleted_at)
        )
      )
      .limit(1);

    if (!targetMessage || !targetMessage.created_at) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    const target_created_at = targetMessage.created_at;

    // 3. Get message IDs deleted by this user (delete for me)
    const userDeletedMessages = await db
      .select({ message_id: message_info_model.message_id })
      .from(message_info_model)
      .where(
        and(
          eq(message_info_model.user_id, user_id),
          eq(message_info_model.chat_id, conversation_id),
          isNotNull(message_info_model.deleted_at)
        )
      );
    const deletedMessageIds = userDeletedMessages.map(d => d.message_id);

    const deleteFilter = deletedMessageIds.length > 0
      ? not(inArray(message_model.id, deletedMessageIds))
      : undefined;

    // 4. Fetch `before` messages with created_at < target
    const olderMessages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.chat_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        replied_to: message_model.replied_to,
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        deleted_at: message_model.deleted_at,
        sender_name: user_model.name,
        sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(user_model, eq(user_model.id, message_model.sender_id))
      .where(
        and(
          eq(message_model.chat_id, conversation_id),
          isNull(message_model.deleted_at),
          lt(message_model.created_at, target_created_at),
          deleteFilter,
        )
      )
      .orderBy(desc(message_model.created_at))
      .limit(before);

    // 5. Fetch `after` messages with created_at > target
    const newerMessages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.chat_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        replied_to: message_model.replied_to,
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        deleted_at: message_model.deleted_at,
        sender_name: user_model.name,
        sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(user_model, eq(user_model.id, message_model.sender_id))
      .where(
        and(
          eq(message_model.chat_id, conversation_id),
          isNull(message_model.deleted_at),
          gt(message_model.created_at, target_created_at),
          deleteFilter,
        )
      )
      .orderBy(asc(message_model.created_at))
      .limit(after);

    // 6. Fetch the target message itself
    const [target] = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.chat_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        replied_to: message_model.replied_to,
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        deleted_at: message_model.deleted_at,
        sender_name: user_model.name,
        sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(user_model, eq(user_model.id, message_model.sender_id))
      .where(eq(message_model.id, message_id))
      .limit(1);

    // 7. Combine: older (reversed to chronological) + target + newer
    const messages = [...olderMessages.reverse(), target, ...newerMessages]
      .filter((m): m is NonNullable<typeof m> => m !== undefined);
    const enriched = await enrich_with_replied_to(messages);

    return {
      success: true,
      code: 200,
      data: {
        messages: enriched,
        members,
        hasOlder: olderMessages.length === before,
        hasNewer: newerMessages.length === after,
      },
    };
  } catch (error) {
    console.error("get_messages_around error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_messages_around",
    };
  }
};

const get_chat_members = async (conversation_id: string, user_id: string) => {
  try {
    const [membership] = await db
      .select({ id: chat_member_model.id })
      .from(chat_member_model)
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at),
        )
      )
      .limit(1);

    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    const members = await db
      .select({
        id: chat_member_model.id,
        chat_id: chat_member_model.chat_id,
        user_id: chat_member_model.user_id,
        role: chat_member_model.role,
        joined_at: chat_member_model.joined_at,
        removed_at: chat_member_model.removed_at,
        last_read_msg_id: chat_member_model.last_read_msg_id,
        last_delivered_msg_id: chat_member_model.last_delivered_msg_id,
        muted_until: chat_member_model.muted_until,
        name: user_model.name,
        phone: user_model.phone,
        profile_pic: user_model.profile_pic,
        user_role: user_model.role,
      })
      .from(chat_member_model)
      .innerJoin(user_model, eq(user_model.id, chat_member_model.user_id))
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          isNull(chat_member_model.removed_at),
        )
      )
      .orderBy(asc(chat_member_model.joined_at));

    return {
      success: true,
      code: 200,
      data: { members },
    };
  } catch (error) {
    console.error("get_chat_members error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_chat_members",
    };
  }
};

export {
  get_chat_list,
  update_conversation,
  soft_delete_chat,
  revive_chat,
  soft_delete_message,
  broadcast_deletion,
  delete_message_for_me,
  hard_delete_message,
  get_conversation_history,
  get_message_statuses,
  getConversationDetailsForUser,
  broadcast_conversation_action,
  get_messages_around,
  get_chat_members,
};
