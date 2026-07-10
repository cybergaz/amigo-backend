// ─── PIN management (set / update / reset / status) ─────────────────────────
// Authenticated set/update (Settings + the enforcement create-PINs screen) and the
// unauthenticated OTP-gated reset for a forgotten login PIN. Login verification lives
// in auth.service.ts (handle_login_pin). All hashing goes through hash_pin/compare_pin
// (HMAC pepper + bcrypt) — plaintext PINs never touch the DB.
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { eq } from "drizzle-orm";
import { hash_pin, compare_pin, is_valid_pin, to_e164 } from "@/utils/general.utils";
import { verify_otp } from "./otp.services";
import { clear_pin_attempts } from "./pin-lockout.service";

export type PinKind = "password" | "admin";

// Set or update one of the user's PINs.
//   - First-time set (column NULL): no current_pin required.
//   - Update (column already set): current_pin required and must match.
//   - The two PINs must differ (enforced against the OTHER column's stored hash).
const set_user_pin = async (
  user_id: string,
  kind: PinKind,
  pin: string,
  current_pin?: string
) => {
  try {
    if (!is_valid_pin(pin)) {
      return { success: false, code: 400, message: "PIN must be exactly 4 digits", data: null };
    }

    const [user] = await db
      .select({
        password_pin_hash: user_model.password_pin_hash,
        admin_pin_hash: user_model.admin_pin_hash,
      })
      .from(user_model)
      .where(eq(user_model.id, user_id))
      .limit(1);

    if (!user) {
      return { success: false, code: 404, message: "User not found", data: null };
    }

    const current_hash = kind === "password" ? user.password_pin_hash : user.admin_pin_hash;
    const other_hash = kind === "password" ? user.admin_pin_hash : user.password_pin_hash;

    // Updating an existing PIN requires proving the current one.
    if (current_hash) {
      if (!current_pin) {
        return { success: false, code: 400, message: "Current PIN is required to change it", data: null };
      }
      const ok = await compare_pin(current_pin, current_hash);
      if (!ok) {
        return { success: false, code: 401, message: "Incorrect current PIN", data: null };
      }
    }

    // The two PINs must be different.
    if (other_hash && (await compare_pin(pin, other_hash))) {
      return {
        success: false,
        code: 409,
        message: "Your two PINs must be different",
        data: null,
      };
    }

    const new_hash = await hash_pin(pin);
    const column = kind === "password"
      ? { password_pin_hash: new_hash }
      : { admin_pin_hash: new_hash };

    const [updated] = await db
      .update(user_model)
      .set(column)
      .where(eq(user_model.id, user_id))
      .returning({
        password_pin_hash: user_model.password_pin_hash,
        admin_pin_hash: user_model.admin_pin_hash,
      });

    return {
      success: true,
      code: 200,
      message: kind === "password" ? "Password PIN saved" : "Admin PIN saved",
      data: {
        has_password_pin: updated.password_pin_hash != null,
        has_admin_pin: updated.admin_pin_hash != null,
      },
    };
  } catch (error) {
    console.error("set_user_pin error:", error);
    return { success: false, code: 500, message: "Failed to save PIN", data: null };
  }
};

// Forgot-PIN: OTP proves ownership of the phone, then the login (password) PIN is
// reset. Rides the EXISTING OTP path unchanged (out of scope to harden OTP here).
const reset_password_pin = async (phone: string, otp: number, new_pin: string) => {
  try {
    if (!is_valid_pin(new_pin)) {
      return { success: false, code: 400, message: "PIN must be exactly 4 digits" };
    }

    const otp_res = await verify_otp(otp, phone);
    if (!otp_res.success) {
      return otp_res;
    }

    const canonical_phone = to_e164(phone);
    const [user] = await db
      .select({
        id: user_model.id,
        admin_pin_hash: user_model.admin_pin_hash,
      })
      .from(user_model)
      .where(eq(user_model.phone, canonical_phone))
      .limit(1);

    if (!user) {
      return { success: false, code: 404, message: "User not found" };
    }

    // New login PIN must differ from the admin PIN (if one is set).
    if (user.admin_pin_hash && (await compare_pin(new_pin, user.admin_pin_hash))) {
      return { success: false, code: 409, message: "Your two PINs must be different" };
    }

    const new_hash = await hash_pin(new_pin);
    await db
      .update(user_model)
      .set({ password_pin_hash: new_hash })
      .where(eq(user_model.id, user.id));

    // A successful reset clears any brute-force lock on the phone.
    await clear_pin_attempts(canonical_phone);

    return { success: true, code: 200, message: "PIN reset successfully" };
  } catch (error) {
    console.error("reset_password_pin error:", error);
    return { success: false, code: 500, message: "Failed to reset PIN" };
  }
};

// Login-screen precheck: does this phone exist, and does it have a login PIN? Drives
// whether the app asks for a PIN or falls back to OTP (pre-PIN users).
const get_phone_pin_status = async (phone: string) => {
  try {
    const [user] = await db
      .select({ password_pin_hash: user_model.password_pin_hash })
      .from(user_model)
      .where(eq(user_model.phone, to_e164(phone)))
      .limit(1);

    return {
      success: true,
      code: 200,
      message: "Phone status fetched",
      data: {
        exists: !!user,
        has_pin: !!user?.password_pin_hash,
      },
    };
  } catch (error) {
    console.error("get_phone_pin_status error:", error);
    return { success: false, code: 500, message: "Failed to fetch phone status", data: null };
  }
};

export { set_user_pin, reset_password_pin, get_phone_pin_status };
