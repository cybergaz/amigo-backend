// ─── OTP delivery channels ──────────────────────────────────────────────────
// One adapter per transport. Everything above this file (otp.services.ts) deals in
// a `channel` string and never knows which vendor is behind it, so swapping a
// provider is a change to exactly one function here.
//
// Channels — both are Renflair, on separate hosts:
//   whatsapp → https://whatsapp.renflair.in/V1.php  (API, PHONE, OTP, COUNTRY)
//              the default, all countries.
//   sms      → https://sms.renflair.in/V1.php       (API, PHONE, OTP)
//              India only. Note there is NO country parameter — the endpoint is
//              implicitly Indian, which is exactly why the SMS channel is gated to
//              +91 rather than merely marketed that way.
//
// Both take PHONE as the NATIONAL number (no country code), which is what
// parse_phone() already hands us as `.phone`.
//
// NOTE: providers are paid per message. The caller MUST have passed the rate
// limiter (otp-rate-limit.service.ts) before reaching this file.
// The subset of parse_phone()'s output every adapter needs. Kept local so this
// file has no dependency on the phone parser itself.
export type ParsedPhone = {
  /** National number, no country code — e.g. "7777777777". */
  national: string;
  /** Calling code without "+", e.g. "91". */
  calling_code: string;
  /** Canonical E.164, e.g. "+917777777777". */
  e164: string;
};

export const OTP_CHANNELS = ["whatsapp", "sms"] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];

// India-only channels. `code` is the calling code from parse_phone (e.g. "91").
const INDIA_CALLING_CODE = "91";

export type SendResult =
  | { success: true; provider_ref?: string }
  | { success: false; code: number; message: string };

// Is this channel usable for this number? SMS is contractually India-only; the
// client hides the option, this is the authority that enforces it.
export const is_channel_allowed = (channel: OtpChannel, calling_code: string): boolean => {
  if (channel === "sms") return calling_code === INDIA_CALLING_CODE;
  return true;
};

// Dev/staging escape hatch: skip the paid provider entirely and accept a fixed
// OTP. MUST be false in production — guarded here (single place) rather than at
// each call site. Defaults to OFF so an unset env can never disable real sends.
export const is_otp_dev_mode = (): boolean =>
  String(process.env.OTP_DEV_MODE ?? "").toLowerCase() === "true";

export const DEV_OTP = 123456;

// These gateways are inconsistent about how they report success: some return
// {"Status":"Success"}, some {"status":true}, some {"success":1}, some a bare
// string. Treat an explicit failure signal as failure and anything else on a 2xx
// as success — being too strict here silently blocks real logins.
const looks_successful = (body: unknown, http_ok: boolean): boolean => {
  if (!http_ok) return false;
  if (body == null) return true;
  if (typeof body === "string") return !/error|fail|invalid/i.test(body);
  if (typeof body === "object") {
    const b = body as Record<string, unknown>;
    const status = b.status ?? b.Status ?? b.success ?? b.Success;
    if (typeof status === "boolean") return status;
    if (typeof status === "number") return status !== 0;
    if (typeof status === "string") return !/error|fail|false|invalid/i.test(status);
    if (b.error || b.Error) return false;
  }
  return true;
};

// Read the body once, as text, then try JSON. Providers frequently mislabel their
// content-type, and a res.json() on an HTML error page throws where we want the
// error text logged instead.
const read_body = async (res: Response): Promise<unknown> => {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

// ── Renflair, both hosts ────────────────────────────────────────────────────
// The two endpoints differ only in host and whether they take COUNTRY, so the
// request/response handling is shared. Returns a client-safe message on failure;
// the vendor's own error text is logged, never echoed back (it can carry the key).
const send_via_renflair = async (
  label: "WhatsApp" | "SMS",
  base: string,
  api_key: string,
  params: Record<string, string>,
): Promise<SendResult> => {
  const url = new URL(base);
  url.searchParams.set("API", api_key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await read_body(res);

    if (!looks_successful(body, res.ok)) {
      // Log the raw body — the vendor's failure shape is the only documentation
      // we have, and this is where we learn it.
      console.error(`[otp] Renflair ${label} rejected send (HTTP ${res.status}):`, body);
      return {
        success: false,
        code: 502,
        message: `Could not send the ${label} code. Please try again.`,
      };
    }

    return { success: true };
  } catch (error) {
    console.error(`[otp] Renflair ${label} request failed:`, error);
    return {
      success: false,
      code: 502,
      message: `Could not reach the ${label} service. Please try again.`,
    };
  }
};

// ── WhatsApp ────────────────────────────────────────────────────────────────
// GET https://whatsapp.renflair.in/V1.php?API=..&PHONE=..&OTP=..&COUNTRY=..
const send_whatsapp_otp = async (phone: ParsedPhone, otp: number): Promise<SendResult> => {
  const api = process.env.RENFLAIR_API_KEY;
  const base = process.env.RENFLAIR_URL || "https://whatsapp.renflair.in/V1.php";
  if (!api) {
    console.error("[otp] RENFLAIR_API_KEY is not set — cannot send WhatsApp OTP.");
    return { success: false, code: 500, message: "OTP service is not configured. Please contact support." };
  }

  return send_via_renflair("WhatsApp", base, api, {
    PHONE: phone.national,
    OTP: String(otp),
    COUNTRY: phone.calling_code,
  });
};

// ── SMS (India only) ────────────────────────────────────────────────────────
// GET https://sms.renflair.in/V1.php?API=..&PHONE=..&OTP=..
// No COUNTRY parameter: the endpoint is India-only, enforced upstream by
// is_channel_allowed(). The message body is composed by Renflair from their own
// DLT-registered template — we only supply the digits.
//
// The key falls back to RENFLAIR_API_KEY: same vendor, and in most accounts the
// same credential serves both products. Set RENFLAIR_SMS_API_KEY only if the SMS
// product was issued a separate key.
const send_sms_otp = async (phone: ParsedPhone, otp: number): Promise<SendResult> => {
  const api = process.env.RENFLAIR_SMS_API_KEY || process.env.RENFLAIR_API_KEY;
  const base = process.env.RENFLAIR_SMS_URL || "https://sms.renflair.in/V1.php";
  if (!api) {
    console.error("[otp] No Renflair key set (RENFLAIR_SMS_API_KEY / RENFLAIR_API_KEY) — cannot send SMS OTP.");
    return { success: false, code: 500, message: "SMS service is not configured. Please contact support." };
  }

  return send_via_renflair("SMS", base, api, {
    PHONE: phone.national,
    OTP: String(otp),
  });
};

// Single entry point. Returns a client-safe message on failure; the vendor's own
// error text is logged, never echoed back (it leaks keys and account details).
export const send_otp_via = async (
  channel: OtpChannel,
  phone: ParsedPhone,
  otp: number,
): Promise<SendResult> => {
  if (is_otp_dev_mode()) {
    console.log(`[otp] DEV MODE — not sending. ${channel} OTP for ${phone.e164} is ${otp}`);
    return { success: true };
  }
  return channel === "sms" ? send_sms_otp(phone, otp) : send_whatsapp_otp(phone, otp);
};
