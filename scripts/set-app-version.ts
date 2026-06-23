/**
 * Usage:
 *   bun run version:set <platform> <version> <build> [--min=<build>] [--url=<url>] [--msg="<text>"]
 *
 * Examples:
 *   # Force everyone onto 3.0.4 (build 15) — every release mandatory
 *   bun run version:set android 3.0.4 15
 *
 *   # Soft update: ship 3.0.4 (build 15) but leave the cutoff at build 12
 *   bun run version:set android 3.0.4 15 --min=12
 *
 *   # With release-note message and override store URL
 *   bun run version:set android 3.0.5 16 --msg="Critical message-delivery fix"
 *
 *   # Set the version but DON'T push the update notification to users
 *   bun run version:set android 3.0.5 16 --no-notify
 *
 * By default, setting a version also broadcasts an "update available" push to
 * every user with an FCM token (batched to spare the server). Tapping it opens
 * the store. Pass --no-notify to skip the broadcast.
 */

import "dotenv/config";
import { redis } from "@/config/redis";
import { set_app_version, type AppPlatform } from "@/services/app-version.service";
import { broadcast_version_update } from "@/services/app-update-notify.service";

type Flags = {
  min?: number;
  url?: string;
  msg?: string;
  notify?: boolean;
};

const usage = () => {
  console.log(
    `Usage: bun run version:set <platform> <version> <build> [--min=<build>] [--url=<url>] [--msg="<text>"] [--no-notify]\n` +
    `       platform: android | ios`,
  );
};

const parse_flags = (argv: string[]): Flags => {
  const out: Flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    // Boolean flags (no '=').
    if (arg === "--no-notify") { out.notify = false; continue; }
    if (arg === "--notify") { out.notify = true; continue; }
    const eq = arg.indexOf("=");
    if (eq === -1) continue;
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === "min") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        console.error(`Invalid --min value: ${value}`);
        process.exit(1);
      }
      out.min = n;
    } else if (key === "url") {
      out.url = value;
    } else if (key === "msg") {
      out.msg = value;
    } else {
      console.error(`Unknown flag: --${key}`);
      process.exit(1);
    }
  }
  return out;
};

const main = async () => {
  const [platform_arg, version, build_arg, ...rest] = process.argv.slice(2);
  if (!platform_arg || !version || !build_arg) {
    usage();
    process.exit(1);
  }

  if (platform_arg !== "android" && platform_arg !== "ios") {
    console.error(`Invalid platform: ${platform_arg}`);
    usage();
    process.exit(1);
  }

  const build = Number(build_arg);
  if (!Number.isFinite(build) || build <= 0) {
    console.error(`Invalid build number: ${build_arg}`);
    process.exit(1);
  }

  const flags = parse_flags(rest);

  const result = await set_app_version({
    platform: platform_arg as AppPlatform,
    latest_version: version,
    latest_build: build,
    min_build: flags.min,
    store_url: flags.url,
    message: flags.msg ?? null,
  });

  console.log(`✅ App version updated for ${result.platform}`);
  console.log(JSON.stringify(result, null, 2));

  // Broadcast the "update available" push to all users (unless opted out).
  if (flags.notify === false) {
    console.log("🔕 Skipped update notification (--no-notify).");
  } else {
    console.log("📣 Broadcasting update notification to all users…");
    try {
      const stats = await broadcast_version_update(result);
      console.log(
        `📣 Notification broadcast: recipients=${stats.recipients} ` +
        `sent=${stats.sent} failed=${stats.failed} waves=${stats.waves}`,
      );
    } catch (err) {
      // The version is already set; a notification failure shouldn't fail the
      // whole command. Surface it and continue to a clean exit.
      console.error("⚠️  Update notification broadcast failed:", err);
    }
  }

  await redis.quit();
  process.exit(0);
};

main().catch((err) => {
  console.error("❌ Failed to set app version:", err);
  process.exit(1);
});
