import { redis } from "@/config/redis";
import { ActiveCall } from "@/services/livekit.service";

function getCallKey(call_id: string): string {
  return `calls:active_calls:${call_id}`;
}

function getUserCallKey(user_id: string): string {
  return `calls:user:${user_id}`;
}

async function setUserCallCache(call_id: string, user_id: string) {
  try {
    await redis.set(getUserCallKey(user_id), call_id);
  } catch (error) {
    console.error(`Failed to set user call cache: ${error}`);
    throw new Error(`Failed to set user call cache: ${error}`);
  }
}

async function setActiveCallsCache(activeCall: ActiveCall) {
  try {
    await redis.hset(getCallKey(activeCall.call_id), activeCall);
  } catch (error) {
    console.error(`Failed to set active calls cache: ${error}`);
    throw new Error(`Failed to set active calls cache: ${error}`);
  }
}

export { setUserCallCache, setActiveCallsCache };
