import db from "@/config/db";
import { authenticate_jwt } from "@/middleware";
import { user_model } from "@/models/user.model";
import { create_signup_request, get_signup_request_status, handle_login, handle_login_device, handle_login_pin, handle_refresh_token, handle_refresh_token_mobile, validate_refresh_token } from "@/services/auth.service";
import { revoke_user_sessions } from "@/services/session.service";
import { generate_otp, verify_otp } from "@/services/otp.services";
import { OTP_CHANNELS } from "@/services/otp-providers";
import { get_phone_pin_status, reset_password_pin } from "@/services/pin.service";
import { raise_pin_reset_request } from "@/services/pin-reset.service";
import { create_user, find_user_by_phone } from "@/services/user.services";
import { to_e164 } from "@/utils/general.utils";
import { VerifySignupSchema } from "@/types/auth.types";
import Elysia, { t } from "elysia";
import { eq, sql } from "drizzle-orm";
import { remove_fcm_token } from "@/cache-management/fcm-token.cache";

// Cookie configuration based on environment
// Use COOKIE_DOMAIN env var or detect production from FRONTEND_URL
const isProduction = process.env.FRONTEND_URL?.includes("amigochats.com") ||
  process.env.COOKIE_DOMAIN === ".amigochats.com" ||
  process.env.NODE_ENV === "production";

const COOKIE_DOMAIN = isProduction ? ".amigochats.com" : undefined;

// console.log(`🍪 Cookie Config: isProduction=${isProduction} | COOKIE_DOMAIN=${COOKIE_DOMAIN || 'not set'} | FRONTEND_URL=${process.env.FRONTEND_URL}`);

// Helper function to detect if request is from mobile app
function isMobileApp(userAgent?: string): boolean {
  if (!userAgent) return false;
  return userAgent.toLowerCase().includes('amigo-mobile-app') ||
    userAgent.toLowerCase().includes('dart') ||
    userAgent.toLowerCase().includes('flutter');
}

// Helper function to get cookie config based on client type
function getCookieConfig(userAgent?: string) {
  const isMobile = isMobileApp(userAgent);

  // For mobile apps, don't set domain to allow cookies to work with any URL
  if (isMobile) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: "none" as const,
      path: "/",
      // No domain for mobile apps - allows cookies to work with IP or domain
    };
  }

  // For web apps, use the configured domain
  return {
    httpOnly: true,
    secure: true,
    sameSite: "none" as const,
    path: "/",
    ...(COOKIE_DOMAIN && { domain: COOKIE_DOMAIN }),
  };
}

// Which transport carries the code. WhatsApp is the default everywhere; SMS is
// offered for Indian numbers only and is REJECTED server-side for anything else
// (see is_channel_allowed) — the client hiding the option is a convenience, not
// the enforcement.
const ChannelSchema = t.Optional(
  t.Object({
    channel: t.Optional(t.Union(OTP_CHANNELS.map((c) => t.Literal(c)))),
  })
);

