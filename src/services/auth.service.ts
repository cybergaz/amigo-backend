import { signup_request_model, UpdateSignupRequestType, user_model } from "@/models/user.model";
import db from "@/config/db";
import {
  compare_password,
  compare_pin,
  generate_jwt,
} from "@/utils/general.utils";
import { eq, desc } from "drizzle-orm";
import { redis } from "@/config/redis";
import { create_user } from "./user.services";
import {
  create_session,
  revoke_user_sessions,
  rotate_refresh_token,
  validate_session,
  login_device,
} from "./session.service";
import {
  get_pin_lock_status,
  register_pin_failure,
  clear_pin_attempts,
} from "./pin-lockout.service";
import {
  is_device_allowed,
  consume_device_change_request,
} from "./device-change-request.service";

const handle_login = async ({
  phone,
  email,
  password,
}: {
  phone?: string;
  email?: string;
  password?: string;
}) => {
  try {
    const user = await db
      .select()
      .from(user_model)
      .where(
        phone ? eq(user_model.phone, phone) : eq(user_model.email, email!)
      )
      .then((res) => res[0]);

    if (!user) {
      return {
        success: false,
        code: 404,
        message: "User not found",
      };
    }

    if (password) {
      if (!user.hashed_password) {
        return {
          success: false,
          code: 403,
          message: "Account is not password protected",
          help: {
            message: "Login via OTP!",
            link: `${process.env.FRONTEND_URL}/otp-login`,
          },
        };
      }

      const isPasswordCorrect = await compare_password(
        password,
        user.hashed_password
      );
      if (!isPasswordCorrect) {
        return {
          success: false,
          code: 401,
          message: "Incorrect password",
        };
      }
    }

    const access_token = generate_jwt(user.id, user.role || false, "7d");

    // Single-device: WS-kick the live socket, drop every other session, then mint a
    // fresh session-bound refresh token. Clear the legacy column too, so any stale
    // pre-sessions token for this user can't be replayed via the refresh fallback.
    await force_logout_other_devices(user.id);
    await revoke_user_sessions(user.id);
    const refresh_token = await create_session(user.id, user.role, "90d");
    await db
      .update(user_model)
      .set({ refresh_token: null })
      .where(eq(user_model.id, user.id));

    return {
      success: true,
      code: 200,
      message: "Login successful",
      data: {
        id: user.id,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email,
        profile_pic: user.profile_pic,
        call_access: user.call_access,
        created_at: user.created_at,
        refresh_token,
        access_token,
      },
    };
  } catch (error: any) {
    console.error("Login error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during login",
    };
  }
};

// Web refresh: short-lived access (1d) + 7d refresh, grace-aware rotation.
const handle_refresh_token = (token: string) =>
  rotate_refresh_token(token, { access: "1d", refresh: "7d" });

// Mobile refresh: 1d access + 30d refresh, grace-aware rotation.
const handle_refresh_token_mobile = (token: string) =>
  rotate_refresh_token(token, { access: "1d", refresh: "30d" });

// Validate if a refresh token still maps to a live session (or a legacy column
// token). Lightweight, read-only.
const validate_refresh_token = (token: string) => validate_session(token);

// Force-logout the user's other live socket (single-device). Publishes over Redis so
// it reaches the socket on ANY PM2 worker — the old socket_connections.get(user_id)
// only ever saw same-worker sockets, so a cross-worker device was never told to log
// out (the split-brain behind late/never "logged in elsewhere" logouts). The durable
// authority is auth_devices.token_version (re-checked on WS open); this is just the
// instant nudge. Delivered by the ws:force_logout subscriber in ws-broadcast.ts.
const force_logout_other_devices = async (user_id: string): Promise<void> => {
  try {
    await redis.publish("ws:force_logout", JSON.stringify({ user_id }));
  } catch (error) {
    console.error(`[AUTH] Error publishing force_logout for user ${user_id}:`, error);
  }
};

