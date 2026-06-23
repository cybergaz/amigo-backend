import jwt from "jsonwebtoken";
import type { StringValue } from "ms";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import { parsePhoneNumberFromString } from "libphonenumber-js";

const generate_unique_id = () => {
  const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 20);
  return nanoid();
};

const create_otp = () => {
  return Math.floor(100000 + Math.random() * 900000);
};

const hash_password = async (password: string): Promise<string> => {
  const SALT = 10;
  const hashed_password = await bcrypt.hash(password, SALT);
  return hashed_password;
};


const generate_jwt = (id: string, role: string, time: StringValue = "1d") => {
  // TESTING OVERRIDE: set ACCESS_TOKEN_TTL (e.g. "60s") in .env to force short
  // access tokens regardless of call site, so token-refresh can be tested
  // without waiting days. Leave unset in production.
  const ttl = (process.env.ACCESS_TOKEN_TTL as StringValue) || time;
  return jwt.sign({
    id,
    role,
  },
    process.env.ACCESS_KEY || "heymama", {
    expiresIn: ttl,
  });
};

const generate_refresh_jwt = (id: string, role: string, time: StringValue = "7d", sid?: string) => {
  // TESTING OVERRIDE: set REFRESH_TOKEN_TTL (e.g. "2m") in .env to test the
  // refresh-expiry/clean-logout path quickly. Leave unset in production.
  const ttl = (process.env.REFRESH_TOKEN_TTL as StringValue) || time;
  // `sid` (session id) ties the token to a row in refresh_sessions; omitted only by
  // legacy call sites. Self-identifying tokens enable future device management.
  const payload: Record<string, unknown> = { id, role };
  if (sid) payload.sid = sid;
  return jwt.sign(payload, process.env.ACCESS_KEY || "heymama", {
    expiresIn: ttl,
  });
};

const compare_password = async (password: string, hashed_password: string) => {
  return await bcrypt.compare(password, hashed_password);
};


function parse_phone(input: string, default_country_code?: string) {
  const phone = parsePhoneNumberFromString(input);

  if (!phone) return {
    country: null,
    code: "",
    phone: input,
    concatinated: `+${default_country_code}${input.replace(" ", "")}`,
    valid: false,
    e164: input.replace(/\s+/g, ""),
  };

  return {
    country: phone.country || null,
    code: phone.countryCallingCode, // e.g. "91"
    phone: phone.nationalNumber,     // e.g. "7777777777"
    concatinated: `+${phone.countryCallingCode || ""}${phone.nationalNumber}`.replace(" ", ""), // e.g. "+917777777777"
    // `valid` is false for malformed input such as a doubled country code
    // ("+9191…"): libphonenumber still resolves the country from the leading
    // "+91", but the over-long national number fails the per-country pattern.
    valid: phone.isValid(),
    e164: phone.number,              // canonical E.164, e.g. "+917777777777"
  };
}

// Normalise any user-supplied phone string to canonical E.164 ("+<cc><national>").
// Falls back to the whitespace-stripped input when the number can't be parsed or
// validated (e.g. internal test numbers) so existing lookups keep working.
function to_e164(input: string): string {
  const phone = parsePhoneNumberFromString(input);
  return phone && phone.isValid() ? phone.number : input.replace(/\s+/g, "");
}

const create_dm_key = (user1: string, user2: string) => {
  return [user1, user2].sort().join("_");
};


export { parse_phone, to_e164, generate_unique_id, create_otp, hash_password, generate_jwt, generate_refresh_jwt, compare_password, create_dm_key };
