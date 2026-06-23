import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import {
  message_model,
  message_info_model,
  DBMessageType,
  DBInsertMessageType,
} from "@/models/message.model";
import { user_model } from "@/models/user.model";
import { broadcast_message } from "@/sockets/socket.handlers";
import {
  // ConversationMetadata,
  // MessageMetadata,
  PinMessageRequest,
  ReplyMessageRequest,
  ForwardMessageRequest,
  DeleteMessageRequest,
  ReactMessageRequest,
  MessageType
} from "@/types/chat.types";
import { ResultType } from "@/types/core.types";
import { ChatMessagePayload, MessagePinPayload, MessageReactPayload, } from "@/types/socket.types";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUIDv7 } from "bun";
import {
  get_disappearing_after_sec,
  set_disappearing_after_sec,
} from "@/cache-management/chat-meta.cache";

// Resolve the disappearing-messages duration for a chat with read-through
// caching on chat_meta. Returns null = disappearing off. Never throws — a
// failure here must NEVER break the send path; in that case we just don't
// stamp expires_at and the message becomes a normal (non-disappearing) one.
const resolve_disappearing_after_sec = async (chat_id: string): Promise<number | null> => {
  try {
    const cached = await get_disappearing_after_sec(chat_id);
    if (cached !== undefined) return cached;

    // Miss — hit DB and hydrate the cache for future sends.
    const [row] = await db
      .select({ d: chat_model.disappearing_after_sec })
      .from(chat_model)
      .where(eq(chat_model.id, chat_id))
      .limit(1);
    const value = row?.d ?? null;
    // Fire-and-forget hydration so the send path doesn't await Redis on miss.
    set_disappearing_after_sec(chat_id, value);
    return value;
  } catch (err) {
    console.error(`[message] resolve_disappearing_after_sec failed (${chat_id}):`, err);
    return null;
  }
};

// Helper function to verify user membership in conversation
const verify_user_membership = async (conversation_id: string, user_id: string) => {
  const membership = await db
    .select({ id: chat_member_model.id, role: chat_member_model.role })
    .from(chat_member_model)
    .where(
      and(
        eq(chat_member_model.chat_id, conversation_id),
        eq(chat_member_model.user_id, user_id),
        isNull(chat_member_model.removed_at),
        eq(chat_member_model.status, "active")
      )
    );

  return membership.length > 0 ? membership[0] : null;
};

// Helper function to get user info
const get_user_info = async (user_id: string) => {
  const [user] = await db
    .select({ id: user_model.id, name: user_model.name })
    .from(user_model)
    .where(eq(user_model.id, user_id));

  return user;
};

// Result of storing a message. `duplicate` = a row with this exact client id
// already existed (an idempotent re-send), so the caller must NOT fan it out again.
interface StoreMessageResultType extends ResultType<DBInsertMessageType> {
  duplicate?: boolean;
}

const store_message = async (payload: ChatMessagePayload): Promise<StoreMessageResultType> => {
  try {
    // Compute the disappearing-messages deadline before insert. Sent_at on the
    // wire is the client-stamped time; we add the chat's configured duration
    // to keep expiry deterministic per-message even if the setting changes
    // mid-conversation. duration null = no expiry stamped.
    //
    // Client clocks can be skewed (users with a fast device clock were
    // producing sent_at minutes in the future, shown verbatim to recipients).
    // Server time is the authority for the upper bound: never store a future
    // or unparseable sent_at. Past values are kept — offline-queued messages
    // legitimately carry an older client stamp.
    const now = new Date();
    const client_sent_at = new Date(payload.sent_at);
    const sent_at_date =
      Number.isNaN(client_sent_at.getTime()) || client_sent_at > now
        ? now
        : client_sent_at;
    const duration_sec = await resolve_disappearing_after_sec(payload.conv_id);
    const expires_at: Date | null = duration_sec != null
      ? new Date(sent_at_date.getTime() + duration_sec * 1000)
      : null;

    // Idempotent insert keyed on the client-generated message id (UUIDv7 = the PK).
    // The same logical message legitimately reaches the server more than once on a
    // flaky network (the original WS frame buffered into a dropped socket, then a
    // GC/poll resend carrying the SAME id). onConflictDoNothing makes that second
    // arrival a no-op instead of a unique-violation — so we NEVER store the body
    // twice. If nothing was inserted, the row already exists: fetch it and report
    // a duplicate so the caller can re-ack the sender without fanning out again.
    //
    // (This replaces the old "PK collision → mint a fresh id → re-insert" path,
    //  which turned every duplicate send into a second row with a different id that
    //  recipients could not dedup — the root cause of duplicate messages.)
    const [new_message] = await db
      .insert(message_model)
      .values({
        id: payload.id,
        chat_id: payload.conv_id,
        replied_to: payload.replied_to || null,
        sender_id: payload.sender_id,
        type: payload.msg_type,
        body: payload.body,
        attachments: payload.attachments,
        sent_at: sent_at_date,
        expires_at,
      })
      .onConflictDoNothing({ target: message_model.id })
      .returning();

    if (new_message) {
      return {
        success: true,
        code: 200,
        message: "Message stored successfully",
        data: new_message,
      };
    }

    // Nothing inserted → this id is already stored (duplicate send). Return the
    // canonical persisted row, flagged duplicate, so the caller skips re-fan-out.
    const [existing] = await db
      .select()
      .from(message_model)
      .where(eq(message_model.id, payload.id))
      .limit(1);

    if (existing) {
      return {
        success: true,
        code: 200,
        message: "Message already stored (duplicate send)",
        data: existing,
        duplicate: true,
      };
    }

    // Neither inserted nor found — a genuine failure (should not happen).
    return {
      success: false,
      code: 500,
      message: "Failed to store message",
    };
  }
  catch (error) {
    const err = error as any;
    const pg_code = err?.cause?.code ?? err?.code;
    if (pg_code === '23505') {
      return {
        success: false,
        code: 409,
        message: "message id already exists",
      };
    }
    return {
      success: false,
      code: 500,
      message: "Failed to store message",
    };
  }
};


