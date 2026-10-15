import db from "@/config/db";
import { note_fcm_delivered_receipt } from "@/services/fcm-health";
import {
  message_model,
  message_info_model,
  DBUpdateMessageStatusType,
  DBInsertMessageStatusType,
} from "@/models/message.model";
import { chat_member_model } from "@/models/chat.model";
import { broadcast_message } from "@/sockets/socket.handlers";
import { remove_pending_messages_batch } from "@/cache-management/polling.cache";
import Snowflake from "@/utils/snowflake.utils";
import { ResultType } from "@/types/core.types";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { MessageStatusAckPayload } from "@/types/socket.types";
import { note_delivered } from "@/services/sync/watermark.service";
import { sync_v2_flags } from "@/services/app-settings.service";
import { v2_on } from "@/services/sync/flags-core";
import { ack_seq_fields } from "@/services/sync/frame-fields";

// The chat_id / message_id / user_id columns are Postgres `uuid`. Passing an
// empty string or any non-UUID text straight into a WHERE clause makes
// Postgres throw `22P02 invalid input syntax for type uuid`, which surfaces as
// a 500 and error spam rather than a clean rejection. Guard inputs before they
// reach the query. (An old client shipping an empty conversation_id was the
// original trigger — see message_gc.service.dart.)
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const is_uuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v);

const insert_message_status = async (msg_status: Pick<DBInsertMessageStatusType, "user_id" | "message_id" | "chat_id" | "delivered_at" | "read_at">) => {
  try {
    const [inserted_status] = await db
      .insert(message_info_model)
      .values({
        user_id: msg_status.user_id,
        message_id: msg_status.message_id,
        chat_id: msg_status.chat_id,
        delivered_at: msg_status.delivered_at,
        read_at: msg_status.read_at,
      }).returning();

    if (!inserted_status) {
      return {
        success: false,
        code: 500,
        message: "Failed to store message status",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message status stored successfully",
      data: inserted_status,
    };
  } catch (error) {
    console.error("ERROR: store_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: store_message_status",
    };
  }
};

const update_message_status = async (msg_status: DBUpdateMessageStatusType) => {
  try {
    if (!msg_status.message_id || !msg_status.user_id) {
      return {
        success: false,
        code: 400,
        message: "message_id and user_id are required",
      };
    }

    let updated_status;
    if (msg_status.delivered_at && !msg_status.read_at) {
      updated_status = (await db
        .update(message_info_model)
        .set({
          delivered_at: msg_status.delivered_at,
        }).where(
          and(
            eq(message_info_model.message_id, msg_status.message_id),
            eq(message_info_model.user_id, msg_status.user_id)
          )
        ).returning())[0];
    }
    else if (!msg_status.delivered_at && msg_status.read_at) {
      updated_status = (await db
        .update(message_info_model)
        .set({
          read_at: msg_status.read_at,
        }).where(
          and(
            eq(message_info_model.message_id, msg_status.message_id),
            eq(message_info_model.user_id, msg_status.user_id)
          )
        ).returning())[0];
    }
    else {
      updated_status = (await db
        .update(message_info_model)
        .set({
          delivered_at: msg_status.delivered_at,
          read_at: msg_status.read_at,
        }).where(
          and(
            eq(message_info_model.message_id, msg_status.message_id),
            eq(message_info_model.user_id, msg_status.user_id)
          )
        ).returning())[0];
    }

    if (updated_status === undefined || updated_status === null) {
      return {
        success: false,
        code: 500,
        message: "Failed to update message status",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message status updated successfully",
      data: updated_status,
    };
  } catch (error) {
    console.error("ERROR: update_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: update_message_status",
    };
  }
};

// Delivered receipt as an UPSERT (SYNC_V2 R0). The FCM delivered path
// (/message/delivered, /delivered/batch) used update_message_status, which is
// UPDATE-only: when no message_info row existed yet for (message, recipient) —
// the usual case for a push-delivered message — the receipt matched nothing
// and was silently lost (Read-by / ticks never showed "delivered"). Now the
// row is inserted when missing. delivered_at is fill-a-blank (COALESCE): a
// replayed or late receipt never moves an existing delivery time. Only an
// active member of the chat (unremoved AND status='active' — left/pending
// keep removed_at NULL) gets a row created.
const upsert_message_delivered = async (
  message_id: string,
  chat_id: string,
  user_id: string,
  at: Date,
): Promise<number> => {
  const at_iso = at.toISOString();
  const result = await db.execute(sql`
    INSERT INTO ${message_info_model} (message_id, user_id, chat_id, delivered_at)
    SELECT ${message_id}::uuid, ${user_id}::uuid, ${chat_id}::uuid, ${at_iso}::timestamptz
    WHERE EXISTS (
      SELECT 1 FROM ${chat_member_model} cm
      WHERE cm.chat_id = ${chat_id}::uuid
        AND cm.user_id = ${user_id}::uuid
        AND cm.removed_at IS NULL
        AND cm.status = 'active'
    )
    ON CONFLICT (message_id, user_id) DO UPDATE
      SET delivered_at = COALESCE(${message_info_model.delivered_at}, EXCLUDED.delivered_at)
  `);
  return (result as any)?.count ?? (result as any)?.rowCount ?? 0;
};

const batch_insert_message_status = async (
  statuses: Array<Pick<DBInsertMessageStatusType, "user_id" | "message_id" | "chat_id" | "delivered_at" | "read_at">>
) => {
  try {
    if (statuses.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No statuses to insert",
        data: [],
      };
    }

    const records = statuses.map(status => ({
      user_id: status.user_id,
      message_id: status.message_id,
      chat_id: status.chat_id,
      delivered_at: status.delivered_at || null,
      read_at: status.read_at || null,
    }));

    const inserted_statuses = await db
      .insert(message_info_model)
      .values(records)
      .returning();

    return {
      success: true,
      code: 200,
      message: `Batch inserted ${inserted_statuses.length} message statuses`,
      data: inserted_statuses,
    };
  } catch (error) {
    console.error("ERROR: batch_insert_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: batch_insert_message_status",
    };
  }
};

const batch_update_message_status = async (
  user_id: string,
  message_ids: string[],
  status_update: { delivered_at?: Date; read_at?: Date; },
  conv_id?: string
) => {
  try {
    if (message_ids.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No message statuses to update",
        data: [],
      };
    }

    const updateData: { delivered_at?: Date; read_at?: Date; } = {};

    if (status_update.delivered_at) {
      updateData.delivered_at = status_update.delivered_at;
    }
    if (status_update.read_at) {
      updateData.read_at = status_update.read_at;
    }

    const whereConditions = [
      eq(message_info_model.user_id, user_id),
      inArray(message_info_model.message_id, message_ids)
    ];

    if (conv_id !== undefined) {
      whereConditions.push(eq(message_info_model.chat_id, conv_id));
    }

    const updated_statuses = await db
      .update(message_info_model)
      .set(updateData)
      .where(and(...whereConditions))
      .returning();

    return {
      success: true,
      code: 200,
      message: `Batch updated ${updated_statuses.length} message statuses`,
      data: updated_statuses,
    };
  } catch (error) {
    console.error("ERROR: batch_update_message_status", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: batch_update_message_status",
    };
  }
};

