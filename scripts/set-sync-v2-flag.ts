/**
 * Set one Sync v2 flag in app_settings and tell every running worker at once
 * (settings:invalidate, SYNC_V2 §13.7 E7). Without the message a worker sees
 * a flip within its 5 s refresh; with it, within one round trip.
 *
 * Usage:
 *   bun run scripts/set-sync-v2-flag.ts <key> <value>
 *
 * Keys: sync_v2 (off | shadow | on), sync_v2_system_rows, sync_v2_delivered_staging,
 *       sync_v2_proto_lease, sync_v2_server_expiry (on | off),
 *       sync_v2_rollout_pct (0..100; users advertised syncProto 2, default 0),
 *       sync_v2_ack_fallback (on | off; FCM push for unacked foreground WS
 *       message:new, default off), sync_v2_net_telemetry (on | off; FCM
 *       health counters + network beacon intake, default off),
 *       sync_v2_chunked_upload (on | off; chunked resumable uploads
 *       /api/media/upload/init…, default off; also needs the 20261024 marker),
 *       sync_v2_inline_thumbs (on | off; keep inline attachments[i].thumb at
 *       ingress, default off = dropped; the kill switch for thumb bytes).
 * Markers (sync_v2_schema, sync_v2_backfill, …) are NOT settable here: the
 * ledger scripts and the build write those.
 *
 * Examples:
 *   bun run scripts/set-sync-v2-flag.ts sync_v2 shadow
 *   bun run scripts/set-sync-v2-flag.ts sync_v2_system_rows on
 */
import "dotenv/config";
import { redis } from "@/config/redis";
import { close_db } from "@/config/db";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";
import { SYNC_V2_FLAG_KEYS, set_sync_v2_flag } from "@/services/app-settings.service";

const main = async () => {
  const [key, raw] = process.argv.slice(2);
  if (!key || raw === undefined || !SYNC_V2_FLAG_KEYS.includes(key)) {
    console.error(`Usage: bun run scripts/set-sync-v2-flag.ts <${SYNC_V2_FLAG_KEYS.join("|")}> <value>`);
    process.exit(1);
  }
  const value = raw.trim().toLowerCase();
  let stored: unknown = value;
  if (key === SYNC_V2_KEYS.mode) {
    if (!["off", "shadow", "on"].includes(value)) {
      console.error(`${key} must be off | shadow | on`);
      process.exit(1);
    }
  } else if (key === SYNC_V2_KEYS.rollout_pct) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      console.error(`${key} must be an integer 0..100`);
      process.exit(1);
    }
    stored = n;
  } else if (!["on", "off"].includes(value)) {
    console.error(`${key} must be on | off`);
    process.exit(1);
  }

  await set_sync_v2_flag(key, stored);
  console.log(`✅ ${key} = ${value} (workers notified via settings:invalidate)`);
  await redis.quit();
  await close_db(3);
  process.exit(0);
};

main().catch((err) => {
  console.error("❌ Failed to set the flag:", err);
  process.exit(1);
});