// Retained for the call site. The old retry loop minted a fresh id and re-inserted
// the body whenever the client id "collided" (a 409) — but a 409 on a client UUIDv7
// id is NOT an accidental collision, it is a duplicate send, and re-inserting under a
// new id produced two undedupable rows (the duplicate-message bug). store_message is
// now idempotent on the client id, so exactly one call is correct and exactly-once.
// `retry_count` is kept only for signature compatibility and is unused.
const store_message_with_retry = async (payload: ChatMessagePayload, _retry_count?: number): Promise<StoreMessageResultType> => {
  return store_message(payload);
};

// Pin a message in a conversation — stores message_id in chat_model.pinned_msg_id
// (only one pinned message per conversation; calling again overwrites the previous pin)
const pin_message = async (payload: PinMessageRequest) => {
  try {
    // Verify user is a member of the conversation
    const membership = await verify_user_membership(payload.conv_id, payload.user_id);
    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Verify message exists in this conversation and isn't deleted
    const [message] = await db
      .select({
        id: message_model.id,
        type: message_model.type,
      })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, payload.message_id),
          eq(message_model.chat_id, payload.conv_id),
          isNull(message_model.deleted_at)
        )
      )
      .limit(1);

    if (!message) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    // Store the pinned message ID on the chat
    const [updated] = await db
      .update(chat_model)
      .set({ pinned_msg_id: payload.message_id })
      .where(eq(chat_model.id, payload.conv_id))
      .returning({ id: chat_model.id });

    if (!updated) {
      return {
        success: false,
        code: 404,
        message: "Coudn't pin the message",
      };
    }

    // Fetch sender name for the broadcast payload
    // const user = await get_user_info(payload.user_id);

    // Broadcast pin event to all members of the conversation
    const pinPayload: MessagePinPayload = {
      conv_id: payload.conv_id,
      message_id: payload.message_id,
      message_type: message.type as MessageType,
      sender_id: payload.user_id,
      // sender_name: user?.name ?? undefined,
      pin: true,
    };

    await broadcast_message({
      to: "conversation",
      conv_id: payload.conv_id,
      message: {
        type: "message:pin",
        payload: pinPayload,
        ws_timestamp: new Date(),
      },
    });

    return {
      success: true,
      code: 200,
      message: "Message pinned successfully",
      data: { conv_id: payload.conv_id, message_id: payload.message_id },
    };
  } catch (error) {
    console.error("pin_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: pin_message",
    };
  }
};