const mark_message_delivered = async (
  message_id: string,
  conversation_id: string,
  recipient_id: string,
  // is_active_in_conv: boolean = false,
) => {
  try {
    // Drain the recipient's pending-queue copy FIRST, before the lookup can
    // 404: the ack proves receipt whether or not the message still exists.
    // Since R0.1 poll reads no longer delete message:new, so an entry for a
    // message deleted after it was delivered would otherwise linger until
    // its 7-day expiry. Possible because entries use deterministic
    // correlation keys (`{user}:message:new:{id}`); pre-deploy random-keyed
    // entries miss harmlessly.
    remove_pending_messages_batch(recipient_id, [
      Snowflake.correlationId(recipient_id, "message:new", message_id),
    ]).catch(err => console.error("[STATUS] pending drain failed:", err));

    // SYNC_V2 §3.7 dual-write (shadow/on): delivered = seq(id), coalesced
    // per worker per (user, chat) for ~1 s. Like the drain above it does not
    // depend on the lookup below: a message deleted since still names a
    // position the recipient has received up to.
    note_delivered(recipient_id, conversation_id, [message_id]);

    const [message] = await db
      .select({
        id: message_model.id,
        sender_id: message_model.sender_id,
        chat_id: message_model.chat_id,
        // §14.13 FCM health (same row, no extra round trip).
        created_at: message_model.created_at,
      })
      .from(message_model)
      .where(
        and(
          eq(message_model.id, message_id),
          eq(message_model.chat_id, conversation_id),
          isNull(message_model.deleted_at)
        )
      )
      .limit(1);

    // This endpoint is the FCM-path receipt (both app builds call it only
    // from their FCM handlers): "fast" when it lands ≤ 2 min after the
    // message reached the server. No-op unless net telemetry is on.
    if (message && message.sender_id !== recipient_id) {
      note_fcm_delivered_receipt(recipient_id, message.created_at);
    }

    if (!message) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    const sender_id = message.sender_id;
    const now = new Date();

    // Upsert, not UPDATE-only — see upsert_message_delivered. A recipient
    // never gets a receipt row for their own message.
    if (sender_id !== recipient_id) {
      const rows = await upsert_message_delivered(message_id, conversation_id, recipient_id, now);
      if (rows === 0) {
        console.warn(`[STATUS] delivered upsert skipped (not a member) msg=${message_id} chat=${conversation_id} user=${recipient_id}`);
      }
    }

    // const ack_payload: MessageStatusAckPayload = {
    //   id: message_id,
    //   conv_id: conversation_id,
    //   sender_id: sender_id,
    //   delivered_at: now,
    //   delivered_to: is_active_in_conv ? [] : [recipient_id],
    //   read_by: is_active_in_conv ? [recipient_id] : [],
    // };
    const ack_payload: MessageStatusAckPayload = {
      recipient_id,
      at: now,
      acks: [{
        chat_id: conversation_id,
        msg_ids: [message_id],
        status: ['delivered'],
      }]
    };

    // System messages (e.g. "X set disappearing messages to 24 hours") have
    // sender_id = NULL — there's no original sender to notify, so skip the
    // status-ack broadcast. Without this guard, broadcast_message would queue
    // a missed_ws_messages row with user_id = "" and Postgres rejects the
    // empty string as an invalid uuid.
    //
    // SYNC_V2 §3.7: kept in 'on' too. This ack names ONE id; the delivered
    // window it advances (note_delivered → apply_receipts) may span rows the
    // device never received, so the window effects add no delivered frame
    // for legacy inputs (legacy_delivered) and this per-id relay stays.
    if (sender_id) {
      await broadcast_message({
        to: "users",
        user_ids: [sender_id],
        message: {
          type: "message:status:ack",
          payload: ack_payload,
          ws_timestamp: new Date()
        },
      });
    }

    return {
      success: true,
      code: 200,
      message: "Message marked as delivered successfully",
      data: {
        message_id,
        conversation_id,
        recipient_id,
        delivered_at: new Date(),
      },
    };
  } catch (error) {
    console.error("ERROR: mark_message_delivered", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: mark_message_delivered",
    };
  }
};

