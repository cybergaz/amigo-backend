// User-raised "I forgot my PIN, please reset it" requests, fulfilled by a super
// admin from the panel. Fulfilment (setting the new PIN) lives in
// admin_set_user_password_pin (user.services), which also auto-accepts the pending
// request. Here: raise (idempotent), list (joined w/ users), and reject/dismiss.
import db from "@/config/db";
import { pin_reset_request_model } from "@/models/pin-reset-request.model";
import { user_model } from "@/models/user.model";
import { and, desc, eq, sql } from "drizzle-orm";
import type { RequestStatusType } from "@/types/user.types";

// At most one PENDING request per user (partial unique index) → a retried tap is a
// no-op that returns the existing request rather than stacking duplicates.
const raise_pin_reset_request = async (user_id: string) => {
  try {
    const [existing] = await db
      .select({ id: pin_reset_request_model.id })
      .from(pin_reset_request_model)
      .where(and(
        eq(pin_reset_request_model.user_id, user_id),
        eq(pin_reset_request_model.status, "pending"),
      ))
      .limit(1);
    if (existing) {
      return { success: true, code: 200, message: "A reset request is already pending", data: { id: existing.id, already: true } };
    }

    const [row] = await db
      .insert(pin_reset_request_model)
      .values({ user_id })
      // Race guard: concurrent taps both pass the check above; the partial unique
      // index lets only one land, the other is swallowed here.
      .onConflictDoNothing()
      .returning({ id: pin_reset_request_model.id });

    if (!row) {
      const [again] = await db
        .select({ id: pin_reset_request_model.id })
        .from(pin_reset_request_model)
        .where(and(
          eq(pin_reset_request_model.user_id, user_id),
          eq(pin_reset_request_model.status, "pending"),
        ))
        .limit(1);
      return { success: true, code: 200, message: "A reset request is already pending", data: { id: again?.id ?? null, already: true } };
    }

    return { success: true, code: 201, message: "Reset request submitted", data: { id: row.id, already: false } };
  } catch (error) {
    console.error("raise_pin_reset_request error:", error);
    return { success: false, code: 500, message: "Failed to submit request", data: null };
  }
};

const get_pin_reset_requests = async (page: number = 1, limit: number = 20, status?: string) => {
  try {
    const offset = (page - 1) * limit;
    const where = status && status !== "all"
      ? eq(pin_reset_request_model.status, status as RequestStatusType)
      : undefined;

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(pin_reset_request_model)
      .where(where);
    const totalCount = Number(count);

    const requests = await db
      .select({
        id: pin_reset_request_model.id,
        user_id: pin_reset_request_model.user_id,
        name: user_model.name,
        phone: user_model.phone,
        status: pin_reset_request_model.status,
        resolved_at: pin_reset_request_model.resolved_at,
        created_at: pin_reset_request_model.created_at,
      })
      .from(pin_reset_request_model)
      .leftJoin(user_model, eq(pin_reset_request_model.user_id, user_model.id))
      .where(where)
      // Pending first, then newest.
      .orderBy(
        sql`CASE WHEN ${pin_reset_request_model.status} = 'pending' THEN 0 ELSE 1 END`,
        desc(pin_reset_request_model.created_at),
      )
      .limit(limit)
      .offset(offset);

    const totalPages = Math.ceil(totalCount / limit);
    return {
      success: true,
      code: 200,
      message: "Pin reset requests fetched",
      data: {
        requests,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    };
  } catch (error) {
    console.error("get_pin_reset_requests error:", error);
    return { success: false, code: 500, message: "Failed to fetch requests", data: null };
  }
};

// Dismiss a request without changing the PIN (status = rejected). Fulfilment
// (status = accepted) happens inside admin_set_user_password_pin.
const resolve_pin_reset_request = async (id: string, status: RequestStatusType, admin_id: string) => {
  try {
    const [row] = await db
      .update(pin_reset_request_model)
      .set({ status, resolved_by: admin_id, resolved_at: new Date() })
      .where(eq(pin_reset_request_model.id, id))
      .returning({ id: pin_reset_request_model.id });

    if (!row) {
      return { success: false, code: 404, message: "Request not found", data: null };
    }
    return { success: true, code: 200, message: "Request resolved", data: { id } };
  } catch (error) {
    console.error("resolve_pin_reset_request error:", error);
    return { success: false, code: 500, message: "Failed to resolve request", data: null };
  }
};

export { raise_pin_reset_request, get_pin_reset_requests, resolve_pin_reset_request };
