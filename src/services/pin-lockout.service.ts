// ─── PIN brute-force lockout ────────────────────────────────────────────────
// A 4-digit PIN has only 10,000 combinations, so an unthrottled login-pin endpoint
// is an account-takeover vector. This is the per-phone online-guessing guard: N
// failures inside a rolling window locks the phone for a cooldown. Keys live in
// Redis (already the single-device authority store) with TTLs, so nothing to GC.
//
// IMPORTANT: a "locked" response is a BUSINESS error (HTTP 429) and MUST NOT carry
// an `auth_error` field — see constants/auth-codes.ts. It must never log the user out.
import { redis } from "@/config/redis";
import { to_e164 } from "@/utils/general.utils";

const MAX_ATTEMPTS = 5; // failures allowed inside the window before a lock
const WINDOW_SECONDS = 15 * 60; // failure counter lifetime (rolling)
const LOCK_SECONDS = 15 * 60; // cooldown once locked

const fails_key = (phone: string) => `pin:fails:${to_e164(phone)}`;
const lock_key = (phone: string) => `pin:lock:${to_e164(phone)}`;

export type PinLockStatus =
  | { locked: false; attempts_remaining: number }
  | { locked: true; retry_after: number }; // seconds until unlock

// Read-only: is this phone currently locked? Call BEFORE verifying a PIN.
const get_pin_lock_status = async (phone: string): Promise<PinLockStatus> => {
  const ttl = await redis.ttl(lock_key(phone));
  if (ttl > 0) return { locked: true, retry_after: ttl };
  const fails = Number((await redis.get(fails_key(phone))) ?? 0);
  return { locked: false, attempts_remaining: Math.max(0, MAX_ATTEMPTS - fails) };
};

// Record a wrong-PIN attempt. Locks the phone once MAX_ATTEMPTS is reached.
const register_pin_failure = async (phone: string): Promise<PinLockStatus> => {
  const key = fails_key(phone);
  const fails = await redis.incr(key);
  if (fails === 1) await redis.expire(key, WINDOW_SECONDS);

  if (fails >= MAX_ATTEMPTS) {
    await redis.set(lock_key(phone), "1", "EX", LOCK_SECONDS);
    await redis.del(key);
    return { locked: true, retry_after: LOCK_SECONDS };
  }
  return { locked: false, attempts_remaining: Math.max(0, MAX_ATTEMPTS - fails) };
};

// Clear counters on success (or after a legitimate PIN reset).
const clear_pin_attempts = async (phone: string): Promise<void> => {
  await redis.del(fails_key(phone), lock_key(phone));
};

export {
  get_pin_lock_status,
  register_pin_failure,
  clear_pin_attempts,
  MAX_ATTEMPTS,
  LOCK_SECONDS,
};
