import { invalidate_marquee_cache, refresh_sync_v2_flags_soon } from "@/services/app-settings.service";
import { invalidate_app_version_cache, type AppPlatform } from "@/services/app-version.service";
import { count } from "@/utils/counters";
import { bus } from "./bus";
import { k } from "./keys";
import { SETTINGS } from "./settings-invalidate";

// =============================================================================
// settings:invalidate subscriber (SYNC_V2 §13.7 E5–E7)
// =============================================================================
// Separate from settings-invalidate.ts (publish-only) so CLI scripts that
// write settings never import a subscriber. Started once by server boot().
//   marquee_banner           → drop the banner cache (next read: one PK select)
//   app_version:{platform}   → drop that platform's gate (next read: one HGETALL)
//   sync_v2*                 → re-read the flags snapshot now (one small
//                              indexed select; the 5 s refresh still runs, so
//                              a lost message keeps the old ≤ 5 s bound)
// A bus resync (messages lost while disconnected) does all three.

let started = false;

const handle = (key: string): void => {
  count("CLUSTER", "settings_invalidated");
  if (key === SETTINGS.marquee) {
    invalidate_marquee_cache();
  } else if (key.startsWith("app_version:")) {
    const platform = key.slice("app_version:".length);
    invalidate_app_version_cache(platform === "android" || platform === "ios" ? (platform as AppPlatform) : undefined);
  } else if (key.startsWith(SETTINGS.sync_v2_prefix)) {
    refresh_sync_v2_flags_soon();
  }
};

const start_settings_listener = (): void => {
  if (started) return;
  started = true;
  bus.on(k.settings_invalidate(), (message) => handle(message));
  bus.on_resync(() => {
    invalidate_marquee_cache();
    invalidate_app_version_cache();
    refresh_sync_v2_flags_soon();
  });
};

export { start_settings_listener, handle as handle_settings_invalidation };
