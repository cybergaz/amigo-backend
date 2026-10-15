import { bus } from "./bus";
import { k } from "./keys";

// =============================================================================
// settings:invalidate (SYNC_V2 §13.4, §13.7 E5–E7)
// =============================================================================
// Small settings are cached per process: the marquee banner (60 s), the
// app-version gate (60 s) and the Sync v2 flags snapshot (re-read every 5 s).
// A write used to refresh only the copy of the process that made it (the
// admin route's worker, or nobody at all when a CLI script wrote it), so the
// other workers served the old value for up to the TTL. Every writer now
// publishes the setting's key here; every worker drops / refreshes its copy
// when the message arrives (settings-listener.ts). Best effort: a lost
// message is still bounded by the TTL / the 5 s flag refresh, and a bus
// reconnect refreshes everything.
//
// Publish-only on purpose (no subscriber, no service imports): CLI scripts
// import the writers, and a script must not open a subscriber connection.

const SETTINGS = {
  marquee: "marquee_banner",
  app_version: (platform: string) => `app_version:${platform}`,
  // Any app_settings key starting with "sync_v2" (flags and markers).
  sync_v2_prefix: "sync_v2",
} as const;

const publish_settings_invalidation = async (key: string): Promise<void> => {
  await bus.publish(k.settings_invalidate(), key);
};

export { SETTINGS, publish_settings_invalidation };
