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
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUIDv7 } from "bun";
import {
  get_disappearing_after_sec,
  set_disappearing_after_sec,
  set_last_message,
} from "@/cache-management/chat-meta.cache";
import { resolve_expires_at, resolve_stored_sent_at } from "@/utils/message-time.utils";
import { sync_v2_flags } from "@/services/app-settings.service";
import { server_expiry_active, v2_on } from "@/services/sync/flags-core";
import { count } from "@/utils/counters";
import { get_chat_type, is_broadcast_chat } from "@/cache-management/chat-type.cache";
import { get_pin_state, set_pin } from "@/services/sync/set-pin";
import { is_uuid, sync_v2_gate } from "@/services/sync/read-core";
import { sanitize_attachments } from "@/utils/attachment-thumbs";
import { resolve_delete_authority, soft_delete_message } from "@/services/chat.services";
import {
  forward_source_floor,
  forward_target_allowed,
  is_own_resend,
  readable_after_floor,
  type ForwarderMembershipRow,
} from "@/utils/sender-identity";

// Product rule for broadcast lists: no pins, replies or reactions INSIDE the
// list chat (the app hides them; this is the server-side backstop). The list
// chat's only member is its owner, so none of these would leak — they would
// just create state no client renders.
const BROADCAST_UNSUPPORTED = {
  success: false,
  code: 400,
  message: "Not supported in a broadcast list",
} as const;

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

