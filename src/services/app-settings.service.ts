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