// Mobile device login: verify identity (phone OTP is checked at the route; email+
// password is checked here), run the single-device engine + mint the long-lived
// device JWT (login_device), THEN nudge the old device. Order matters — the DB
// version bump + authver write happen BEFORE the nudge, so a racing reconnect from
// the old device fails the WS version-check instead of slipping back in.
const handle_login_device = async ({
  phone,
  email,
  password,
  device,
}: {
  phone?: string;
  email?: string;
  password?: string;
  device: { device_id: string; platform?: string; device_name?: string };
}) => {
  try {
    const user = await db
      .select()
      .from(user_model)
      .where(phone ? eq(user_model.phone, phone) : eq(user_model.email, email!))
      .then((res) => res[0]);

    if (!user) {
      return { success: false, code: 404, message: "User not found" };
    }

    if (password) {
      if (!user.hashed_password) {
        return {
          success: false,
          code: 403,
          message: "Account is not password protected",
          help: {
            message: "Login via OTP!",
            link: `${process.env.FRONTEND_URL}/otp-login`,
          },
        };
      }
      const isPasswordCorrect = await compare_password(password, user.hashed_password);
      if (!isPasswordCorrect) {
        return { success: false, code: 401, message: "Incorrect password" };
      }
    }

    // Single-device LOCK gate — runs BEFORE the destructive login_device mint, so
    // a refused device evicts nothing. Refusal is a plain business error (NO
    // auth_error) so it can never force-logout the legitimately-registered device.
    const gate = await is_device_allowed(user.id, device.device_id);
    if (!gate.allowed) {
      return {
        success: false,
        code: 403,
        message: "This device is not registered. Request a device change to log in here.",
        data: {
          device_change_required: true,
          registered_device_name: gate.registered_device_name,
          pending_request_status: gate.pending_request_status,
        },
      };
    }

    // Authoritative single-device + mint FIRST, then the instant nudge.
    const { token } = await login_device(user.id, user.role, device);
    await force_logout_other_devices(user.id);
    // Single-use: burn the approval that let this device in (if any).
    await consume_device_change_request(gate.approved_request_id);

    return {
      success: true,
      code: 200,
      message: "Login successful",
      data: {
        id: user.id,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email,
        profile_pic: user.profile_pic,
        call_access: user.call_access,
        created_at: user.created_at,
        has_password_pin: user.password_pin_hash != null,
        has_admin_pin: user.admin_pin_hash != null,
        token, // long-lived device JWT in body; NO refresh_token
      },
    };
  } catch (error: any) {
    console.error("Device login error:", error);
    return { success: false, code: 500, message: "Internal server error during login" };
  }
};

// Mobile PIN login: phone + 4-digit password_pin. Same identity outcome as the OTP
// path — verify the credential, then run the EXISTING single-device engine
// (login_device + force_logout_other_devices) to mint the durable device JWT. The
// token machinery is untouched; only the credential check differs (PIN vs OTP).
//
// Brute-force guarded by the per-phone Redis lockout. NONE of the failure responses
// carry an `auth_error` field, so a wrong PIN / lockout can never log the user out
// (see constants/auth-codes.ts).
const handle_login_pin = async ({
  phone,
  pin,
  device,
}: {
  phone: string;
  pin: string;
  device: { device_id: string; platform?: string; device_name?: string };
}) => {
  try {
    // 1. Refuse early if this phone is currently locked out.
    const lock = await get_pin_lock_status(phone);
    if (lock.locked) {
      return {
        success: false,
        code: 429,
        message: `Too many incorrect attempts. Try again in ${Math.ceil(lock.retry_after / 60)} minute(s).`,
        retry_after: lock.retry_after,
      };
    }

    const user = await db
      .select()
      .from(user_model)
      .where(eq(user_model.phone, phone))
      .then((res) => res[0]);

    if (!user) {
      return { success: false, code: 404, message: "User not found" };
    }

    // No PIN set yet (pre-PIN user) → tell the client to fall back to OTP login.
    if (!user.password_pin_hash) {
      return {
        success: false,
        code: 403,
        message: "No PIN set for this account. Please log in with OTP.",
        pin_not_set: true,
      };
    }

    const ok = await compare_pin(pin, user.password_pin_hash);
    if (!ok) {
      const after = await register_pin_failure(phone);
      if (after.locked) {
        return {
          success: false,
          code: 429,
          message: `Too many incorrect attempts. Try again in ${Math.ceil(after.retry_after / 60)} minute(s).`,
          retry_after: after.retry_after,
        };
      }
      return {
        success: false,
        code: 401,
        message: "Incorrect PIN",
        attempts_remaining: after.attempts_remaining,
      };
    }

    // Success — clear the counter. The PIN was correct; a device refusal below is
    // a business error, not a credential failure.
    await clear_pin_attempts(phone);

    // Single-device LOCK gate — pre-mint (see handle_login_device for the why).
    const gate = await is_device_allowed(user.id, device.device_id);
    if (!gate.allowed) {
      return {
        success: false,
        code: 403,
        message: "This device is not registered. Request a device change to log in here.",
        data: {
          device_change_required: true,
          registered_device_name: gate.registered_device_name,
          pending_request_status: gate.pending_request_status,
        },
      };
    }

    // Standard single-device mint + nudge.
    const { token } = await login_device(user.id, user.role, device);
    await force_logout_other_devices(user.id);
    await consume_device_change_request(gate.approved_request_id);

    return {
      success: true,
      code: 200,
      message: "Login successful",
      data: {
        id: user.id,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email,
        profile_pic: user.profile_pic,
        call_access: user.call_access,
        created_at: user.created_at,
        has_password_pin: user.password_pin_hash != null,
        has_admin_pin: user.admin_pin_hash != null,
        token, // long-lived device JWT in body; NO refresh_token
      },
    };
  } catch (error: any) {
    console.error("PIN login error:", error);
    return { success: false, code: 500, message: "Internal server error during login" };
  }
};

