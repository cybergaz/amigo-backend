// Admin-PIN usage (camouflage / duress) history.
//   - record_admin_pin_event: called by the app when a user unlocks with the
//     admin PIN. Idempotent on the client-provided id (retries don't duplicate).
//   - get_admin_pin_events: super-admin list, joined with users for name/phone.
//   - delete_admin_pin_event: super-admin "resolve" — hard-delete a handled row.
import db from "@/config/db";
import { admin_pin_event_model } from "@/models/admin-pin-event.model";
import { user_model } from "@/models/user.model";
import { eq, desc, sql } from "drizzle-orm";

const record_admin_pin_event = async (args: {
  id: string;
  user_id: string;
  device_id?: string;
  device_name?: string;
  platform?: string;
  occurred_at?: string; // client UTC ISO — the real time the admin PIN was used
}) => {
  try {
    await db
      .insert(admin_pin_event_model)
      .values({
        id: args.id,
        user_id: args.user_id,
        device_id: args.device_id,
        device_name: args.device_name,
        platform: args.platform,
        // Keep the real occurrence time so a retried (offline→online) send is
        // recorded at when it happened, not when it reached the server.
        created_at: args.occurred_at ? new Date(args.occurred_at) : new Date(),
      })
      .onConflictDoNothing({ target: admin_pin_event_model.id });

    return { success: true, code: 200, message: "Event recorded" };
  } catch (error) {
    console.error("record_admin_pin_event error:", error);
    return { success: false, code: 500, message: "Failed to record event" };
  }
};

const get_admin_pin_events = async (page: number = 1, limit: number = 20) => {
  try {
    const offset = (page - 1) * limit;

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(admin_pin_event_model);
    const totalCount = Number(count);

    const events = await db
      .select({
        id: admin_pin_event_model.id,
        user_id: admin_pin_event_model.user_id,
        name: user_model.name,
        phone: user_model.phone,
        device_id: admin_pin_event_model.device_id,
        device_name: admin_pin_event_model.device_name,
        platform: admin_pin_event_model.platform,
        created_at: admin_pin_event_model.created_at,
      })
      .from(admin_pin_event_model)
      .leftJoin(user_model, eq(admin_pin_event_model.user_id, user_model.id))
      .orderBy(desc(admin_pin_event_model.created_at))
      .limit(limit)
      .offset(offset);

    const totalPages = Math.ceil(totalCount / limit);
    return {
      success: true,
      code: 200,
      message: "Admin PIN events fetched",
      data: {
        events,
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
    console.error("get_admin_pin_events error:", error);
    return { success: false, code: 500, message: "Failed to fetch events", data: null };
  }
};

const delete_admin_pin_event = async (id: string) => {
  try {
    const deleted = await db
      .delete(admin_pin_event_model)
      .where(eq(admin_pin_event_model.id, id))
      .returning({ id: admin_pin_event_model.id });

    if (deleted.length === 0) {
      return { success: false, code: 404, message: "Event not found", data: null };
    }
    return { success: true, code: 200, message: "Event resolved", data: { id } };
  } catch (error) {
    console.error("delete_admin_pin_event error:", error);
    return { success: false, code: 500, message: "Failed to resolve event", data: null };
  }
};

export { record_admin_pin_event, get_admin_pin_events, delete_admin_pin_event };
