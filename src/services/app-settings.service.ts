import db from "@/config/db";
import { app_settings_model } from "@/models/app-settings.model";
import { eq, sql as dsql } from "drizzle-orm";
import {
  DEFAULT_SYNC_V2_FLAGS,
  describe_live_features,
  dualwrite_active,
  parse_sync_v2_flags,
  type SyncV2Flags,
} from "@/services/sync/flags-core";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";
import { SETTINGS, publish_settings_invalidation } from "@/cluster/settings-invalidate";

// The marquee banner shown on the app's group-list screen. Text is authored by
// the super admin from the admin panel; the app reads it from a public endpoint.
export type MarqueeBanner = {
  text: string;
  enabled: boolean;
  updated_at: string | null;
};

const MARQUEE_KEY = SETTINGS.marquee;

const DEFAULT_MARQUEE: MarqueeBanner = {
  text: "",
  enabled: false,
  updated_at: null,
};

// Tiny in-memory cache so the public endpoint doesn't hit Postgres on every
// app launch/resume. set_marquee_banner() refreshes the writer's copy and
// publishes settings:invalidate so every other worker drops its copy at once
// (RC-3 E5); the TTL only bounds a lost invalidation.
const CACHE_TTL_MS = 60_000;
let cache: { value: MarqueeBanner; expires: number } | null = null;

// The writer's own message drops its fresh copy too (the bus delivers to the
// publisher): one extra indexed read, and never "two admins wrote within a
// second on two workers and one kept the older banner".
export const invalidate_marquee_cache = (): void => {
  cache = null;
};

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

  // Refresh the cache so the next public read sees the new value immediately,
  // then tell the other workers to drop theirs.
  cache = { value, expires: Date.now() + CACHE_TTL_MS };
  await publish_settings_invalidation(MARQUEE_KEY);
  return value;
};

// =============================================================================
// Sync v2 flags + markers (SYNC_V2_PROTOCOL.md §3.4 "Flag", §9 row 2, §9.1)
// =============================================================================
// Hot paths read a cached snapshot synchronously (`sync_v2_flags()`), so a
// flag never costs a round trip on a send / receipt / fan-out. One small
// indexed query per worker every SYNC_V2_FLAGS_REFRESH_MS keeps it fresh, so
// an admin flip reaches every worker within that window (cluster-coherent
// enough: every switch is safe to apply at slightly different moments on
// different workers). Until the first load succeeds the defaults apply, and
// the defaults are the "nothing new happens" values.

const SYNC_V2_FLAGS_REFRESH_MS = 5_000;
let sync_v2_snapshot: SyncV2Flags = DEFAULT_SYNC_V2_FLAGS;
let sync_v2_timer: ReturnType<typeof setInterval> | null = null;
let sync_v2_inflight: Promise<SyncV2Flags> | null = null;
let sync_v2_marker_meta: Record<string, unknown> = {};

export const sync_v2_flags = (): SyncV2Flags => sync_v2_snapshot;

// Upsert one app_settings marker. Markers are facts about this deployment
// ("this code is live", "receipts are dual-written"), read by the ledger
// scripts' preconditions.
export const write_sync_v2_marker = async (key: string, value: unknown): Promise<void> => {
  await db
    .insert(app_settings_model)
    .values({ key, value, updated_at: new Date() })
    .onConflictDoUpdate({
      target: app_settings_model.key,
      set: { value, updated_at: new Date() },
    });
  // Every worker re-reads its snapshot now, not at its next 5 s tick (E7).
  await publish_settings_invalidation(key);
};

// The FLAGS a person flips (scripts/set-sync-v2-flag.ts). Markers are
// written by the ledger scripts / the build itself, never through here.
export const SYNC_V2_FLAG_KEYS: readonly string[] = [
  SYNC_V2_KEYS.mode,
  SYNC_V2_KEYS.system_rows,
  SYNC_V2_KEYS.delivered_staging,
  SYNC_V2_KEYS.proto_lease,
  SYNC_V2_KEYS.server_expiry,
  SYNC_V2_KEYS.rollout_pct,
  SYNC_V2_KEYS.ack_fallback,
  SYNC_V2_KEYS.net_telemetry,
  SYNC_V2_KEYS.chunked_upload,
  SYNC_V2_KEYS.inline_thumbs,
];

/**
 * Set one Sync v2 flag and tell every worker (E7): each refreshes its
 * snapshot when the message arrives instead of within its 5 s tick. A flip
 * done directly in SQL still works; it is just seen within ≤ 5 s.
 */
export const set_sync_v2_flag = async (key: string, value: unknown): Promise<void> => {
  if (!SYNC_V2_FLAG_KEYS.includes(key)) throw new Error(`not a sync_v2 flag: ${key}`);
  await write_sync_v2_marker(key, value);
};

