// Device-change requests + the single-device LOCK gate.
//
// The backend is already single-device, but destructively last-login-wins
// (login_device evicts the old device and mints for the new one). This module
// INVERTS that default: a *different* device is refused at login unless an admin
// approved a request for it. The refusal is a plain business error (never an
// auth_error) placed PRE-MINT, so a blocked attempt evicts nothing.
//
// Auto-logout of the old device needs NO new machinery: once an approved new
// device actually logs in, the existing login_device path evicts the old device
// row, deletes its redis authver key, and fires force_logout_other_devices.
import db from "@/config/db";
import { device_change_request_model } from "@/models/device-change-request.model";
import { auth_device_model } from "@/models/auth-device.model";
import { user_model } from "@/models/user.model";
import { get_single_device_lock } from "@/services/app-settings.service";
import { and, eq, ne, or, isNull, desc, sql } from "drizzle-orm";

// ─── The gate (called pre-mint from the login handlers) ──────────────────────

export type DeviceGateResult =
  | { allowed: true; approved_request_id: string | null }
  | {
      allowed: false;
      registered_device_name: string | null;
      pending_request_status: string | null;
    };

// May `device_id` complete a login for `user_id` under the single-device lock?
// - lock OFF                          → allowed (legacy last-login-wins).
// - no OTHER registered device        → allowed (first device / same-device relogin).
// - accepted + unconsumed request     → allowed (approved swap); returns its id so
//   the caller can consume it after the mint (single-use).
// - otherwise                         → refused, with context for the client.
export const is_device_allowed = async (
  user_id: string,
  device_id: string,
): Promise<DeviceGateResult> => {
  const lock = await get_single_device_lock();
  if (!lock.enabled) return { allowed: true, approved_request_id: null };

  const others = await db
    .select({ device_name: auth_device_model.device_name })
    .from(auth_device_model)
    .where(
      and(
        eq(auth_device_model.user_id, user_id),
        ne(auth_device_model.device_id, device_id),
      ),
    );

  if (others.length === 0) return { allowed: true, approved_request_id: null };

  // A different device owns the account. Only an admin-approved, unconsumed
  // request unlocks it: either one that names THIS device, or a wildcard
  // (requested_device_id IS NULL, i.e. requested from the old device).
  const [approved] = await db
    .select({ id: device_change_request_model.id })
    .from(device_change_request_model)
    .where(
      and(
        eq(device_change_request_model.user_id, user_id),
        eq(device_change_request_model.status, "accepted"),
        isNull(device_change_request_model.consumed_at),
        or(
          isNull(device_change_request_model.requested_device_id),
          eq(device_change_request_model.requested_device_id, device_id),
        ),
      ),
    )
    .limit(1);

  if (approved) return { allowed: true, approved_request_id: approved.id };

  const [latest] = await db
    .select({ status: device_change_request_model.status })
    .from(device_change_request_model)
    .where(eq(device_change_request_model.user_id, user_id))
    .orderBy(desc(device_change_request_model.created_at))
    .limit(1);

  return {
    allowed: false,
    registered_device_name: others[0]?.device_name ?? null,
    pending_request_status: latest?.status ?? null,
  };
};

// Stamp the approved request consumed after a successful approved-swap login, so
// the approval is single-use. No-op if the id is null.
export const consume_device_change_request = async (id: string | null): Promise<void> => {
  if (!id) return;
  try {
    await db
      .update(device_change_request_model)
      .set({ consumed_at: new Date() })
      .where(
        and(
          eq(device_change_request_model.id, id),
          isNull(device_change_request_model.consumed_at),
        ),
      );
  } catch (error) {
    // Non-fatal: the login already succeeded; worst case the approval could be
    // reused, but the device is now the registered device so the gate passes it
    // via the same-device path anyway.
    console.error("consume_device_change_request error:", error);
  }
};

// ─── Requests (user-facing) ──────────────────────────────────────────────────

type CreateArgs = {
  user_id: string;
  requested_device_id?: string | null;
  device_name?: string;
  platform?: string;
  reason?: string;
};

