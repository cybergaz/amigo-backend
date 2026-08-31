// ─── OTP issue + verify ─────────────────────────────────────────────────────
// The credential behind signup, OTP login, forgot-PIN and the app-lock admin-PIN
// setup. Delivery is delegated to otp-providers.ts (WhatsApp/Renflair by default,
// SMS for Indian numbers); throttling to otp-rate-limit.service.ts.
//
// Every code is scoped by PURPOSE — a code minted to reset a PIN cannot be spent
// on a login — and expires. Neither property existed when OTP was a secondary
// path; both are required now that it is the default login credential.
import db from "@/config/db";
import { otp_model, type OtpPurpose } from "@/models/otp.model";
import { create_otp, parse_phone, to_e164 } from "@/utils/general.utils";
import { eq } from "drizzle-orm";
import {
  DEV_OTP,
  is_channel_allowed,
  is_otp_dev_mode,
  send_otp_via,
  type OtpChannel,
} from "./otp-providers";
import {
  check_send_allowed,
  clear_verify_attempts,
  register_send,
  register_verify_failure,
} from "./otp-rate-limit.service";

// How long a code stays usable. Long enough to survive a slow WhatsApp delivery,
// short enough that a code glimpsed on a lock screen goes stale quickly.
const OTP_TTL_MINUTES = 10;

/**
 * Mint a code, send it over `channel`, and store it against the canonical E.164.
 *
 * Order matters: throttle → validate → send → THEN persist + count the send. A
 * provider failure therefore costs the user neither their quota nor a stored code
 * they never received.
 */
const generate_otp = async (
  phone: string,
  purpose: OtpPurpose = "login",
  channel: OtpChannel = "whatsapp",
) => {
  if (!phone) {
    return { success: false, code: 400, message: "phone number must be provided." };
  }

  try {
    // -----------------------------------------------------------
    // Parse + validate. Rejects anything that isn't a real number for its
    // country — the hard stop for a doubled country code ("+9191…"), where
    // libphonenumber resolves the country from the leading "+91" but the
    // over-long national number fails validation.
    // -----------------------------------------------------------
    const parsed_phone = parse_phone(phone);
    if (!parsed_phone.country || !parsed_phone.valid) {
      return {
        success: false,
        code: 400,
        message:
          "Invalid phone number. Please enter your number without the country code in the number field.",
      };
    }

    const canonical_phone = parsed_phone.e164;

    // -----------------------------------------------------------
    // SMS is contractually India-only. The client hides the option; this is the
    // authority that enforces it.
    // -----------------------------------------------------------
    if (!is_channel_allowed(channel, parsed_phone.code)) {
      return {
        success: false,
        code: 400,
        message: "SMS codes are only available for Indian numbers. Please use WhatsApp.",
      };
    }

    // -----------------------------------------------------------
    // Throttle BEFORE spending a message.
    // -----------------------------------------------------------
    const gate = await check_send_allowed(canonical_phone);
    if (!gate.allowed) {
      return {
        success: false,
        code: gate.code,
        message: gate.message,
        retry_after: gate.retry_after,
      };
    }

    const otp = is_otp_dev_mode() ? DEV_OTP : create_otp();

    // -----------------------------------------------------------
    // Deliver.
    // -----------------------------------------------------------
    const sent = await send_otp_via(channel, {
      national: parsed_phone.phone,
      calling_code: parsed_phone.code,
      e164: canonical_phone,
    }, otp);

    if (!sent.success) {
      return { success: false, code: sent.code, message: sent.message };
    }

    // -----------------------------------------------------------
    // Persist only once the provider accepted it. A fresh code resets the guess
    // counter — the new code deserves a full set of attempts.
    // -----------------------------------------------------------
    const expires_at = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    await db
      .insert(otp_model)
      .values({ phone: canonical_phone, otp, purpose, channel, expires_at, created_at: new Date() })
      .onConflictDoUpdate({
        target: otp_model.phone,
        set: { otp, purpose, channel, expires_at, created_at: new Date() },
      });

    await Promise.all([
      register_send(canonical_phone),
      clear_verify_attempts(canonical_phone),
    ]);

    return {
      success: true,
      code: 200,
      message: `OTP sent to ${canonical_phone}`,
      data: {
        phone: canonical_phone,
        channel,
        expires_in: OTP_TTL_MINUTES * 60,
        // The code itself is echoed ONLY in dev mode — in production this would
        // hand the OTP to anyone who can call the public endpoint.
        ...(is_otp_dev_mode() ? { otp } : {}),
      },
    };
  } catch (error) {
    console.error("Error in generate_otp:", error);
    return { success: false, code: 500, message: "ERROR generate_otp" };
  }
};

/**
 * Check a code. Consumes it on success.
 *
 * `expected_purpose` must match what the code was issued for. Passing `null`
 * skips the check and is reserved for legacy callers — new code should always
 * scope its verify.
 */
const verify_otp = async (
  otp: number,
  phone: string,
  expected_purpose: OtpPurpose | null = null,
) => {
  try {
    // Normalise to the same canonical E.164 that generate_otp stored, so a
    // differently-formatted-but-equivalent number still resolves to its OTP row.
    const lookup_phone = to_e164(phone);

    const db_res = await db
      .select()
      .from(otp_model)
      .where(eq(otp_model.phone, lookup_phone));

    if (db_res.length === 0) {
      return { success: false, code: 404, message: "No OTP found for this phone number" };
    }

    const row = db_res[0];

    // Expired → burn it. `expires_at` is null only for rows written before the
    // hardening migration; those are treated as legacy-but-valid so an in-flight
    // code at deploy time doesn't fail.
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      await db.delete(otp_model).where(eq(otp_model.phone, lookup_phone));
      return { success: false, code: 410, message: "This code has expired. Please request a new one." };
    }

    // Purpose scoping — a pin_reset code must not spend as a login.
    if (expected_purpose && row.purpose && row.purpose !== expected_purpose) {
      return { success: false, code: 401, message: "Invalid OTP" };
    }

    if (otp === row.otp) {
      await db.delete(otp_model).where(eq(otp_model.phone, lookup_phone));
      await clear_verify_attempts(lookup_phone);
      return { success: true, code: 200, message: "OTP verified and removed from db" };
    }

    // Wrong guess — count it, and burn the code once the budget is gone so a
    // 6-digit space can't be walked.
    const attempt = await register_verify_failure(lookup_phone);
    if (attempt.exhausted) {
      await db.delete(otp_model).where(eq(otp_model.phone, lookup_phone));
      return {
        success: false,
        code: 429,
        message: "Too many incorrect attempts. Please request a new code.",
      };
    }

    return {
      success: false,
      code: 401,
      message: "Invalid OTP",
      attempts_remaining: attempt.attempts_remaining,
    };
  } catch (error) {
    console.error("Error in verify_otp:", error);
    return { success: false, code: 500, message: "ERROR : verify_otp" };
  }
};

export { generate_otp, verify_otp, OTP_TTL_MINUTES };