// [FEATURES] block: what this build is doing right now, in plain words.
const features_signature = (f: SyncV2Flags): string =>
  describe_live_features(f).join("\n");
const log_live_features = (f: SyncV2Flags, when: string): void => {
  console.log(`[FEATURES] what is live (${when}):\n${describe_live_features(f).map((l) => `[FEATURES]   ${l}`).join("\n")}`);
};

export const refresh_sync_v2_flags = async (): Promise<SyncV2Flags> => {
  if (sync_v2_inflight) return sync_v2_inflight;
  sync_v2_inflight = (async () => {
    try {
      const rows = await db
        .select({ key: app_settings_model.key, value: app_settings_model.value })
        .from(app_settings_model)
        .where(dsql`left(${app_settings_model.key}, 7) = 'sync_v2'`);
      const next = parse_sync_v2_flags(rows);
      const prev = sync_v2_snapshot;
      sync_v2_snapshot = next;
      if (prev.loaded && (prev.mode !== next.mode || prev.system_rows !== next.system_rows
        || prev.proto_lease !== next.proto_lease || prev.server_expiry !== next.server_expiry)) {
        console.log(`[SYNCV2] flags changed ${JSON.stringify({ mode: next.mode, system_rows: next.system_rows, proto_lease: next.proto_lease, server_expiry: next.server_expiry })}`);
      }
      // Any user-visible switch moved (incl. rollout and the extra features):
      // say in plain words what is live now.
      if (prev.loaded && features_signature(prev) !== features_signature(next)) {
        log_live_features(next, "changed");
      }
      // The dual-write marker says "apply_receipts is live": 20261022
      // (watermarks) refuses to run before it, because a watermark computed
      // while receipts are not yet written to PG would freeze too low.
      // Written once, never cleared (switching back to off later means the
      // watermark script must be re-run before R1b anyway, §3.4).
      if (dualwrite_active(next) && !next.markers.dualwrite) {
        await write_sync_v2_marker(SYNC_V2_KEYS.dualwrite, { at: new Date().toISOString(), ...sync_v2_marker_meta });
        sync_v2_snapshot = { ...next, markers: { ...next.markers, dualwrite: true } };
        console.log(`[SYNCV2] marker ${SYNC_V2_KEYS.dualwrite} written`);
      }
    } catch (err: any) {
      // Keep the last good snapshot (or the safe defaults).
      console.error(`[SYNCV2] flags refresh failed: ${err?.message ?? err}`);
    } finally {
      sync_v2_inflight = null;
      // An invalidation arrived while this read was out: it may have read the
      // value from before the write, so read once more.
      if (sync_v2_rerun) {
        sync_v2_rerun = false;
        void refresh_sync_v2_flags();
      }
    }
    return sync_v2_snapshot;
  })();
  return sync_v2_inflight;
};

// settings:invalidate for a sync_v2 key (RC-3 E7). Unlike a plain call it
// never piggybacks on a read that started before the write.
let sync_v2_rerun = false;
export const refresh_sync_v2_flags_soon = (): void => {
  if (sync_v2_inflight) {
    sync_v2_rerun = true;
    return;
  }
  void refresh_sync_v2_flags();
};

/**
 * Boot: write sync_v2_code_deployed (the backfill's precondition: the code
 * that guards the legacy pointer writers is live), load the flags once, then
 * refresh on an interval. Returns the stopper for the drain.
 */
export const start_sync_v2_flags = async (meta: Record<string, unknown>): Promise<() => Promise<void>> => {
  sync_v2_marker_meta = meta;
  try {
    await write_sync_v2_marker(SYNC_V2_KEYS.code_deployed, { at: new Date().toISOString(), ...meta });
  } catch (err: any) {
    console.error(`[SYNCV2] could not write ${SYNC_V2_KEYS.code_deployed}: ${err?.message ?? err}`);
  }
  await refresh_sync_v2_flags();
  const f = sync_v2_snapshot;
  console.log(`[SYNCV2] mode=${f.mode} system_rows=${f.system_rows} proto_lease=${f.proto_lease} server_expiry=${f.server_expiry} markers=${JSON.stringify(f.markers)}`);
  log_live_features(f, "at boot");
  if (!sync_v2_timer) {
    sync_v2_timer = setInterval(() => void refresh_sync_v2_flags(), SYNC_V2_FLAGS_REFRESH_MS);
  }
  return async () => {
    if (sync_v2_timer) clearInterval(sync_v2_timer);
    sync_v2_timer = null;
    if (sync_v2_inflight) await sync_v2_inflight.catch(() => undefined);
  };
};
