import db from "@/config/db";
import { app_settings_model } from "@/models/app-settings.model";
import { eq } from "drizzle-orm";

// The marquee banner shown on the app's group-list screen. Text is authored by
// the super admin from the admin panel; the app reads it from a public endpoint.
export type MarqueeBanner = {
  text: string;
  enabled: boolean;
  updated_at: string | null;
};

const MARQUEE_KEY = "marquee_banner";

const DEFAULT_MARQUEE: MarqueeBanner = {
  text: "",
  enabled: false,
  updated_at: null,
};

// Tiny in-memory cache so the public endpoint doesn't hit Postgres on every
// app launch/resume. The banner is non-critical, so a small staleness window is
// fine — set_marquee_banner() invalidates it on write.
const CACHE_TTL_MS = 60_000;
let cache: { value: MarqueeBanner; expires: number } | null = null;

export const get_marquee_banner = async (): Promise<MarqueeBanner> => {
  if (cache && cache.expires > Date.now()) return cache.value;

  const rows = await db
    .select()
    .from(app_settings_model)
    .where(eq(app_settings_model.key, MARQUEE_KEY))
    .limit(1);

  let value: MarqueeBanner = DEFAULT_MARQUEE;
  if (rows.length > 0) {
    const raw = (rows[0].value ?? {}) as Partial<MarqueeBanner>;
    value = {
      text: typeof raw.text === "string" ? raw.text : "",
      enabled: raw.enabled === true,
      updated_at: rows[0].updated_at
        ? new Date(rows[0].updated_at).toISOString()
        : null,
    };
  }

  cache = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
};

export type SetMarqueeInput = {
  text: string;
  enabled: boolean;
};

export const set_marquee_banner = async (
  input: SetMarqueeInput,
  adminId: string,
): Promise<MarqueeBanner> => {
  const updated_at = new Date();
  const payload = { text: input.text, enabled: input.enabled };

  await db
    .insert(app_settings_model)
    .values({
      key: MARQUEE_KEY,
      value: payload,
      updated_by: adminId,
      updated_at,
    })
    .onConflictDoUpdate({
      target: app_settings_model.key,
      set: { value: payload, updated_by: adminId, updated_at },
    });

  const value: MarqueeBanner = {
    text: input.text,
    enabled: input.enabled,
    updated_at: updated_at.toISOString(),
  };

  // Refresh the cache so the next public read sees the new value immediately.
  cache = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
};

// ─── Single-device lock (kill-switch) ───────────────────────────────────────
// Global toggle for the device-lock feature. When OFF, login reverts to the
// legacy last-login-wins behaviour (the pre-mint gate short-circuits to allowed).
// Read hot on every gated login, so it is cached like the marquee. Defaults to
// DISABLED when the row is absent, so the feature stays dormant until an admin
// explicitly enables it from the panel (safe, controlled rollout).
export type SingleDeviceLock = {
  enabled: boolean;
  updated_at: string | null;
};

const SINGLE_DEVICE_LOCK_KEY = "single_device_lock";

const DEFAULT_SINGLE_DEVICE_LOCK: SingleDeviceLock = {
  enabled: false,
  updated_at: null,
};

let lockCache: { value: SingleDeviceLock; expires: number } | null = null;

export const get_single_device_lock = async (): Promise<SingleDeviceLock> => {
  if (lockCache && lockCache.expires > Date.now()) return lockCache.value;

  const rows = await db
    .select()
    .from(app_settings_model)
    .where(eq(app_settings_model.key, SINGLE_DEVICE_LOCK_KEY))
    .limit(1);

  let value: SingleDeviceLock = DEFAULT_SINGLE_DEVICE_LOCK;
  if (rows.length > 0) {
    const raw = (rows[0].value ?? {}) as Partial<SingleDeviceLock>;
    value = {
      enabled: raw.enabled === true,
      updated_at: rows[0].updated_at
        ? new Date(rows[0].updated_at).toISOString()
        : null,
    };
  }

  lockCache = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
};

export const set_single_device_lock = async (
  enabled: boolean,
  adminId: string,
): Promise<SingleDeviceLock> => {
  const updated_at = new Date();
  const payload = { enabled };

  await db
    .insert(app_settings_model)
    .values({
      key: SINGLE_DEVICE_LOCK_KEY,
      value: payload,
      updated_by: adminId,
      updated_at,
    })
    .onConflictDoUpdate({
      target: app_settings_model.key,
      set: { value: payload, updated_by: adminId, updated_at },
    });

  const value: SingleDeviceLock = { enabled, updated_at: updated_at.toISOString() };
  lockCache = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
};
