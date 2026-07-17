import Elysia, { t } from "elysia";
import { eq } from "drizzle-orm";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { app_middleware } from "@/middleware";
import { admin_create_user, admin_set_user_password_pin } from "@/services/user.services";
import { get_pin_reset_requests, resolve_pin_reset_request } from "@/services/pin-reset.service";

// Sub-admin user-management actions, exposed to the MOBILE app (role: sub_admin —
// and admin, harmlessly). Mirror of the panel's super-admin `/admin/*` endpoints but
// on a Bearer-authenticated group (app_middleware reads the Authorization header),
// gated to admin+sub_admin by the guard. Reuses the SAME services as `/admin/*` — no
// business logic is duplicated here.
//
// A wrong-role caller gets the guard's 403 (ROLE_FORBIDDEN auth_error). That is safe
// on mobile: the client force-logs-out ONLY on WS close 4003, never on a REST body
// (see auth_fatal.dart). The mobile UI also gates these behind role == sub_admin, so
// a plain user never reaches them.
const sub_admin_routes = new Elysia({ prefix: "/sub-admin" })
  .state({ id: "", role: "" })
  .guard({
    async beforeHandle({ cookie, set, store, headers }) {
      // Authenticate the token (any role), then gate on the LIVE DB role — NOT the
      // role baked into the token. The mobile device JWT lives up to 365 days and is
      // verified statelessly, so a demoted sub-admin's old token would otherwise keep
      // these write powers until expiry. Reading the current role also lets a freshly
      // PROMOTED sub-admin use these actions immediately (no re-login). Business 403
      // (no auth_error) so an unauthorized call never trips a logout.
      const state_result = app_middleware({ cookie, headers });
      set.status = state_result.code;
      if (!state_result.data) return state_result;

      const [row] = await db
        .select({ role: user_model.role })
        .from(user_model)
        .where(eq(user_model.id, state_result.data.id))
        .limit(1);

      if (!row || (row.role !== "admin" && row.role !== "sub_admin")) {
        set.status = 403;
        return { success: false, code: 403, message: "Not authorized for sub-admin actions", data: null };
      }

      store.id = state_result.data.id;
      store.role = row.role;
    },
  })

  // Create a new app user (phone + starter password PIN, flagged must_reset_pin).
  .post("/create-user", async ({ set, body }) => {
    const result = await admin_create_user({
      name: body.name,
      phone: body.phone,
      password_pin: body.password_pin,
    });
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      name: t.String(),
      phone: t.String(),
      password_pin: t.String({ pattern: "^\\d{4}$" }),
    }),
  })

  // List user-raised forgot-PIN requests (pending first). Optional `search` filters
  // by the requesting user's name/phone.
  .get("/pin-reset-requests", async ({ set, query }) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const status = (query.status as string) || undefined;
    const search = (query.search as string) || undefined;
    const result = await get_pin_reset_requests(page, limit, status, search);
    set.status = result.code;
    return result;
  })

  // Fulfil a request: set the user's new login PIN (re-flags must_reset_pin, clears
  // lockout, auto-accepts the pending request). `restrict_to_unprivileged` = true so a
  // sub-admin can never target an admin/sub_admin account (privilege-escalation guard).
  .post("/set-password-pin", async ({ set, store, body }) => {
    const result = await admin_set_user_password_pin(body.user_id, body.pin, store.id, true);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      user_id: t.String(),
      pin: t.String({ pattern: "^\\d{4}$" }),
    }),
  })

  // Dismiss/reject a request without changing the PIN.
  .post("/pin-reset-requests/:id/resolve", async ({ set, store, params, body }) => {
    const status = body?.status === "accepted" ? "accepted" : "rejected";
    const result = await resolve_pin_reset_request(params.id, status, store.id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      status: t.Optional(t.String()),
    }),
  });

export default sub_admin_routes;