const mark_messages_delivered_batch = async (
  messages: Array<{ message_id: string; conversation_id: string; }>,
  recipient_id: string
) => {
  const results = await Promise.allSettled(
    messages.map(({ message_id, conversation_id }) =>
      mark_message_delivered(message_id, conversation_id, recipient_id)
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value?.success).length;
  const failed = results.length - succeeded;

  return {
    success: succeeded > 0,
    code: 200,
    message: `Batch delivery processed: ${succeeded}/${results.length} succeeded`,
    data: { succeeded, failed },
  };
};

// SYNC_V2 §4.1: items gain seq / srv_ts with sync_v2 'on' (the GC verify path
// adopts a seq whose sent:ack was lost).
type VerifiedItem = {
  delivered_to: string[];
  read_by: string[];
  sent_at: Date | null;
  seq?: number | null;
  srv_ts?: string | null;
};

const verify_message_ids = async (
  message_ids: string[],
  conversation_id: string,
  sender_id: string
): Promise<ResultType<{
  found: Record<string, VerifiedItem>;
  not_found: string[];
}>> => {
  try {
    // Reject malformed identifiers before they reach the uuid-typed query.
    // A bad conversation_id/sender_id can never match a row, so treat every
    // requested id as not_found rather than 500-ing on a Postgres cast error.
    if (!is_uuid(conversation_id) || !is_uuid(sender_id)) {
      console.warn(
        `verify_message_ids: rejecting non-UUID input conv=${JSON.stringify(
          conversation_id,
        )} sender=${JSON.stringify(sender_id)}`,
      );
      return {
        success: true,
        code: 200,
        message: "Invalid identifiers",
        data: { found: {}, not_found: message_ids },
      };
    }

    // Drop any non-UUID message ids too (same uuid-column hazard on the IN list).
    const valid_ids = message_ids.filter(is_uuid);

    if (valid_ids.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No IDs to verify",
        data: { found: {}, not_found: message_ids },
      };
    }

    const rows = await db
      .select({
        id: message_model.id,
        sent_at: message_model.sent_at,
        seq: message_model.seq,
        created_at: message_model.created_at,
      })
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, valid_ids),
          eq(message_model.chat_id, conversation_id),
          eq(message_model.sender_id, sender_id),
          isNull(message_model.deleted_at),
        )
      );

    const foundIds = new Set(rows.map((r) => r.id));
    const not_found = message_ids.filter((id) => !foundIds.has(id));

    // sent_at = the canonical stored value (store_message may have rewritten
    // the client's claim — clock clamp, or server-arrival time for uploaded
    // media). A sender whose message:sent:ack was lost adopts it from here.
    const found: Record<string, VerifiedItem> = {};
    const v2 = v2_on(sync_v2_flags());
    if (rows.length > 0) {
      for (const r of rows) {
        found[r.id] = {
          delivered_to: [],
          read_by: [],
          sent_at: r.sent_at,
          ...(v2 ? ack_seq_fields(r) : {}),
        };
      }

      const statusRows = await db
        .select({
          message_id: message_info_model.message_id,
          user_id: message_info_model.user_id,
          delivered_at: message_info_model.delivered_at,
          read_at: message_info_model.read_at,
        })
        .from(message_info_model)
        .where(
          and(
            inArray(message_info_model.message_id, rows.map((r) => r.id)),
            eq(message_info_model.chat_id, conversation_id),
          )
        );

      for (const s of statusRows) {
        const key = s.message_id;
        if (!found[key]) continue;
        if (s.delivered_at) found[key].delivered_to.push(s.user_id);
        if (s.read_at) found[key].read_by.push(s.user_id);
      }
    }

    return { success: true, code: 200, message: "OK", data: { found, not_found } };
  } catch (e) {
    console.error("verify_message_ids error", e);
    return { success: false, code: 500, message: "ERROR: verify_message_ids" };
  }
};

