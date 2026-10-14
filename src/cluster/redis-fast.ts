import Redis from "ioredis";

// =============================================================================
// rfast — the "fail fast" Redis connection (SYNC_V2 §13.3 redis-fast.ts)
// =============================================================================
// The main client (config/redis.ts) has ioredis defaults: an offline queue and
// 20 retries per request, so during a Redis blip every awaited call hangs for
// seconds. That is acceptable for the pending store, NOT for liveness work:
// a worker beat or a readiness probe that hangs is indistinguishable from a
// wedged process. rfast never queues while disconnected (the call fails at
// once), retries a command at most once, and times out after 400 ms. Callers
// also wrap calls in deadline() so a stuck socket cannot outlive its budget.
//
// Used for: worker beat, boot guard, drain sibling check, readyz. RC-2 adds
// presence + router.

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not defined in environment variables");
}

const rfast = new Redis(process.env.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 400,
  connectTimeout: 2000,
});

// Without an 'error' listener ioredis prints "[ioredis] Unhandled error
// event" for every reconnect attempt. Log state changes, rate-limited.
let last_error_log_at = 0;
rfast.on("error", (err) => {
  const now = Date.now();
  if (now - last_error_log_at < 30_000) return;
  last_error_log_at = now;
  console.error(`[RFAST] redis error: ${err?.message ?? err}`);
});
rfast.on("ready", () => console.log("[RFAST] connected"));

class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms`);
    this.name = "DeadlineError";
  }
}

// Reject if `p` has not settled within `ms`. The underlying work is not
// cancelled (ioredis has no cancel); only the caller stops waiting.
const deadline = <T>(p: Promise<T>, ms: number, label = "redis"): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const rfast_ping = async (ms = 500): Promise<boolean> => {
  try {
    return (await deadline(rfast.ping(), ms, "rfast ping")) === "PONG";
  } catch {
    return false;
  }
};

// Boot: retry until rfast answers (0.5 → 1 → 2 → 5 s, capped) or a drain
// starts. It connects lazily in the background; with no offline queue a
// command before the first connect fails at once, hence the retry.
const RFAST_RETRY_BACKOFF_MS = [500, 1000, 2000, 5000];
const wait_for_rfast = async (should_stop: () => boolean = () => false): Promise<boolean> => {
  for (let attempt = 0; !should_stop(); attempt++) {
    if (await rfast_ping(1000)) return true;
    const wait = RFAST_RETRY_BACKOFF_MS[Math.min(attempt, RFAST_RETRY_BACKOFF_MS.length - 1)];
    if (attempt > 0) console.error(`[RFAST] ping failed (attempt ${attempt + 1}), retrying in ${wait}ms`);
    await Bun.sleep(wait);
  }
  return false;
};

export { rfast, deadline, rfast_ping, wait_for_rfast, DeadlineError };