const auth_routes = new Elysia({ prefix: "/auth" })
  .post("/generate-signup-otp/:phone", async ({ set, params, body }) => {
    const existing_user_res = await find_user_by_phone(to_e164(params.phone));
    if (existing_user_res.success) {
      set.status = 409;
      return {
        success: false,
        code: 409,
        message: "User already exists with this phone number.",
      };
    }

    const otp_res = await generate_otp(params.phone, "signup", body?.channel ?? "whatsapp");

    set.status = otp_res.code;
    return otp_res;
  },
    {
      params: t.Object({
        phone: t.String(),
      }),
      body: ChannelSchema,
    }
  )

  .post("/generate-login-otp/:phone", async ({ set, params, body }) => {
    const existing_user_res = await find_user_by_phone(to_e164(params.phone));
    if (!existing_user_res?.success) {
      set.status = existing_user_res?.code;
      return existing_user_res;
    }

    const otp_res = await generate_otp(params.phone, "login", body?.channel ?? "whatsapp");

    set.status = otp_res.code;
    return otp_res;
  },
    {
      params: t.Object({
        phone: t.String(),
      }),
      body: ChannelSchema,
    }
  )

  // Forgot-PIN, step 1: send a code scoped to `pin_reset`. The scoping is the
  // point — this code CANNOT be replayed against verify-login-otp to obtain a
  // session, so a reset flow can never be turned into a login bypass.
  //
  // Mirrors generate-login-otp's 404-on-unknown-number. That is an existence
  // oracle, but an identical one already exists on generate-login-otp and
  // phone-status, and the app reaches this screen only after phone-status has
  // already answered the same question — closing it here alone would change
  // nothing.
  .post("/generate-reset-otp/:phone", async ({ set, params, body }) => {
    const existing_user_res = await find_user_by_phone(to_e164(params.phone));
    if (!existing_user_res?.success) {
      set.status = existing_user_res?.code ?? 404;
      return existing_user_res;
    }

    const otp_res = await generate_otp(params.phone, "pin_reset", body?.channel ?? "whatsapp");

    set.status = otp_res.code;
    return otp_res;
  },
    {
      params: t.Object({
        phone: t.String(),
      }),
      body: ChannelSchema,
    }
  )

  // TEMP-PIN-ENFORCEMENT
  // Login precheck: { exists, has_pin } → app asks for a PIN when has_pin, else
  // falls back to OTP login (pre-PIN users). Public, mirrors the existing
  // generate-login-otp existence leak.
  .get("/phone-status/:phone", async ({ set, params }) => {
    const res = await get_phone_pin_status(params.phone);
    set.status = res.code;
    return res;
  },
    {
      params: t.Object({
        phone: t.String(),
      }),
    }
  )

  .post("/verify-signup-otp", async ({ body, set, cookie, headers }) => {
    const { phone, name, password, role, otp } = body;

    const otpResponse = await verify_otp(otp, phone, "signup");
    if (otpResponse.success == false) {
      set.status = otpResponse.code;
      return otpResponse;
    }

    const create_user_res = await create_user({
      name,
      password,
      role,
      phone,
      password_pin: body.password_pin, // login PIN set during mobile signup
      ...(body.device_id
        ? { device: { device_id: body.device_id, platform: body.platform, device_name: body.device_name } }
        : {}),
    });
    if (!create_user_res?.success) {
      set.status = create_user_res?.code;
      return create_user_res;
    }

    // on successful user creation
    set.status = create_user_res.code;
    if (
      create_user_res.success &&
      create_user_res.data?.refresh_token &&
      create_user_res.data?.access_token
    ) {
      const userAgent = headers['user-agent'];
      const cookieConfig = getCookieConfig(userAgent);

      cookie["refresh_token"].set({
        value: create_user_res.data.refresh_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24 * 30,
      });
      cookie["access_token"].set({
        value: create_user_res.data.access_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24,
      });
      console.log(
        `[SERVER]   Set Tokens to Cookies (${isMobileApp(userAgent) ? 'Mobile' : 'Web'}) : ${new Date().toLocaleString()}`
      );
    }

    return create_user_res;
  },
    { body: VerifySignupSchema }
  )

  .post("/request-signup", async ({ body, set }) => {
    const { name, phone } = body;

    const signup_request_res = await create_signup_request({ name, phone });
    if (!signup_request_res?.success) {
      set.status = signup_request_res?.code;
      return signup_request_res;
    }
    set.status = signup_request_res.code;
    return signup_request_res;
  },
    {
      body: t.Object({
        name: t.String(),
        phone: t.String(),
      }),
    }
  )

  .get('/signup-request-status/:phone', async ({ set, params }) => {

    const signup_request_status_res = await get_signup_request_status(params.phone);
    set.status = signup_request_status_res.code;
    return signup_request_status_res;
  },
    {
      params: t.Object({
        phone: t.String(),
      }),
    }
  )

  .post("/verify-login-otp", async ({ body, set, cookie, headers }) => {

    // For testing purposes, allow OTP bypass for specific test numbers
    if (!body.phone.startsWith("+91100100100")) {
      const otpResponse = await verify_otp(body.otp, body.phone, "login");

      if (!otpResponse.success) {
        set.status = otpResponse.code;
        return otpResponse;
      }
    }

    // Mobile single-token flow (OTP already verified above): mint the long-lived
    // device JWT into the BODY, set NO cookies. Gated purely on device_id presence.
    if (body.device_id) {
      const device_login_res = await handle_login_device({
        phone: body.phone,
        device: {
          device_id: body.device_id,
          platform: body.platform,
          device_name: body.device_name,
        },
      });
      set.status = device_login_res.code;
      return device_login_res;
    }

    const login_res = await handle_login({ phone: body.phone });
    if (login_res.success == false) {
      set.status = login_res.code;
      return login_res;
    }

    if (
      login_res.success &&
      login_res.data?.refresh_token &&
      login_res.data?.access_token
    ) {
      const userAgent = headers['user-agent'];
      const cookieConfig = getCookieConfig(userAgent);

      cookie["refresh_token"].set({
        value: login_res.data.refresh_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24 * 30,
      });
      cookie["access_token"].set({
        value: login_res.data.access_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24 * 7,
      });
      console.log(`[SERVER]   Set Tokens to Cookies (${isMobileApp(userAgent) ? 'Mobile' : 'Web'}) : ${new Date().toLocaleString()}`);
    }

    set.status = login_res.code;
    return login_res;
  },
    {
      body: t.Object({
        phone: t.String(),
        otp: t.Number(),
        device_id: t.Optional(t.String()),
        platform: t.Optional(t.String()),
        device_name: t.Optional(t.String()),
      }),
    }
  )

  // Phone + 4-digit PIN login (mobile). device_id required — this rides the same
  // single-device durable-token mint as OTP login (handle_login_pin → login_device).
  // Failure responses (401 wrong PIN / 403 no PIN / 429 locked) carry NO auth_error,
  // so they can never force-logout the client.
  .post("/login-pin", async ({ body, set }) => {
    if (!body.device_id) {
      set.status = 400;
      return { success: false, code: 400, message: "device_id is required for PIN login" };
    }
    const res = await handle_login_pin({
      phone: to_e164(body.phone),
      pin: body.pin,
      device: {
        device_id: body.device_id,
        platform: body.platform,
        device_name: body.device_name,
      },
    });
    set.status = res.code;
    return res;
  },
    {
      body: t.Object({
        phone: t.String(),
        pin: t.String({ pattern: "^\\d{4}$" }),
        device_id: t.String(),
        platform: t.Optional(t.String()),
        device_name: t.Optional(t.String()),
      }),
    }
  )

  // Forgot-PIN, step 2 (unauthenticated): spend the `pin_reset` code and set a new
  // login PIN. This is the PRIMARY recovery path — /auth/request-pin-reset below
  // stays as the fallback for a user who can no longer receive a code on their
  // registered number (lost SIM, no WhatsApp), and for admin-created accounts.
  //
  // Deliberately returns NO session: a successful reset means "log in with your new
  // PIN", not "you are logged in". Keeps the reset flow entirely outside the token
  // mint, so it cannot become a login bypass.
  .post("/reset-pin", async ({ body, set }) => {
    const res = await reset_password_pin(body.phone, body.otp, body.new_pin);
    set.status = res.code;
    return res;
  },
    {
      body: t.Object({
        phone: t.String(),
        otp: t.Number(),
        new_pin: t.String({ pattern: "^\\d{4}$" }),
      }),
    }
  )

  // Forgot-PIN (unauthenticated, from the login screen): raise a request for an
  // admin to reset this phone's login PIN. Returns a GENERIC success regardless of
  // whether the number is registered (no account-enumeration oracle); idempotent
  // server-side (one pending request per user).
  .post("/request-pin-reset", async ({ body, set }) => {
    const user_res = await find_user_by_phone(to_e164(body.phone));
    if (user_res.success && user_res.data?.id) {
      await raise_pin_reset_request(user_res.data.id);
    }
    set.status = 200;
    return {
      success: true,
      code: 200,
      message: "If this number is registered, your reset request has been sent to the admin.",
    };
  },
    {
      body: t.Object({
        phone: t.String(),
      }),
    }
  )

  .post("/verify-email-login", async ({ body, set, cookie, headers }) => {
    const userAgent = headers['user-agent'];
    console.log(`[LOGIN] Attempt from origin: ${headers.origin || 'N/A'} | User-Agent: ${userAgent} | Client: ${isMobileApp(userAgent) ? 'Mobile' : 'Web'}`);

    const login_res = await handle_login({ email: body.email, password: body.password });
    if (login_res.success == false) {
      set.status = login_res.code;
      console.log(`[LOGIN] Failed: ${login_res.message}`);
      return login_res;
    }

    if (
      login_res.success &&
      login_res.data?.refresh_token &&
      login_res.data?.access_token
    ) {
      const cookieConfig = getCookieConfig(userAgent);

      cookie["refresh_token"].set({
        value: login_res.data.refresh_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24 * 7,
      });

      cookie["access_token"].set({
        value: login_res.data.access_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24,
      });
      console.log(
        `[LOGIN] ✅ Success! Set cookies for ${isMobileApp(userAgent) ? 'Mobile App' : 'Web (domain: ' + (COOKIE_DOMAIN || 'default') + ')'} | User: ${login_res.data.email}`
      );
    }

    set.status = login_res.code;
    return login_res;
  },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    }
  )

  .post("/refresh", async ({ cookie, set, headers }) => {
    const existing_token = cookie["refresh_token"].value;
    if (!existing_token) {

      const userAgent = headers['user-agent'];
      const cookieConfig = getCookieConfig(userAgent);

      cookie["refresh_token"].set({
        value: "",
        ...cookieConfig,
        maxAge: 0,
      });
      cookie["access_token"].set({
        value: "",
        ...cookieConfig,
        maxAge: 0,
      });

      set.status = 404;
      return {
        success: false,
        code: 404,
        message: "No Refresh Token in Cookies",
      };
    }

    const info = authenticate_jwt(existing_token as string);
    if (!info.success || !info.data?.id) {

      const userAgent = headers['user-agent'];
      const cookieConfig = getCookieConfig(userAgent);

      cookie["refresh_token"].set({
        value: "",
        ...cookieConfig,
        maxAge: 0,
      });
      cookie["access_token"].set({
        value: "",
        ...cookieConfig,
        maxAge: 0,
      });

      set.status = info.code;
      return info;
    }

    const refresh_res = await handle_refresh_token(existing_token as string);

    if (!refresh_res.success) {
      const userAgent = headers['user-agent'];
      const cookieConfig = getCookieConfig(userAgent);

      cookie["refresh_token"].set({
        value: "",
        ...cookieConfig,
        maxAge: 0,
      });
      cookie["access_token"].set({
        value: "",
        ...cookieConfig,
        maxAge: 0,
      });

      set.status = refresh_res.code;
      return refresh_res;
    }

    if (
      refresh_res.success &&
      refresh_res.data?.refresh_token &&
      refresh_res.data?.access_token
    ) {
      const userAgent = headers['user-agent'];
      const cookieConfig = getCookieConfig(userAgent);

      cookie["refresh_token"].set({
        value: refresh_res.data.refresh_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24 * 7,
      });
      cookie["access_token"].set({
        value: refresh_res.data.access_token,
        ...cookieConfig,
        maxAge: 60 * 60 * 24,
      });
    }

    set.status = refresh_res.code;
    return refresh_res;
  })

  .post("/refresh-mobile", async ({ cookie, set }) => {

    const existing_token = cookie["refresh_token"].value;
    if (!existing_token) {
      set.status = 404;
      return {
        success: false,
        code: 404,
        message: "No Refresh Token in Cookies",
      };
    }

    const info = authenticate_jwt(existing_token as string);
    if (!info.success || !info.data?.id) {
      set.status = info.code;
      return info;
    }

    const refresh_res = await handle_refresh_token_mobile(existing_token as string);

    if (!refresh_res.success) {
      set.status = refresh_res.code;
      return refresh_res;
    }

    if (
      refresh_res.success &&
      refresh_res.data?.refresh_token &&
      refresh_res.data?.access_token
    ) {
      cookie["refresh_token"].set({
        value: refresh_res.data.refresh_token,
        httpOnly: true,
        secure: true,
        sameSite: "none" as const,
        maxAge: 60 * 60 * 24 * 30,
        path: "/",
        ...(COOKIE_DOMAIN && { domain: COOKIE_DOMAIN }),
      });
      cookie["access_token"].set({
        value: refresh_res.data.access_token,
        httpOnly: true,
        secure: true,
        sameSite: "none" as const,
        maxAge: 60 * 60 * 24,
        path: "/",
        ...(COOKIE_DOMAIN && { domain: COOKIE_DOMAIN }),
      });
    }

    console.log(`[SERVER] Mobile Token Refreshed for User ID: ${info.data.id} at ${new Date().toLocaleString()}`);
    set.status = refresh_res.code;
    return refresh_res;
  })

  .get("/validate-token", async ({ cookie, set }) => {
    const existing_token = cookie["refresh_token"].value;
    if (!existing_token) {
      set.status = 404;
      return {
        success: false,
        code: 404,
        message: "No Refresh Token in Cookies",
      };
    }

    const validation_res = await validate_refresh_token(existing_token as string);
    set.status = validation_res.code;
    return validation_res;
  })

  .get("/logout", async ({ cookie, set, headers }) => {
    const existing_token = cookie["refresh_token"].value;
    const access_token = cookie["access_token"].value;
    // Mobile is Bearer-only — the app ships no CookieManager at all — so reading
    // identity from cookies alone made logout a NO-OP there: the FCM token stayed
    // registered against the leaving user, and the next account to sign in on that
    // handset kept receiving their pushes. Resolve the same credential set the
    // middleware does (src/middleware/index.ts) so mobile gets cleaned up too.
    const bearer_token = headers["authorization"]?.replace("Bearer ", "") ?? "";
    if (!existing_token && !access_token && !bearer_token) {
      set.status = 404;
      console.log(`[SERVER] Already Logged Out : ${new Date().toLocaleString()}`);
      return {
        success: true,
        message: "Already Logged Out",
      };
    }

    // clean up after logout — first credential that verifies wins. All three token
    // kinds are signed with the same access key (see generate_*_jwt), so the
    // verification path itself is unchanged; only WHICH credential we look at is.
    let user_id: string | undefined;
    for (const candidate of [existing_token, access_token, bearer_token]) {
      if (!candidate) continue;
      const info = authenticate_jwt(String(candidate));
      if (info.success && info.data?.id) {
        user_id = info.data.id;
        break;
      }
    }

    if (user_id) {
      // Remove FCM token from all 3 tiers (LRU, Redis, DB)
      await remove_fcm_token(user_id);

      // Server-side session kill: drop the user's sessions (single-device, so this
      // is the active one) and clear the legacy column. Without this the token would
      // stay refreshable until expiry even after logout.
      await revoke_user_sessions(user_id);
      await db
        .update(user_model)
        .set({ refresh_token: null })
        .where(eq(user_model.id, user_id));

      // Update online status in DB
      // await db
      //   .update(user_model)
      //   .set({ online_status: false })
      //   .where(eq(user_model.id, user_id));
    }

    const userAgent = headers['user-agent'];
    const cookieConfig = getCookieConfig(userAgent);

    cookie["refresh_token"].set({
      value: "",
      ...cookieConfig,
      maxAge: 0,
    });
    cookie["access_token"].set({
      value: "",
      ...cookieConfig,
      maxAge: 0,
    });

    set.status = 200;
    console.log(`[SERVER]   Logged Out : ${new Date().toLocaleString()}`);
    return {
      success: true,
      message: "Logged Out Successfully",
    };
  })

  .get("/clear-db", async ({ params, set }) => {
    try {
      await db.execute(sql`
  DO $$ DECLARE
      r RECORD;
  BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS "' || r.tablename || '" CASCADE';
      END LOOP;
  END $$;
`);
      set.status = 200;
      return {
        success: true,
        message: "dropped DB",
      };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        message: "Error dropping users table",
        error: (error as Error).message,
      };
    }
  });

export default auth_routes;
