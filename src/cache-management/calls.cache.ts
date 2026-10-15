import { redis } from "@/config/redis";
import { ActiveCall } from "@/services/livekit.service";
import { create_call_reservations, user_call_key } from "./call-reserve";

/**
 * Backstop TTL for every call cache key.
 *
 * The authoritative clear happens in `LivekitService.clear_call_cache` on
 * terminate/timeout. This TTL only exists so a process crash (or a client that
 * dies mid-ring without ever sending `call:terminate`) can't leave a user
 * permanently marked "already in a call" — which is unrecoverable for them
 * without a manual Redis wipe.
 */
const CALL_CACHE_TTL_SECONDS = 4 * 60 * 60; // 4 hours

function getCallKey(call_id: string): string {
  return `calls:active_calls:${call_id}`;
}

function getUserCallKey(user_id: string): string {
  return user_call_key(user_id);
}

/**
 * Redis hashes only hold strings. Dates go in as ISO strings (which is what
 * `parse_call_cache_row` expects on the way out) and absent fields are dropped
 * entirely — `hset` rejects `undefined` values, and a literal "undefined"
 * string would read back as a truthy `answered_at`, making an unanswered call
 * look answered.
 */
function serializeActiveCall(call: ActiveCall): Record<string, string> {
  const row: Record<string, string> = {};

  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    row[key] = value instanceof Date ? value.toISOString() : String(value);
  };

  put("call_id", call.call_id);
  put("caller_id", call.caller_id);
  put("callee_id", call.callee_id);
  put("started_at", call.started_at);
  put("answered_at", call.answered_at);
  put("ended_at", call.ended_at);
  put("status", call.status);
  put("reason", call.reason);
  put("call_type", call.call_type);
  // `timeout_timer` is a live NodeJS.Timeout — deliberately never cached.

  return row;
}

// Atomic busy reservation (SYNC_V2 §13.7 G1, call-reserve.ts). initiate_call
// reserves both parties with it instead of GET-then-SET.
const call_reservations = create_call_reservations(redis, CALL_CACHE_TTL_SECONDS);

async function setUserCallCache(call_id: string, user_id: string) {
  try {
    await redis.set(getUserCallKey(user_id), call_id, "EX", CALL_CACHE_TTL_SECONDS);
  } catch (error) {
    console.error(`Failed to set user call cache: ${error}`);
    throw new Error(`Failed to set user call cache: ${error}`);
  }
}

async function setActiveCallsCache(activeCall: ActiveCall) {
  try {
    const key = getCallKey(activeCall.call_id);
    await redis.hset(key, serializeActiveCall(activeCall));
    await redis.expire(key, CALL_CACHE_TTL_SECONDS);
  } catch (error) {
    console.error(`Failed to set active calls cache: ${error}`);
    throw new Error(`Failed to set active calls cache: ${error}`);
  }
}

export {
  call_reservations,
  setUserCallCache,
  setActiveCallsCache,
  serializeActiveCall,
  getCallKey,
  getUserCallKey,
  CALL_CACHE_TTL_SECONDS,
};
