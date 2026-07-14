import { Elysia, t } from "elysia";
import { get_available_users, get_user_details, update_user_details, update_profile_image } from "@/services/user.services";
import { get_all_users } from "@/services/user.services";
import { set_user_pin, verify_pin } from "@/services/pin.service";
import { record_admin_pin_event } from "@/services/admin-pin-event.service";
import { app_middleware } from "@/middleware";
import { ROLE_CONST } from "@/types/user.types";
import FCMService from "@/services/fcm.service";

const user_routes = new Elysia({ prefix: "/user" })
  .state({ id: "", role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  .get("/get-user", async ({ set, store }) => {
    const user_Details = await get_user_details(store.id);
    set.status = user_Details.code;
    return user_Details;
  })

  .post("/update-user", async ({ set, store, body }) => {
    const user_Details = await update_user_details(store.id, body);
    set.status = user_Details.code;
    return user_Details;
  },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        role: t.Optional(t.Enum(Object.fromEntries(ROLE_CONST.map(x => [x, x])))),
        profile_pic: t.Optional(t.String()),
        location: t.Optional(t.Object({
          latitude: t.Number(),
          longitude: t.Number(),
        })),
        ip_address: t.Optional(t.String()),
        fcm_token: t.Optional(t.String()),
        app_version: t.Optional(t.String()),
      }),
    }
  )

  .get("/all-users", async ({ set }) => {
    try {
      const users = await get_all_users();
      set.status = users.code;
      return users;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
      };
    }
  })

  .post("/get-available-users", async ({ set, store, body }) => {
    const user_Details = await get_available_users(store.id, body.phone_numbers);
    set.status = user_Details.code;
    return user_Details;
  },
    {
      body: t.Object({
        phone_numbers: t.Array(t.String()),
      }),
    }
  )

  .post("/update-profile-image", async ({ set, store, body }) => {
    try {
      if (!body.image) {
        set.status = 400;
        return {
          success: false,
          message: "No image file provided",
        };
      }

      const result = await update_profile_image(store.id, body.image);
      set.status = result.code;
      return result;
    } catch (error: any) {
      console.error("Error in profile image upload route:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  },
    {
      body: t.Object({
        image: t.File({
          type: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
          maxSize: 5 * 1024 * 1024, // 5MB
        }),
      }),
    }
  )

  .post("/update-fcm-token", async ({ set, store, body }) => {
    const result = await FCMService.update_user_fcm_token(store.id, body.fcm_token);

    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        fcm_token: t.String(),
      }),
    }
  )

  // Set or update a security PIN (authenticated). kind = "password" | "admin".
  // First-time set needs no current_pin. Changing an already-set PIN requires
  // current_pin = the PASSWORD PIN (for BOTH kinds) — so a forgotten admin PIN is
  // recoverable by proving the password PIN.
  // Used by the Settings PIN rows and the enforcement create-PINs screen.
  .post("/set-pin", async ({ set, store, body }) => {
    const result = await set_user_pin(store.id, body.kind, body.pin, body.current_pin);
    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        kind: t.Union([t.Literal("password"), t.Literal("admin")]),
        pin: t.String({ pattern: "^\\d{4}$" }),
        current_pin: t.Optional(t.String({ pattern: "^\\d{4}$" })),
      }),
    }
  )

  // App-lock: check a candidate PIN against the account's stored hashes and return
  // { match: 'password' | 'admin' | null }. Used to ARM the on-device app-lock
  // verifier for camouflage. Business error only — carries no auth_error.
  .post("/verify-pin", async ({ set, store, body }) => {
    const result = await verify_pin(store.id, body.pin);
    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        pin: t.String({ pattern: "^\\d{4}$" }),
      }),
    }
  )

  // App-lock: record an ADMIN-PIN unlock (camouflage/duress). Fire-and-forget from
  // the app; idempotent on the client-provided `id` (retried offline sends won't
  // duplicate). Surfaced on the admin panel's Admin PIN Usage page.
  .post("/admin-pin-event", async ({ set, store, body }) => {
    const result = await record_admin_pin_event({
      id: body.id,
      user_id: store.id,
      device_id: body.device_id,
      device_name: body.device_name,
      platform: body.platform,
      occurred_at: body.occurred_at,
    });
    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        id: t.String(),
        device_id: t.Optional(t.String()),
        device_name: t.Optional(t.String()),
        platform: t.Optional(t.String()),
        occurred_at: t.Optional(t.String()),
      }),
    }
  );

export default user_routes;