// Unpin a message — clears chat_model.pinned_msg_id, but only if the
// currently pinned message matches the requested message_id (idempotent guard).
const unpin_message = async (payload: PinMessageRequest) => {
  try {
    // Verify user is a member of the conversation
    const membership = await verify_user_membership(payload.conv_id, payload.user_id);
    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Get current pinned_msg_id to verify it matches
    const [conv] = await db
      .select({ pinned_msg_id: chat_model.pinned_msg_id })
      .from(chat_model)
      .where(eq(chat_model.id, payload.conv_id))
      .limit(1);

    if (!conv) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    if (conv.pinned_msg_id !== payload.message_id) {
      return {
        success: false,
        code: 409,
        message: "This message is not currently pinned",
      };
    }

    // Fetch message type for the broadcast payload (best-effort — may be deleted)
    const [message] = await db
      .select({ type: message_model.type })
      .from(message_model)
      .where(eq(message_model.id, payload.message_id))
      .limit(1);

    // Clear the pinned message
    await db
      .update(chat_model)
      .set({ pinned_msg_id: null })
      .where(eq(chat_model.id, payload.conv_id));

    // Fetch sender name for the broadcast payload
    // const user = await get_user_info(payload.user_id);

    // Broadcast unpin event to all members of the conversation
    const unpinPayload: MessagePinPayload = {
      conv_id: payload.conv_id,
      message_id: payload.message_id,
      message_type: (message?.type ?? "text") as MessageType,
      sender_id: payload.user_id,
      // sender_name: user?.name ?? undefined,
      pin: false,
    };

    await broadcast_message({
      to: "conversation",
      conv_id: payload.conv_id,
      message: {
        type: "message:pin",
        payload: unpinPayload,
        ws_timestamp: new Date(),
      },
    });

    return {
      success: true,
      code: 200,
      message: "Message unpinned successfully",
      data: { conv_id: payload.conv_id, message_id: payload.message_id },
    };
  } catch (error) {
    console.error("unpin_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: unpin_message",
    };
  }
};

// Reply to message
const reply_to_message = async (request: ReplyMessageRequest, user_id: string) => {
  try {
    // Verify user membership
    // const membership = await verify_user_membership(request.conversation_id, user_id);
    // if (!membership) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "You are not a member of this conversation",
    //   };
    // }

    // Get original message info
    const [originalMessage] = await db
      .select({
        id: message_model.id,
        body: message_model.body,
        sender_id: message_model.sender_id,
        created_at: message_model.created_at,
      })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, request.reply_to_message_id),
          eq(message_model.chat_id, request.conversation_id),
          isNull(message_model.deleted_at)
        )
      );


    if (!originalMessage) {
      return {
        success: false,
        code: 404,
        message: "Original message not found",
      };
    }

    // Create new reply message — replied_to column stores the reference
    const [replyMessage] = await db
      .insert(message_model)
      .values({
        id: request.message_id,
        chat_id: request.conversation_id,
        sender_id: user_id,
        type: "text",
        body: request.body,
        attachments: request.attachments,
        replied_to: originalMessage.id,
      })
      .returning();

    // Update conversation's last_msg_at
    await db
      .update(chat_model)
      .set({ last_msg_at: new Date(), last_msg_id: replyMessage?.id })
      .where(eq(chat_model.id, request.conversation_id));

    return {
      success: true,
      code: 200,
      message: "Reply sent successfully",
      data: replyMessage,
    };

  } catch (error) {
    console.error("reply_to_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: reply_to_message",
    };
  }
};

// Forward messages
const forward_messages = async (request: ForwardMessageRequest, user_id: string) => {
  try {

    // Get messages to forward
    const original_messages = await db
      .select()
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, request.message_ids),
          eq(message_model.chat_id, request.source_conversation_id),
          isNull(message_model.deleted_at)
        )
      )
      .orderBy(message_model.created_at);

    if (original_messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No valid messages found to forward",
      };
    }

    const forwardedMessages: Map<string, (DBMessageType & { conv_type: string; })[]> = new Map();

    for (const target_conv_id of request.target_conversation_ids) {

      const all_msgs: (DBMessageType & { conv_type: string; })[] = [];

      const [conv] = await db
        .select({ conv_type: chat_model.type })
        .from(chat_model)
        .where(eq(chat_model.id, target_conv_id));


      for (const message of original_messages) {
        const [inserted_msg] = await db
          .insert(message_model)
          .values({
            id: randomUUIDv7(),
            chat_id: target_conv_id,
            sender_id: user_id,
            type: message.type,
            body: message.body,
            attachments: message.attachments,
            sent_at: new Date(),
          }).returning();

        all_msgs.push({
          ...inserted_msg,
          conv_type: conv.conv_type
        });
      }

      forwardedMessages.set(target_conv_id, all_msgs);
    }

    return {
      success: true,
      code: 200,
      message: "Messages forwarded successfully",
      data: forwardedMessages,
    };

  } catch (error) {
    console.error("forward_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: forward_messages",
    };
  }
};

