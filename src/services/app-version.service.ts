import { redis } from "@/config/redis";
import { SETTINGS, publish_settings_invalidation } from "@/cluster/settings-invalidate";

export type AppPlatform = "android" | "ios";

export type AppVersionInfo = {
  platform: AppPlatform;
  min_build: number;
  latest_build: number;
  latest_version: string;
  store_url: string;
  message: string | null;
  updated_at: string | null;
};

const REDIS_KEY = (platform: AppPlatform) => `app:version:${platform}`;

const DEFAULT_STORE_URL: Record<AppPlatform, string> = {
  android: "https://play.google.com/store/apps/details?id=com.aiexch.amigo",
  ios: "https://apps.apple.com/app/id0",
};

// Tiny in-memory cache so the public endpoint doesn't hammer Redis. The
// version is set by a CLI script (another process), so before RC-3 every
// worker served the old gate for up to CACHE_TTL_MS; set_app_version now
// publishes settings:invalidate and every worker drops its copy (E6). The
// TTL only bounds a lost message.
const CACHE_TTL_MS = 60_000;
const cache = new Map<AppPlatform, { value: AppVersionInfo; expires: number }>();

export const invalidate_app_version_cache = (platform?: AppPlatform): void => {
  if (platform) cache.delete(platform);
  else cache.clear();
};

export const get_app_version = async (
  platform: AppPlatform,
): Promise<AppVersionInfo | null> => {
  const cached = cache.get(platform);
  if (cached && cached.expires > Date.now()) return cached.value;

  const raw = await redis.hgetall(REDIS_KEY(platform));
  if (!raw || Object.keys(raw).length === 0) return null;

  const min_build = Number(raw.min_build);
  const latest_build = Number(raw.latest_build);
  if (!Number.isFinite(min_build) || !Number.isFinite(latest_build)) return null;

  const value: AppVersionInfo = {
    platform,
    min_build,
    latest_build,
    latest_version: raw.latest_version || "",
    store_url: raw.store_url || DEFAULT_STORE_URL[platform],
    message: raw.message || null,
    updated_at: raw.updated_at || null,
  };

  cache.set(platform, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
};

export type SetAppVersionInput = {
  platform: AppPlatform;
  latest_version: string;
  latest_build: number;
  min_build?: number;       // defaults to latest_build (every release mandatory)
  store_url?: string;
  message?: string | null;
};

export const set_app_version = async (
  input: SetAppVersionInput,
): Promise<AppVersionInfo> => {
  const min_build = input.min_build ?? input.latest_build;
  const store_url = input.store_url || DEFAULT_STORE_URL[input.platform];
  const updated_at = new Date().toISOString();

  const fields: Record<string, string> = {
    min_build: String(min_build),
    latest_build: String(input.latest_build),
    latest_version: input.latest_version,
    store_url,
    updated_at,
  };
  if (input.message !== undefined && input.message !== null) {
    fields.message = input.message;
  }

  const key = REDIS_KEY(input.platform);
  // If caller explicitly cleared the message, drop the existing field.
  if (input.message === null) {
    await redis.hdel(key, "message");
  }
  await redis.hset(key, fields);

  cache.delete(input.platform);
  await publish_settings_invalidation(SETTINGS.app_version(input.platform));

  return {
    platform: input.platform,
    min_build,
    latest_build: input.latest_build,
    latest_version: input.latest_version,
    store_url,
    message: input.message ?? null,
    updated_at,
  };
};
