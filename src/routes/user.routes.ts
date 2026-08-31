import { Elysia, t } from "elysia";
import { get_available_users, get_user_details, update_user_details, update_profile_image, change_own_phone_number } from "@/services/user.services";
import { get_all_users } from "@/services/user.services";
import { set_user_pin, verify_pin } from "@/services/pin.service";
import { generate_otp, verify_otp } from "@/services/otp.services";
import { OTP_CHANNELS } from "@/services/otp-providers";
import { parse_phone } from "@/utils/general.utils";
import { check_actor_send_allowed, register_actor_send } from "@/services/otp-rate-limit.service";
import db from "@/config/db";
import { user_model, signup_request_model } from "@/models/user.model";
import { eq, and, ne } from "drizzle-orm";
import { record_admin_pin_event } from "@/services/admin-pin-event.service";
import { raise_pin_reset_request } from "@/services/pin-reset.service";
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
    // SECURITY: this is a SELF-update (store.id). A user must NOT be able to change
    // their own `role` (privilege escalation → the JWT role is re-read from the DB on
    // the next mint) or `phone` (account takeover, no verification) here. Both are
    // admin-only mutations (/admin/update-user-role, /admin/user/update-phone-number),
    // so strip them before the mass-assign regardless of what the body carried.
    const { role: _role, phone: _phone, ...safe } = body;
    void _role; void _phone;
    const user_Details = await update_user_details(store.id, safe);
    set.status = user_Details.code;
    return user_Details;
  },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        // `phone`/`role` are accepted by the schema for backward-compat but are
        // STRIPPED in the handler above — a self-update can never set them.
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

  // App-lock: send an OTP to the caller's OWN registered number, scoped to
  // `admin_pin`. Step 1 of turning App Lock on — the code is then passed to
  // /user/set-pin alongside the chosen admin PIN, which is where it is spent.
  //
  // The number is read from the token's user row, never from the request body, so
  // this endpoint cannot be used to send a code to an arbitrary phone.
  .post("/generate-pin-otp", async ({ set, store, body }) => {
    const [user] = await db
      .select({ phone: user_model.phone })
      .from(user_model)
      .where(eq(user_model.id, store.id))
      .limit(1);

    if (!user?.phone) {
      set.status = 400;
      return { success: false, code: 400, message: "This account has no phone number." };
    }

    const result = await generate_otp(user.phone, "admin_pin", body?.channel ?? "whatsapp");
    set.status = result.code;
    return result;
  },
    {
      body: t.Optional(
        t.Object({
          channel: t.Optional(t.Union(OTP_CHANNELS.map((c) => t.Literal(c)))),
        })
      ),
    }
  )

  // Set or update a security PIN (authenticated). kind = "password" | "admin".
  // Authorization, in order of precedence:
  //   - `otp`         a fresh `admin_pin` code for this account's phone. Used by the
  //                   App Lock setup flow; also the recovery path for a FORGOTTEN
  //                   admin PIN, since it needs no prior PIN knowledge.
  //   - `current_pin` the PASSWORD PIN (for BOTH kinds) — so a forgotten admin PIN
  //                   is also recoverable by proving the login PIN.
  //   - neither       only when the target PIN is not set yet.
  // Used by the Settings PIN rows and the App Lock enable flow.
  .post("/set-pin", async ({ set, store, body }) => {
    const result = await set_user_pin(store.id, body.kind, body.pin, body.current_pin, body.otp);
    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        kind: t.Union([t.Literal("password"), t.Literal("admin")]),
        pin: t.String({ pattern: "^\\d{4}$" }),
        current_pin: t.Optional(t.String({ pattern: "^\\d{4}$" })),
        otp: t.Optional(t.Number()),
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
  )

  // ── Self-serve phone-number change ────────────────────────────────────────
  // Step 1 of 2: send an OTP to the number the user wants to MOVE TO.
  //
  // Why this is not part of /update-user: that handler deliberately STRIPS
  // `phone`, because an unverified self-assignment of an arbitrary number is an
  // account-takeover primitive. The verification is what buys the privilege
  // back, so it lives on its own pair of endpoints.
  //
  // Nothing is written here — the OTP is the only side effect. The account is
  // not moved until /confirm-phone-change.
  .post("/request-phone-change", async ({ set, store, body }) => {
    // Per-ACTOR throttle. generate_otp's own limiter is keyed by TARGET number,
    // so it does nothing here: every fresh number the caller names arrives with
    // a fresh quota, which would turn an authenticated session into a way to
    // send paid messages to arbitrary numbers.
    const actor_gate = await check_actor_send_allowed(store.id);
    if (!actor_gate.allowed) {
      set.status = actor_gate.code;
      return {
        success: false,
        code: actor_gate.code,
        message: actor_gate.message,
        retry_after: actor_gate.retry_after,
      };
    }

    const parsed = parse_phone(body.phone);
    if (!parsed.country || !parsed.valid) {
      set.status = 400;
      return {
        success: false,
        code: 400,
        message:
          "Invalid phone number. Please enter your number without the country code in the number field.",
      };
    }
    const canonical_phone = parsed.e164;

    const [me] = await db
      .select({ phone: user_model.phone })
      .from(user_model)
      .where(eq(user_model.id, store.id))
      .limit(1);

    if (me?.phone === canonical_phone) {
      set.status = 400;
      return {
        success: false,
        code: 400,
        message: "This is already your current number.",
      };
    }

    // Courtesy pre-check so the user finds out BEFORE spending an OTP (and
    // before typing it). It races by nature — the authority is the unique index
    // at confirm time, which is where a collision is actually caught.
    const [taken] = await db
      .select({ id: user_model.id })
      .from(user_model)
      .where(and(eq(user_model.phone, canonical_phone), ne(user_model.id, store.id)))
      .limit(1);

    if (taken) {
      set.status = 409;
      return {
        success: false,
        code: 409,
        message: "That phone number is already in use by another account.",
      };
    }

    // A pending signup request for the same number would collide on the users
    // unique index the moment an admin approved it, stranding that signup with
    // no obvious cause. Cheaper to refuse the move now.
    const [pending_signup] = await db
      .select({ id: signup_request_model.id })
      .from(signup_request_model)
      .where(
        and(
          eq(signup_request_model.phone, canonical_phone),
          eq(signup_request_model.status, "pending"),
        ),
      )
      .limit(1);

    if (pending_signup) {
      set.status = 409;
      return {
        success: false,
        code: 409,
        message: "That phone number has a signup request pending. Please contact support.",
      };
    }

    const result = await generate_otp(canonical_phone, "phone_change", body.channel ?? "whatsapp");
    // Count it only once the provider actually took the message, so a delivery
    // failure doesn't cost the user their quota.
    if (result.success) await register_actor_send(store.id);

    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        phone: t.String(),
        channel: t.Optional(t.Union(OTP_CHANNELS.map((c) => t.Literal(c)))),
      }),
    }
  )

  // Step 2 of 2: spend the OTP and move the account onto the new number.
  //
  // TWO factors, both required (when the account has a PIN):
  //   - `otp` proves the caller RECEIVES messages at the new number.
  //   - `pin` proves the caller owns the account, not merely an unlocked handset.
  //
  // Only a PASSWORD-PIN match is accepted. The ADMIN pin is the duress/camouflage
  // decoy (see app_lock) — someone coerced into opening the fake app must not be
  // able to walk the real account onto a number they control.
  .post("/confirm-phone-change", async ({ set, store, body }) => {
    const parsed = parse_phone(body.phone);
    if (!parsed.country || !parsed.valid) {
      set.status = 400;
      return { success: false, code: 400, message: "Invalid phone number." };
    }
    const canonical_phone = parsed.e164;

    // The PIN gate is conditional because the mandatory create-PIN gate was
    // ejected — accounts with no password PIN still exist, and for those the OTP
    // to the new number is the whole of the proof.
    const [me] = await db
      .select({ password_pin_hash: user_model.password_pin_hash })
      .from(user_model)
      .where(eq(user_model.id, store.id))
      .limit(1);

    if (!me) {
      set.status = 404;
      return { success: false, code: 404, message: "User not found" };
    }

    if (me.password_pin_hash) {
      if (!body.pin) {
        set.status = 400;
        return { success: false, code: 400, message: "Your login PIN is required." };
      }
      // verify_pin carries the per-number brute-force lockout.
      const pin_result = await verify_pin(store.id, body.pin);
      if (!pin_result.success) {
        set.status = pin_result.code;
        return pin_result;
      }
      if (pin_result.data?.match !== "password") {
        set.status = 401;
        return { success: false, code: 401, message: "Incorrect PIN." };
      }
    }

    // Scoped verify: a login / pin_reset / admin_pin code must not spend here.
    const otp_result = await verify_otp(body.otp, canonical_phone, "phone_change");
    if (!otp_result.success) {
      set.status = otp_result.code;
      return otp_result;
    }

    const result = await change_own_phone_number(store.id, canonical_phone);
    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        phone: t.String(),
        otp: t.Number(),
        pin: t.Optional(t.String({ pattern: "^\\d{4}$" })),
      }),
    }
  )

  // Forgot-PIN: raise a request for an admin to reset this user's login PIN.
  // Identity comes from the token (can't be spoofed); idempotent (one pending
  // request per user). Used by Settings → Security. No body.
  .post("/request-pin-reset", async ({ set, store }) => {
    const result = await raise_pin_reset_request(store.id);
    set.status = result.code;
    return result;
  });

export default user_routes;
