import db from "@/config/db";
import {
  message_model,
  message_info_model,
  DBUpdateMessageStatusType,
  DBInsertMessageStatusType,
} from "@/models/message.model";
import { broadcast_message } from "@/sockets/socket.handlers";
import { ResultType } from "@/types/core.types";
import Snowflake from "@/utils/snowflake.utils";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { remove_pending_message } from "@/cache-management/polling.cache";
import { MessageStatusAckPayload } from "@/types/socket.types";

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
    const [message] = await db
      .select({
        id: message_model.id,
        sender_id: message_model.sender_id,
        chat_id: message_model.chat_id,
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

    if (!message) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    const sender_id = message.sender_id;
    const now = new Date();

    const res = await update_message_status({
      message_id: message_id,
      user_id: recipient_id,
      delivered_at: now,
      // ...(is_active_in_conv && { read_at: now }),
    });

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

    // Remove from polling cache — the pending entry is keyed by its own UUIDv7,
    // not by message_id. We can't look it up by message_id, so skip this.
    // The polling cache self-cleans when the user reconnects and fetches.

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

const verify_message_ids = async (
  message_ids: string[],
  conversation_id: string,
  sender_id: string
): Promise<ResultType<{
  found: Record<string, { delivered_to: string[]; read_by: string[]; }>;
  not_found: string[];
}>> => {
  try {
    if (message_ids.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No IDs to verify",
        data: { found: {}, not_found: [] },
      };
    }

    const rows = await db
      .select({ id: message_model.id })
      .from(message_model)
      .where(
        and(
          inArray(message_model.id, message_ids),
          eq(message_model.chat_id, conversation_id),
          eq(message_model.sender_id, sender_id),
          isNull(message_model.deleted_at),
        )
      );

    const foundIds = new Set(rows.map((r) => r.id));
    const not_found = message_ids.filter((id) => !foundIds.has(id));

    const found: Record<string, { delivered_to: string[]; read_by: string[]; }> = {};
    if (rows.length > 0) {
      for (const r of rows) found[r.id] = { delivered_to: [], read_by: [] };

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