// message:new's `replied_to` is a client claim. store_message saved it as
// given and the fan-out / history then shipped that row's body + attachments
// as the reply preview — so a member could quote (and so read) a message
// deleted for everyone, an expired disappearing one, or one from a chat they
// are not in, just by knowing its id. Keep the reference only when it is a
// live, unexpired message of THIS chat (the same rule as /message/reply);
// otherwise it becomes a plain message (replied_to null — wire format
// unchanged). One PK lookup, only for replies. Throws on a DB error: the
// caller fails the frame transiently (the client retries) rather than
// storing an unchecked reference.
const resolve_reply_target = async (
  replied_to: string | null | undefined,
  conv_id: string,
): Promise<string | null> => {
  if (!replied_to || typeof replied_to !== "string") return null;
  if (!is_uuid(replied_to)) {
    count("AUTH", "reply_target_dropped");
    return null;
  }
  const [orig] = await db
    .select({ id: message_model.id })
    .from(message_model)
    .where(
      and(
        eq(message_model.id, replied_to),
        eq(message_model.chat_id, conv_id),
        isNull(message_model.deleted_at),
        or(isNull(message_model.expires_at), gt(message_model.expires_at, sql`now()`)),
      ),
    )
    .limit(1);
  if (orig) return orig.id;
  count("AUTH", "reply_target_dropped");
  console.warn(`[message:new] replied_to ${replied_to} is not a live message of ${conv_id}; sent as a plain message`);
  return null;
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
    // sent_at itself is clamped to server time (and uploaded media is stamped
    // with server arrival) — see resolve_stored_sent_at, shared with the
    // broadcast-list send path so both store the exact same value. The ack and
    // the fan-out both carry this stored value, so the sender's bubble moves to
    // the same place recipients see it.
    const sent_at_date = resolve_stored_sent_at(payload.msg_type, payload.sent_at);
    const duration_sec = await resolve_disappearing_after_sec(payload.conv_id);
    // SYNC_V2 §3.10: with server expiry on, the deadline counts from server
    // arrival, not the (possibly hours-old, offline-composed) client stamp.
    const expires_at = resolve_expires_at(
      duration_sec, sent_at_date, server_expiry_active(sync_v2_flags()),
    );

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

    if (existing && !is_own_resend(existing, payload.sender_id, payload.conv_id)) {
      // The id belongs to someone else's message / another chat: not a resend.
      // Refused like a plain PK collision (409 failed-ack), carrying none of
      // the foreign row's fields.
      count("SEQ", "new_id_foreign");
      console.warn(
        `[message:new] id ${payload.id} already stored for another sender/chat; refused (sender=${payload.sender_id} conv=${payload.conv_id})`,
      );
      return {
        success: false,
        code: 409,
        message: "message id already exists",
      };
    }

    if (existing) {
      // [SEQ] dup_precheck: a duplicate id reached the store; the messages_bi
      // pre-check allocated nothing for it and its original seq stands.
      count("SEQ", "dup_precheck");
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
//
// validate → commit → broadcast ONCE the committed state (SYNC_V2 R0, §3.12).
// Both legacy entry points are thin wrappers over set_pin (sync/set-pin.ts),
// the single pin writer: one conditional UPDATE that only changes the row when
// the pin actually moves (re-pinning the current pin is a no-op with NO
// broadcast) and only to a stored, undeleted message of this chat; the
// chats_bu_pin trigger stamps pin_seq. Response shapes and codes are exactly
// the pre-sync-v2 ones. `payload.user_id` must be the AUTHENTICATED id
// (ws.data / store), never a client payload field — receivers see it as the
// actor.
const pin_message = async (payload: PinMessageRequest) => {
  try {
    if (await is_broadcast_chat(payload.conv_id)) return { ...BROADCAST_UNSUPPORTED };

    // Legacy frames carry no base pin_seq (base = NULL).
    const r = await set_pin({ chat_id: payload.conv_id, actor_id: payload.user_id, message_id: payload.message_id });
    const data = { conv_id: payload.conv_id, message_id: payload.message_id };
    switch (r.outcome) {
      case "applied":
        console.log(`[PIN] applied pin conv=${payload.conv_id} msg=${payload.message_id}`);
        return { success: true, code: 200, message: "Message pinned successfully", data };
      case "noop":
        console.log(`[PIN] noop pin conv=${payload.conv_id} msg=${payload.message_id}`);
        return { success: true, code: 200, message: "Message already pinned", data };
      case "forbidden":
        console.warn(`[PIN] 403 pin conv=${payload.conv_id} msg=${payload.message_id} user=${payload.user_id}`);
        return { success: false, code: 403, message: "You are not a member of this conversation" };
      case "unsupported":
        return { ...BROADCAST_UNSUPPORTED };
      default:
        // not stored / deleted / not in this chat / lost a race: the legacy
        // answer for "the update matched nothing and it is not the pin".
        console.warn(`[PIN] 404 pin conv=${payload.conv_id} msg=${payload.message_id} (${r.outcome})`);
        return { success: false, code: 404, message: "Message not found" };
    }
  } catch (error) {
    console.error("pin_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: pin_message",
    };
  }
};

// Unpin a message — clears chats.pinned_msg_id, but only if the currently
// pinned message is the requested one (unpin_target: atomic compare-and-clear
// in the same UPDATE; a stale unpin can never clear a pin set in between).
const unpin_message = async (payload: PinMessageRequest) => {
  try {
    if (await is_broadcast_chat(payload.conv_id)) return { ...BROADCAST_UNSUPPORTED };

    const r = await set_pin({
      chat_id: payload.conv_id,
      actor_id: payload.user_id,
      message_id: null,
      unpin_target: payload.message_id,
    });
    switch (r.outcome) {
      case "applied":
        console.log(`[PIN] applied unpin conv=${payload.conv_id} msg=${payload.message_id}`);
        return {
          success: true,
          code: 200,
          message: "Message unpinned successfully",
          data: { conv_id: payload.conv_id, message_id: payload.message_id },
        };
      case "forbidden":
        console.warn(`[PIN] 403 unpin conv=${payload.conv_id} msg=${payload.message_id} user=${payload.user_id}`);
        return { success: false, code: 403, message: "You are not a member of this conversation" };
      case "unsupported":
        return { ...BROADCAST_UNSUPPORTED };
      default:
        // Not the current pin (already unpinned, or another message is pinned
        // now) — nothing changes, nothing is broadcast. Same 409 as before.
        console.warn(`[PIN] 409 unpin conv=${payload.conv_id} msg=${payload.message_id}`);
        return { success: false, code: 409, message: "This message is not currently pinned" };
    }
  } catch (error) {
    console.error("unpin_message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: unpin_message",
    };
  }
};

// The user's chat_members rows for one chat (joined with its type), as
// forward_target_allowed reads them.
const membership_rows_for = async (user_id: string, chat_id: string): Promise<ForwarderMembershipRow[]> =>
  db
    .select({
      chat_id: chat_member_model.chat_id,
      chat_type: chat_model.type,
      status: chat_member_model.status,
      removed_at: chat_member_model.removed_at,
      joined_at: chat_member_model.joined_at,
      cleared_at: chat_member_model.cleared_at,
    })
    .from(chat_member_model)
    .innerJoin(chat_model, eq(chat_model.id, chat_member_model.chat_id))
    .where(
      and(
        eq(chat_member_model.user_id, user_id),
        eq(chat_member_model.chat_id, chat_id),
      )
    );

// "May this user post into this chat?" — the message:new / forward rule.
const may_post_into = async (user_id: string, chat_id: string): Promise<boolean> =>
  forward_target_allowed(await membership_rows_for(user_id, chat_id));

// Reply to message
const reply_to_message = async (request: ReplyMessageRequest, user_id: string) => {
  try {
    if (await is_broadcast_chat(request.conversation_id)) return { ...BROADCAST_UNSUPPORTED };

    // May the replier post into this chat? The same rule as message:new's send
    // guard and forward targets (forward_target_allowed): an active member;
    // in a group also not removed. This check was commented out, so anyone
    // who knew a chat id and a message id could post into any chat.
    if (!(await may_post_into(user_id, request.conversation_id))) {
      count("AUTH", "reply_not_member");
      console.warn(`[reply] refused: user ${user_id} may not post into ${request.conversation_id}`);
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

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

    // Disappearing deadline (SYNC_V2 §3.10) — only with server expiry on.
    // Replies never carried one before, so the legacy behaviour (no expiry)
    // is kept while the flag is off; on, a reply disappears like any other
    // message in the chat, counted from server arrival.
    const reply_expires_at = server_expiry_active(sync_v2_flags())
      ? resolve_expires_at(await resolve_disappearing_after_sec(request.conversation_id), new Date(), true)
      : null;

    // Create new reply message — replied_to column stores the reference.
    // Idempotent on the client id, exactly like store_message (SYNC_V2 R0):
    // a retried request used to hit the PK and come back 500. A duplicate
    // returns the stored row and does NOT re-point the last message.
    const [insertedReply] = await db
      .insert(message_model)
      .values({
        id: request.message_id,
        chat_id: request.conversation_id,
        sender_id: user_id,
        type: "text",
        body: request.body,
        // §14.7 item 5: thumb / thumb_url bounded like on message:new.
        attachments: sanitize_attachments(request.attachments, { inline_thumbs: sync_v2_flags().inline_thumbs }),
        replied_to: originalMessage.id,
        ...(reply_expires_at ? { expires_at: reply_expires_at } : {}),
      })
      .onConflictDoNothing({ target: message_model.id })
      .returning();

    if (!insertedReply) {
      const [existing] = await db
        .select()
        .from(message_model)
        .where(eq(message_model.id, request.message_id))
        .limit(1);

      if (!existing) {
        return {
          success: false,
          code: 500,
          message: "ERROR: reply_to_message",
        };
      }

      // Only echo the row back when it's genuinely THIS sender's retry in
      // this chat — otherwise a known id would leak someone else's message
      // (incl. a deleted-for-everyone body) through the duplicate path.
      if (
        existing.sender_id !== user_id ||
        existing.chat_id !== request.conversation_id ||
        existing.deleted_at
      ) {
        console.warn(
          `[reply-dup] id collision rejected id=${request.message_id} user=${user_id}`
        );
        return {
          success: false,
          code: 409,
          message: "message id already exists",
        };
      }

      return {
        success: true,
        code: 200,
        message: "Reply already stored (duplicate send)",
        data: existing,
      };
    }
    const replyMessage = insertedReply;

    // Update the conversation's last-message pointer. Was Postgres-only, which
    // left the Redis preview showing the message this reply superseded; the
    // single writer keeps both halves in step. The insert above doesn't stamp
    // sent_at, so fall back to created_at (defaultNow) for the timestamp.
    await set_last_message(request.conversation_id, {
      id: replyMessage.id,
      body: replyMessage.body ?? "",
      type: (replyMessage.type ?? "text") as MessageType,
      sender_id: replyMessage.sender_id ?? user_id,
      sent_at: (replyMessage.sent_at ?? replyMessage.created_at ?? new Date()).toISOString(),
      attachments: replyMessage.attachments ?? null,
    }, { numbered: replyMessage.seq != null });

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
//
// `user_id` is the AUTHENTICATED forwarder (the route's JWT id, or the WS
// handler's connection id — message:forward's payload.forwarder_id is pinned
// to it). It must be able to READ the source messages (active member of the
// source chat, messages after its joined_at / cleared_at floor — the
// get_conversation_history gate) and must be allowed to POST into each target
// (forward_target_allowed: the message:new send-guard rule). Targets that fail
// are skipped; when none pass, the forward is refused with 403.
const forward_messages = async (request: ForwardMessageRequest, user_id: string) => {
  try {
    // The forwarder's membership rows for the source + every target chat, in
    // one round trip.
    const gate_chat_ids = [...new Set([request.source_conversation_id, ...request.target_conversation_ids])];
    const membership_rows: ForwarderMembershipRow[] = await db
      .select({
        chat_id: chat_member_model.chat_id,
        chat_type: chat_model.type,
        status: chat_member_model.status,
        removed_at: chat_member_model.removed_at,
        joined_at: chat_member_model.joined_at,
        cleared_at: chat_member_model.cleared_at,
      })
      .from(chat_member_model)
      .innerJoin(chat_model, eq(chat_model.id, chat_member_model.chat_id))
      .where(
        and(
          eq(chat_member_model.user_id, user_id),
          inArray(chat_member_model.chat_id, gate_chat_ids),
        )
      );
    const rows_of = (chat_id: string) =>
      membership_rows.filter((r) => r.chat_id?.toLowerCase() === chat_id.toLowerCase());

    const source = forward_source_floor(rows_of(request.source_conversation_id));
    if (!source) {
      console.warn(`[forward] refused: user ${user_id} is not an active member of source ${request.source_conversation_id}`);
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Get messages to forward (only those the forwarder can see)
    const original_messages = readable_after_floor(await db
      .select()
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, request.message_ids),
          eq(message_model.chat_id, request.source_conversation_id),
          isNull(message_model.deleted_at)
        )
      )
      .orderBy(message_model.created_at), source.floor);

    if (original_messages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No valid messages found to forward",
      };
    }

    // `duplicate`: the row already existed under the client's id (a replayed
    // forward, sync_v2 'on' only) — the caller must not fan it out again.
    const forwardedMessages: Map<string, (DBMessageType & { conv_type: string; duplicate?: boolean; })[]> = new Map();
    const client_ids = v2_on(sync_v2_flags()) && request.ids && typeof request.ids === "object" ? request.ids : null;

    let denied_targets = 0;
    for (const target_conv_id of request.target_conversation_ids) {
      // Forwarding INTO a broadcast list isn't supported (v1): this path only
      // inserts + fans out to the target chat's members, so the message would
      // land in the owner's list chat and never be copied to a recipient.
      // Skip it rather than store a message nobody receives.
      if ((await get_chat_type(target_conv_id)) === "broadcast") {
        console.warn(`[forward] skipping broadcast-list target ${target_conv_id}`);
        continue;
      }
      // Not allowed to post there (not / no longer an active member): skip.
      if (!forward_target_allowed(rows_of(target_conv_id))) {
        denied_targets++;
        count("AUTH", "forward_target_denied");
        console.warn(`[forward] skipping target ${target_conv_id}: user ${user_id} is not an active member`);
        continue;
      }

      const all_msgs: (DBMessageType & { conv_type: string; duplicate?: boolean; })[] = [];

      const [conv] = await db
        .select({ conv_type: chat_model.type })
        .from(chat_model)
        .where(eq(chat_model.id, target_conv_id));

      const target_ids = client_ids?.[target_conv_id];

      for (const message of original_messages) {
        const values = {
          chat_id: target_conv_id,
          sender_id: user_id,
          type: message.type,
          body: message.body,
          attachments: message.attachments,
          sent_at: new Date(),
        };
        // §3.3.7: the client's id for this (target, source message), if any.
        const wanted = Array.isArray(target_ids) ? target_ids[request.message_ids.indexOf(message.id)] : undefined;
        if (!is_uuid(wanted)) {
          const [inserted_msg] = await db
            .insert(message_model)
            .values({ id: randomUUIDv7(), ...values }).returning();

          all_msgs.push({
            ...inserted_msg,
            conv_type: conv.conv_type
          });
          continue;
        }
        const id = wanted.toLowerCase();
        const [inserted_msg] = await db
          .insert(message_model)
          .values({ id, ...values })
          .onConflictDoNothing({ target: message_model.id })
          .returning();
        if (inserted_msg) {
          all_msgs.push({ ...inserted_msg, conv_type: conv.conv_type });
          continue;
        }
        const [existing] = await db.select().from(message_model).where(eq(message_model.id, id)).limit(1);
        if (existing && existing.chat_id === target_conv_id && existing.sender_id === user_id) {
          // A replay: the original row (and its seq) stands; nothing is stored twice.
          count("SEQ", "forward_duplicate");
          all_msgs.push({ ...existing, conv_type: conv.conv_type, duplicate: true });
          continue;
        }
        // The id belongs to someone else's row: no idempotency is possible
        // for it, so store under a server id as an old client would.
        count("SEQ", "forward_id_foreign");
        const [fresh] = await db
          .insert(message_model)
          .values({ id: randomUUIDv7(), ...values }).returning();
        all_msgs.push({ ...fresh, conv_type: conv.conv_type });
      }

      forwardedMessages.set(target_conv_id, all_msgs);
    }

    if (forwardedMessages.size === 0 && denied_targets > 0) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of the target conversation(s)",
      };
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

// Delete messages (DELETE /message/delete — always delete-for-everyone).
//
// Authority is the same server-side rule as soft_delete_message
// (resolve_delete_authority): an active member may delete their OWN messages;
// another member's only as the chat's owner / a group admin / global staff,
// and global admin / sub_admin may delete anything. This route used to check
// nothing — any authenticated user could delete any message by id (the
// UPDATE was not even scoped to conversation_id). Delete-for-me is a separate
// per-user route (/message/delete-for-me) and is unaffected.
const delete_messages = async (request: DeleteMessageRequest, user_id: string) => {
  try {
    // The live messages to delete — only those IN request.conversation_id
    // (soft_delete_message itself takes ids from any chat).
    const messages = await db
      .select({
        id: message_model.id,
        chat_id: message_model.chat_id,
        sender_id: message_model.sender_id,
      })
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

    // Delete for everyone - only the message sender, or an elevated member /
    // master (see resolve_delete_authority), can do this.
    const authority = await resolve_delete_authority(user_id, [request.conversation_id]);
    const validMessages = messages.filter((msg) => authority.can_delete(msg));
    if (validMessages.length < messages.length) {
      count("AUTH", "delete_refused", messages.length - validMessages.length);
      console.warn(
        `[DELETE] /message/delete refused ${messages.length - validMessages.length}/${messages.length} message(s) for user ${user_id} (not sender / not member / not elevated)`,
      );
    }

    if (validMessages.length === 0) {
      return {
        success: false,
        code: 403,
        message: "You can only delete your own messages or you need admin privileges",
      };
    }

    // The one delete-for-everyone path: soft_delete_message re-checks the
    // same authority, then does what a raw UPDATE here skipped — the mod_seq
    // clock (SYNC_V2 §3.3.1), the broadcast-list copy cascade, the last /
    // pinned message repoint and the WS + FCM fan-out to the chat's members.
    // Only the authorised rows of THIS conversation are passed in (the
    // SELECT above is scoped to request.conversation_id).
    const result = await soft_delete_message(validMessages.map((m) => m.id), user_id);
    if (!result.success) {
      // 404 = nothing left to delete (a concurrent delete got there first);
      // 500 = transient, the client's outbox retries. `data` (partial 500:
      // the rows that DID commit) is passed through.
      return {
        success: false,
        code: result.code,
        message: result.message,
        ...("data" in result && Array.isArray(result.data) ? { data: result.data } : {}),
      };
    }

    return {
      success: true,
      code: 200,
      message: "Messages deleted for everyone",
      data: result.data,
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

// GET /message/pinned/:conversation_id (SYNC_V2 §3.12): the chat's current
// pin {pinned_msg_id, pin_seq, pinned_message} for any active member, whatever
// their clear / join floors (PD-3). Behind the Sync v2 gate: with every flag at
// its default it keeps answering the old 501, so nothing changes for 4.2.2.
const get_pinned_messages = async (conversation_id: string, user_id: string) => {
  if (!sync_v2_gate(user_id, sync_v2_flags()).ok) {
    return {
      success: false,
      code: 501,
      message: "Get pinned feature pending migration — metadata column removed",
    };
  }
  if (!is_uuid(conversation_id)) {
    return { success: false, code: 404, message: "Conversation not found" };
  }
  try {
    const r = await get_pin_state(user_id, conversation_id);
    if (r.code === 404) return { success: false, code: 404, message: "Conversation not found" };
    if (r.code === 403) return { success: false, code: 403, message: "You are not a member of this conversation" };
    return { success: true, code: 200, data: r.state };
  } catch (error) {
    console.error("get_pinned_messages error", error);
    return { success: false, code: 500, message: "ERROR: get_pinned_messages" };
  }
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
    if (await is_broadcast_chat(request.conversation_id)) return { ...BROADCAST_UNSUPPORTED };

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
  resolve_reply_target,
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