// Delete messages
const delete_messages = async (request: DeleteMessageRequest, user_id: string) => {
  try {
    // Verify user membership
    // const membership = await verify_user_membership(request.conversation_id, user_id);
    // if (!membership) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "You are not a member of this conversation",
    //   };
    // }

    // Get messages to delete
    const messages = await db
      .select()
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, request.message_ids),
          eq(message_model.chat_id, request.conversation_id),
          isNull(message_model.deleted_at)
        )
      );

    if (messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No valid messages found to delete",
      };
    }

    // Delete for everyone - only message sender or admin can do this
    // const validMessages = messages.filter(msg =>
    //   msg.sender_id === user_id || membership.role === "admin"
    // );
    //
    // if (validMessages.length === 0) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "You can only delete your own messages or you need admin privileges",
    //   };
    // }

    const deletedMessages = [];
    // Mark messages as deleted
    for (const message of request.message_ids) {
      const [deletedMessage] = await db
        .update(message_model)
        .set({
          deleted_at: new Date(),
        })
        .where(eq(message_model.id, message))
        .returning();

      deletedMessages.push(deletedMessage);
    }

    return {
      success: true,
      code: 200,
      message: "Messages deleted for everyone",
      data: deletedMessages,
    };

    // } else {
    //   // Delete for me only - store in user's metadata (not implemented in this basic version)
    //   // This would require a separate table or user-specific metadata to track deleted messages per user
    //   return {
    //     success: false,
    //     code: 501,
    //     message: "Delete for me only is not implemented yet",
    //   };
    // }

  } catch (error) {
    console.error("delete_messages error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: delete_messages",
    };
  }
};

// Get pinned messages for a conversation
// TODO: needs dedicated pinned_message_id column on chat_model (metadata column was removed)
const get_pinned_messages = async (conversation_id: string, user_id: string) => {
  return {
    success: false,
    code: 501,
    message: "Get pinned feature pending migration — metadata column removed",
  };
};

// TODO: needs dedicated star tracking (e.g. via message_info_model) — metadata column was removed
const get_starred_messages = async (user_id: string, conversation_id?: string) => {
  return {
    success: false,
    code: 501,
    message: "Get starred feature pending migration — metadata column removed",
  };
};


// React/unreact to a message - stores per-user reaction in message_status table
const react_to_message = async (request: ReactMessageRequest, user_id: string, user_name?: string) => {
  try {
    // Only active members may react — a left/kicked member must not be able to
    // post reactions into a group they no longer belong to (verify_user_membership
    // requires removed_at IS NULL AND status='active', same as pin/unpin/send).
    const membership = await verify_user_membership(request.conversation_id, user_id);
    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Verify the message exists
    const [message] = await db
      .select({ id: message_model.id, chat_id: message_model.chat_id })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, request.message_id),
          eq(message_model.chat_id, request.conversation_id),
          isNull(message_model.deleted_at)
        )
      )
      .limit(1);

    if (!message) {
      return { success: false, code: 404, message: "Message not found" };
    }

    // Upsert the user's reaction into message_info
    const newReaction = request.action === 'add' ? request.emoji : null;
    await db
      .insert(message_info_model)
      .values({
        message_id: request.message_id,
        user_id,
        chat_id: request.conversation_id,
        reaction: newReaction,
      })
      .onConflictDoUpdate({
        target: [message_info_model.message_id, message_info_model.user_id],
        set: {
          reaction: newReaction,
        },
      });

    // Delta-only broadcast — send just the change, not the full reactions map
    const reactPayload: MessageReactPayload = {
      message_id: request.message_id,
      conv_id: request.conversation_id,
      sender_id: user_id,
      // sender_name: user_name,
      emoji: request.emoji,
      action: request.action,
    };

    await broadcast_message({
      to: "conversation",
      conv_id: request.conversation_id,
      message: {
        type: "message:react",
        payload: reactPayload,
        ws_timestamp: new Date(),
      },
    });

    return { success: true, code: 200, message: "Reaction updated" };
  } catch (error) {
    console.error("react_to_message error", error);
    return { success: false, code: 500, message: "ERROR: react_to_message" };
  }
};

export {
  store_message,
  store_message_with_retry,
  pin_message,
  unpin_message,
  reply_to_message,
  forward_messages,
  delete_messages,
  get_pinned_messages,
  get_starred_messages,
  react_to_message,
};
