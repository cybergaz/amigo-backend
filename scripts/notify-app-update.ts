/**
 * Re-broadcast the "update available" push for the version currently stored in
 * Redis (set via `version:set`). Useful to nudge users again without changing
 * the version. Tapping the notification opens the store.
 *
 * Usage:
 *   bun run version:notify <platform> [--title="<text>"] [--body="<text>"]
 *
 * Examples:
 *   bun run version:notify android
 *   bun run version:notify android --title="Update Amigo" --body="New features inside"
 */

import "dotenv/config";
import { redis } from "@/config/redis";
import { get_app_version, type AppPlatform } from "@/services/app-version.service";
import { broadcast_version_update } from "@/services/app-update-notify.service";

const main = async () => {
  const [platform_arg, ...rest] = process.argv.slice(2);

  if (platform_arg !== "android" && platform_arg !== "ios") {
    console.error(
      `Usage: bun run version:notify <android|ios> [--title="<text>"] [--body="<text>"]`,
    );
    process.exit(1);
  }

  let title: string | undefined;
  let body: string | undefined;
  for (const arg of rest) {
    if (arg.startsWith("--title=")) title = arg.slice("--title=".length);
    else if (arg.startsWith("--body=")) body = arg.slice("--body=".length);
  }

  const info = await get_app_version(platform_arg as AppPlatform);
  if (!info) {
    console.error(
      `No app version is set for ${platform_arg}. Run \`version:set\` first.`,
    );
    process.exit(1);
  }

  console.log(
    `📣 Broadcasting update notification for ${platform_arg} v${info.latest_version}…`,
  );
  const stats = await broadcast_version_update(info, { title, body });
  console.log(
    `✅ recipients=${stats.recipients} sent=${stats.sent} ` +
    `failed=${stats.failed} batches=${stats.batches}`,
  );

  await redis.quit();
  process.exit(0);
};

main().catch((err) => {
  console.error("❌ Failed to broadcast update notification:", err);
  process.exit(1);
});
