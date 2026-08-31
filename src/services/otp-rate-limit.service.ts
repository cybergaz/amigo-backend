// ─── OTP send/verify throttling ─────────────────────────────────────────────
// /auth/generate-*-otp is PUBLIC and every call spends real money at the WhatsApp
// or SMS provider, so an unthrottled endpoint is both a billing DoS and an SMS-
// bombing tool aimed at whatever number the attacker types. This is the guard.
//
// Three independent limits, all per-phone, all in Redis with TTLs (nothing to GC):
//   1. RESEND_COOLDOWN — no second send within N seconds. Stops double-taps and
//      the tightest abuse loop.
//   2. HOURLY_CAP / DAILY_CAP — rolling ceilings on how many messages one number
//      can ever cost us.
//   3. verify attempts — a 6-digit OTP is 1M combinations, but an unbounded
//      verify endpoint still gets there. N wrong guesses burns the OTP.
//
// Mirrors pin-lockout.service.ts deliberately: same shape, same Redis, same rule
// that a throttle response is a BUSINESS error (429) and MUST NOT carry an
// `auth_error` field — it can never log a user out.
import { redis } from "@/config/redis";
import { to_e164 } from "@/utils/general.utils";

const RESEND_COOLDOWN_SECONDS = 15;   // minimum gap between two sends
const HOURLY_CAP = 10;                 // sends per phone per rolling hour
const DAILY_CAP = 20;                 // sends per phone per rolling day
const MAX_VERIFY_ATTEMPTS = 5;        // wrong guesses before the OTP is burned

// Per-ACTOR caps, for authenticated flows where the caller picks the target
// number (today: the self-serve phone change). The per-phone caps above stop an
// attacker hammering ONE number; they do nothing against one account fanning
// paid messages out across MANY numbers, because each fresh target arrives with
// a fresh quota. These close that. Deliberately tight — a real user changes
// their number once in a while, not five times an hour.
const ACTOR_HOURLY_CAP = 5;
const ACTOR_DAILY_CAP = 10;

const cooldown_key = (phone: string) => `otp:cooldown:${phone}`;
const hourly_key = (phone: string) => `otp:sends:h:${phone}`;
const daily_key = (phone: string) => `otp:sends:d:${phone}`;
const attempts_key = (phone: string) => `otp:attempts:${phone}`;
const actor_hourly_key = (actor: string) => `otp:actor:h:${actor}`;
const actor_daily_key = (actor: string) => `otp:actor:d:${actor}`;

export type SendGate =
  | { allowed: true; }
  | { allowed: false; code: number; message: string; retry_after: number; };

// Call BEFORE generating/sending. Read-only — it reserves nothing, so a caller
// that fails later (provider error) hasn't burned the user's quota.
const check_send_allowed = async (phone_input: string): Promise<SendGate> => {
  const phone = to_e164(phone_input);

  const cooldown = await redis.ttl(cooldown_key(phone));
  if (cooldown > 0) {
    return {
      allowed: false,
      code: 429,
      message: `Please wait ${cooldown} second(s) before requesting another code.`,
      retry_after: cooldown,
    };
  }

  const [hourly, daily] = await Promise.all([
    redis.get(hourly_key(phone)),
    redis.get(daily_key(phone)),
  ]);

  if (Number(hourly ?? 0) >= HOURLY_CAP) {
    const ttl = await redis.ttl(hourly_key(phone));
    return {
      allowed: false,
      code: 429,
      message: "Too many codes requested. Please try again in an hour.",
      retry_after: ttl > 0 ? ttl : 3600,
    };
  }

  if (Number(daily ?? 0) >= DAILY_CAP) {
    const ttl = await redis.ttl(daily_key(phone));
    return {
      allowed: false,
      code: 429,
      message: "Daily limit reached for this number. Please try again tomorrow.",
      retry_after: ttl > 0 ? ttl : 86400,
    };
  }

  return { allowed: true };
};

// Call ONLY after the provider accepted the message — a failed send must not
// consume the user's quota or lock them behind a cooldown they got nothing for.
const register_send = async (phone_input: string): Promise<void> => {
  const phone = to_e164(phone_input);

  await redis.set(cooldown_key(phone), "1", "EX", RESEND_COOLDOWN_SECONDS);

  const hourly = await redis.incr(hourly_key(phone));
  if (hourly === 1) await redis.expire(hourly_key(phone), 3600);

  const daily = await redis.incr(daily_key(phone));
  if (daily === 1) await redis.expire(daily_key(phone), 86400);
};

// Record a wrong OTP guess. Returns whether the OTP should now be burned.
const register_verify_failure = async (
  phone_input: string,
): Promise<{ exhausted: boolean; attempts_remaining: number; }> => {
  const phone = to_e164(phone_input);
  const key = attempts_key(phone);
  const attempts = await redis.incr(key);
  // Tie the counter's life to a generous OTP lifetime so it can't outlive the code.
  if (attempts === 1) await redis.expire(key, 30 * 60);

  const remaining = Math.max(0, MAX_VERIFY_ATTEMPTS - attempts);
  return { exhausted: attempts >= MAX_VERIFY_ATTEMPTS, attempts_remaining: remaining };
};

// Clear guess counters — on a successful verify, or when a fresh OTP is issued
// (a new code deserves a full set of attempts).
const clear_verify_attempts = async (phone_input: string): Promise<void> => {
  await redis.del(attempts_key(to_e164(phone_input)));
};

// Call BEFORE sending, for flows where an authenticated caller names the target
// number. Read-only, same as check_send_allowed — nothing is reserved.
const check_actor_send_allowed = async (actor_id: string): Promise<SendGate> => {
  const [hourly, daily] = await Promise.all([
    redis.get(actor_hourly_key(actor_id)),
    redis.get(actor_daily_key(actor_id)),
  ]);

  if (Number(hourly ?? 0) >= ACTOR_HOURLY_CAP) {
    const ttl = await redis.ttl(actor_hourly_key(actor_id));
    return {
      allowed: false,
      code: 429,
      message: "Too many verification codes requested. Please try again later.",
      retry_after: Math.max(ttl, 0),
    };
  }

  if (Number(daily ?? 0) >= ACTOR_DAILY_CAP) {
    const ttl = await redis.ttl(actor_daily_key(actor_id));
    return {
      allowed: false,
      code: 429,
      message: "Daily limit for verification codes reached. Please try again tomorrow.",
      retry_after: Math.max(ttl, 0),
    };
  }

  return { allowed: true };
};

// Count a send against the actor. Call only AFTER the provider accepted it, so a
// delivery failure doesn't cost the user their quota.
const register_actor_send = async (actor_id: string): Promise<void> => {
  const hourly = await redis.incr(actor_hourly_key(actor_id));
  if (hourly === 1) await redis.expire(actor_hourly_key(actor_id), 3600);

  const daily = await redis.incr(actor_daily_key(actor_id));
  if (daily === 1) await redis.expire(actor_daily_key(actor_id), 86400);
};

export {
  check_send_allowed,
  check_actor_send_allowed,
  register_actor_send,
  register_send,
  register_verify_failure,
  clear_verify_attempts,
  RESEND_COOLDOWN_SECONDS,
  HOURLY_CAP,
  DAILY_CAP,
  ACTOR_HOURLY_CAP,
  ACTOR_DAILY_CAP,
  MAX_VERIFY_ATTEMPTS,
};
