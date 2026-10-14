import Redis from 'ioredis';

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is not defined in environment variables');
}

const redis = new Redis(process.env.REDIS_URL);

const get_new_redis_client = (url?: string) => {
  if (url) {
    return new Redis(url);
  }
  return new Redis(process.env.REDIS_URL as string);
};

const redis_ping = async () => {
  try {
    await redis.ping();
    console.log('Connected to Redis successfully');
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    throw error;
  }
};

async function cleanRedis() {
  try {
    const result = await redis.flushall();
    console.log("Redis cleared:", result); // Should output "OK"
  } catch (error) {
    console.error("Error clearing Redis:", error);
  } finally {
    process.exit();
  }
}

// cleanRedis();

// The ping used to run here at import time with no catch: a Redis outage at
// boot became an unhandled rejection while the server listened anyway.
// server.ts boot() now awaits wait_for_redis() BEFORE listening.
const REDIS_RETRY_BACKOFF_MS = [500, 1000, 2000, 5000];

// Retry PING with backoff 0.5 → 1 → 2 → 5 s (capped) until it answers or
// `should_stop()` says the process is shutting down. Never throws.
const wait_for_redis = async (should_stop: () => boolean = () => false): Promise<boolean> => {
  for (let attempt = 0; !should_stop(); attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounded: with the offline queue on, a PING against a dead Redis
      // waits through ~20 reconnects before rejecting; a drain signal must
      // not wait that long to be noticed.
      await Promise.race([
        redis_ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("PING exceeded 5000ms")), 5000);
        }),
      ]);
      return true;
    } catch {
      const wait = REDIS_RETRY_BACKOFF_MS[Math.min(attempt, REDIS_RETRY_BACKOFF_MS.length - 1)];
      console.error(`[REDIS] ping failed (attempt ${attempt + 1}), retrying in ${wait}ms`);
      await Bun.sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
};

export { redis, redis_ping, wait_for_redis, get_new_redis_client, cleanRedis };