// Create (or replace the pending) device-change request for a user. Populates the
// "device being replaced" fields from auth_devices for admin context.
export const create_device_change_request = async (args: CreateArgs) => {
  try {
    // If an approval is already waiting, don't open a new request — tell the
    // client to just log in on the new device.
    const [accepted] = await db
      .select({ id: device_change_request_model.id })
      .from(device_change_request_model)
      .where(
        and(
          eq(device_change_request_model.user_id, args.user_id),
          eq(device_change_request_model.status, "accepted"),
          isNull(device_change_request_model.consumed_at),
        ),
      )
      .limit(1);
    if (accepted) {
      return {
        success: true,
        code: 200,
        message: "A device change has already been approved. Log in on the new device.",
        data: { id: accepted.id, status: "accepted" as const },
      };
    }

    // The device being replaced = the user's registered device that ISN'T the
    // one requesting (for the new-device flow); for the old-device wildcard flow
    // it's just their current device.
    const [current] = await db
      .select({
        device_id: auth_device_model.device_id,
        device_name: auth_device_model.device_name,
      })
      .from(auth_device_model)
      .where(
        and(
          eq(auth_device_model.user_id, args.user_id),
          args.requested_device_id
            ? ne(auth_device_model.device_id, args.requested_device_id)
            : sql`true`,
        ),
      )
      .orderBy(desc(auth_device_model.last_seen_at))
      .limit(1);

    const fields = {
      current_device_id: current?.device_id ?? null,
      current_device_name: current?.device_name ?? null,
      requested_device_id: args.requested_device_id ?? null,
      device_name: args.device_name,
      platform: args.platform,
      reason: args.reason,
    };

    // One open request per user — replace an existing pending row.
    const [existing] = await db
      .select({ id: device_change_request_model.id })
      .from(device_change_request_model)
      .where(
        and(
          eq(device_change_request_model.user_id, args.user_id),
          eq(device_change_request_model.status, "pending"),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(device_change_request_model)
        .set({ ...fields, created_at: new Date() })
        .where(eq(device_change_request_model.id, existing.id));
      return {
        success: true,
        code: 200,
        message: "Device change request updated",
        data: { id: existing.id, status: "pending" as const },
      };
    }

    const [row] = await db
      .insert(device_change_request_model)
      .values({ user_id: args.user_id, ...fields })
      .returning({ id: device_change_request_model.id });

    return {
      success: true,
      code: 200,
      message: "Device change request submitted",
      data: { id: row.id, status: "pending" as const },
    };
  } catch (error) {
    console.error("create_device_change_request error:", error);
    return { success: false, code: 500, message: "Failed to submit request", data: null };
  }
};

// The user's latest request status (for polling from the request screen).
export const get_device_change_status = async (user_id: string) => {
  try {
    const [row] = await db
      .select({
        id: device_change_request_model.id,
        status: device_change_request_model.status,
        requested_device_id: device_change_request_model.requested_device_id,
        device_name: device_change_request_model.device_name,
        review_note: device_change_request_model.review_note,
        reviewed_at: device_change_request_model.reviewed_at,
        consumed_at: device_change_request_model.consumed_at,
        created_at: device_change_request_model.created_at,
      })
      .from(device_change_request_model)
      .where(eq(device_change_request_model.user_id, user_id))
      .orderBy(desc(device_change_request_model.created_at))
      .limit(1);

    return {
      success: true,
      code: 200,
      message: row ? "Latest device change request" : "No device change request",
      data: row ?? null,
    };
  } catch (error) {
    console.error("get_device_change_status error:", error);
    return { success: false, code: 500, message: "Failed to fetch status", data: null };
  }
};

// ─── Admin ───────────────────────────────────────────────────────────────────

export const get_device_change_requests = async (
  page: number = 1,
  limit: number = 20,
  status?: string,
) => {
  try {
    const offset = (page - 1) * limit;
    const where = status
      ? eq(device_change_request_model.status, status as "pending" | "accepted" | "rejected")
      : undefined;

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(device_change_request_model)
      .where(where);
    const totalCount = Number(count);

    const requests = await db
      .select({
        id: device_change_request_model.id,
        user_id: device_change_request_model.user_id,
        name: user_model.name,
        phone: user_model.phone,
        current_device_id: device_change_request_model.current_device_id,
        current_device_name: device_change_request_model.current_device_name,
        requested_device_id: device_change_request_model.requested_device_id,
        device_name: device_change_request_model.device_name,
        platform: device_change_request_model.platform,
        reason: device_change_request_model.reason,
        status: device_change_request_model.status,
        review_note: device_change_request_model.review_note,
        reviewed_at: device_change_request_model.reviewed_at,
        consumed_at: device_change_request_model.consumed_at,
        created_at: device_change_request_model.created_at,
      })
      .from(device_change_request_model)
      .leftJoin(user_model, eq(device_change_request_model.user_id, user_model.id))
      .where(where)
      .orderBy(desc(device_change_request_model.created_at))
      .limit(limit)
      .offset(offset);

    const totalPages = Math.ceil(totalCount / limit);
    return {
      success: true,
      code: 200,
      message: "Device change requests fetched",
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
    console.error("get_device_change_requests error:", error);
    return { success: false, code: 500, message: "Failed to fetch requests", data: null };
  }
};

// Approve: flip to accepted. NO device-swap side-effect is needed here — the old
// device is evicted + logged-out automatically the moment the approved new device
// completes login (via the existing login_device path). Only pending → accepted.
export const approve_device_change_request = async (id: string, admin_id: string) => {
  try {
    const [row] = await db
      .update(device_change_request_model)
      .set({ status: "accepted", reviewed_by: admin_id, reviewed_at: new Date() })
      .where(
        and(
          eq(device_change_request_model.id, id),
          eq(device_change_request_model.status, "pending"),
        ),
      )
      .returning({ id: device_change_request_model.id });

    if (!row) {
      return {
        success: false,
        code: 404,
        message: "Request not found or already reviewed",
        data: null,
      };
    }
    return { success: true, code: 200, message: "Device change approved", data: { id } };
  } catch (error) {
    console.error("approve_device_change_request error:", error);
    return { success: false, code: 500, message: "Failed to approve request", data: null };
  }
};

export const deny_device_change_request = async (
  id: string,
  admin_id: string,
  reason?: string,
) => {
  try {
    const [row] = await db
      .update(device_change_request_model)
      .set({
        status: "rejected",
        reviewed_by: admin_id,
        reviewed_at: new Date(),
        review_note: reason,
      })
      .where(
        and(
          eq(device_change_request_model.id, id),
          eq(device_change_request_model.status, "pending"),
        ),
      )
      .returning({ id: device_change_request_model.id });

    if (!row) {
      return {
        success: false,
        code: 404,
        message: "Request not found or already reviewed",
        data: null,
      };
    }
    return { success: true, code: 200, message: "Device change denied", data: { id } };
  } catch (error) {
    console.error("deny_device_change_request error:", error);
    return { success: false, code: 500, message: "Failed to deny request", data: null };
  }
};