// Mark every message in the chat with sent_at <= target message's sent_at as
// read for this user, in a single round-trip:
//   1. Resolve target sent_at via subquery (one chat_id+id index seek).
//   2. INSERT … SELECT every qualifying message → upsert into message_info.
//   3. ON CONFLICT: read_at = GREATEST(existing, ts) (monotonic, never goes back),
//      delivered_at = COALESCE(existing, ts) (only fills when null, per spec).
//
// Skips the user's own messages (no self-ack rows).
// Touches the messages index (chat_id, sent_at desc WHERE deleted_at IS NULL).
const mark_read_upto = async (
  user_id: string,
  conversation_id: string,
  message_id: string,
  at: Date,
  prev_read_msg_id?: string | null,
): Promise<ResultType<{ rows_affected: number; }>> => {
  try {
    const at_iso = at instanceof Date ? at.toISOString() : at;

    const lower_bound = prev_read_msg_id
      ? sql`AND m.sent_at > (SELECT sent_at FROM ${message_model} WHERE id = ${prev_read_msg_id} LIMIT 1)`
      : sql``;

    const result = await db.execute(sql`
      WITH target AS (
        SELECT ${message_model.sent_at} AS sent_at
        FROM ${message_model}
        WHERE ${message_model.id} = ${message_id}
          AND ${message_model.chat_id} = ${conversation_id}
        LIMIT 1
      )
      INSERT INTO ${message_info_model}
        (message_id, user_id, chat_id, delivered_at, read_at)
      SELECT m.id, ${user_id}::uuid, m.chat_id, ${at_iso}::timestamptz, ${at_iso}::timestamptz
      FROM ${message_model} m, target t
      WHERE m.chat_id = ${conversation_id}
        AND m.sent_at IS NOT NULL
        AND m.sent_at <= t.sent_at
        ${lower_bound}
        AND m.deleted_at IS NULL
        AND (m.sender_id IS NULL OR m.sender_id <> ${user_id}::uuid)
      ON CONFLICT (message_id, user_id) DO UPDATE
        SET read_at      = GREATEST(${message_info_model.read_at}, EXCLUDED.read_at),
            delivered_at = COALESCE(${message_info_model.delivered_at}, EXCLUDED.delivered_at)
    `);

    const rows_affected = (result as any)?.count ?? (result as any)?.rowCount ?? 0;

    return {
      success: true,
      code: 200,
      message: `Marked ${rows_affected} messages as read up to ${message_id}`,
      data: { rows_affected },
    };
  } catch (error) {
    console.error("ERROR: mark_read_upto", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: mark_read_upto",
    };
  }
};

export {
  insert_message_status,
  update_message_status,
  batch_insert_message_status,
  batch_update_message_status,
  mark_message_delivered,
  mark_messages_delivered_batch,
  verify_message_ids,
  mark_read_upto,
};
