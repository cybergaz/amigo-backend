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
  const counts =
    `recipients=${stats.recipients} sent=${stats.sent} ` +
    `failed=${stats.failed} waves=${stats.waves}${stats.resumed ? " (resumed)" : ""}`;
  // A busy lease (another run, or the lease of a run killed with Ctrl-C,
  // held until its TTL) or a lost lease is NOT done: say so and exit
  // non-zero. The same command re-run later resumes from the cursor.
  const incomplete = stats.skipped === "busy" || !!stats.aborted;
  if (stats.skipped === "busy") {
    console.error(`❌ Not sent: another broadcast holds the lease (or a killed run's lease has not expired yet, ≤ 2 min). Re-run this command; it resumes from the cursor.`);
  } else if (stats.aborted) {
    console.error(`❌ Incomplete (${stats.aborted}): ${counts}. Re-run this command; it resumes from the cursor.`);
  } else {
    console.log(`✅ ${counts}`);
  }

  await redis.quit();
  process.exit(incomplete ? 2 : 0);
};

main().catch((err) => {
  console.error("❌ Failed to broadcast update notification:", err);
  process.exit(1);
});