const create_signup_request = async ({ name, phone }: { name: string; phone: string; }) => {
  try {
    const signup_request = await db
      .insert(signup_request_model)
      .values({
        name,
        phone,
      })
      .returning();
    if (!signup_request) {
      return {
        success: false,
        code: 404,
        message: "Signup request not created"
      };
    }

    // ---------------------------------------------------------
    // temporarily auto-accepting all signup requests
    // ---------------------------------------------------------
    await update_signup_request_status({
      phone,
      name,
      status: "accepted",
    });

    return {
      success: true,
      code: 200,
      message: "Signup request created successfully",
      data: signup_request,
    };
  } catch (error) {
    console.error("Signup request error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during signup request"
    };
  }
};

const get_signup_request_status = async (phone: string) => {
  try {
    const signup_request = await db
      .select()
      .from(signup_request_model)
      .where(eq(signup_request_model.phone, phone))
      .limit(1);

    if (!signup_request || signup_request.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Signup request not found for this phone number"
      };
    }
    return {
      success: true,
      code: 200,
      message: "Signup request status fetched successfully",
      data: signup_request[0]
    };
  } catch (error) {
    console.error("Signup request status error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during signup request status"
    };
  }
};

const get_all_signup_requests = async () => {
  try {
    const signup_requests = await db
      .select()
      .from(signup_request_model)
      .orderBy(desc(signup_request_model.created_at));

    return {
      success: true,
      code: 200,
      message: "Signup requests fetched successfully",
      data: signup_requests
    };
  } catch (error) {
    console.error("Get all signup requests error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during fetching signup requests"
    };
  }
};

const update_signup_request_status = async (payload: UpdateSignupRequestType) => {
  try {

    const signup_request = await db
      .update(signup_request_model)
      .set(payload)
      .where(eq(signup_request_model.phone, payload.phone!))
      .returning();



    if (!signup_request) {
      return { success: false, code: 404, message: "Signup request not updated" };
    }

    // Only create user if status is accepted
    if (payload.status === "accepted") {
      const create_user_res = await create_user({
        name: signup_request[0].name,
        password: null,
        role: "user",
        phone: signup_request[0].phone,
      });

      if (!create_user_res?.success) {
        return { success: false, code: create_user_res.code, message: create_user_res.message };
      }
    }

    return {
      success: true,
      code: 200,
      message: "Signup request status updated successfully",
      data: signup_request[0]
    };
  } catch (error) {
    console.error("Signup request status update error:", error);
    return { success: false, code: 500, message: "Internal server error during signup request status update" };
  }
};

const DEMO_USER_PHONE = '+10000000000';
const DEMO_USER_NAME = 'Demo User';

const demo_login = async () => {
  try {
    // Find existing demo user
    let demo_user = await db
      .select()
      .from(user_model)
      .where(eq(user_model.phone, DEMO_USER_PHONE))
      .then((res) => res[0]);

    // Create demo user if doesn't exist
    if (!demo_user) {
      const create_res = await create_user({
        name: DEMO_USER_NAME,
        password: null,
        role: 'user',
        phone: DEMO_USER_PHONE,
      });

      if (!create_res.success) {
        return { success: false, code: 500, message: 'Failed to create demo account' };
      }

      demo_user = await db
        .select()
        .from(user_model)
        .where(eq(user_model.phone, DEMO_USER_PHONE))
        .then((res) => res[0]);
    }

    if (!demo_user) {
      return { success: false, code: 500, message: 'Demo account unavailable' };
    }

    const access_token = generate_jwt(demo_user.id, demo_user.role || false, '7d');

    // Demo accounts intentionally allow concurrent sessions — create a session
    // without revoking the others.
    const refresh_token = await create_session(demo_user.id, demo_user.role, '30d');

    return {
      success: true,
      code: 200,
      message: 'Demo login successful',
      data: {
        id: demo_user.id,
        name: demo_user.name,
        role: demo_user.role,
        phone: demo_user.phone,
        email: demo_user.email,
        profile_pic: demo_user.profile_pic,
        call_access: demo_user.call_access,
        created_at: demo_user.created_at,
        refresh_token,
        access_token,
      },
    };
  } catch (error: any) {
    console.error('Demo login error:', error);
    return {
      success: false,
      code: 500,
      message: 'Internal server error during demo login',
    };
  }
};

export {
  handle_login,
  handle_login_device,
  handle_login_pin,
  handle_refresh_token,
  handle_refresh_token_mobile,
  force_logout_other_devices,
  validate_refresh_token,
  create_signup_request,
  get_signup_request_status,
  get_all_signup_requests,
  update_signup_request_status,
  demo_login,
};
