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
 */

import "dotenv/config";
import { redis } from "@/config/redis";
import { set_app_version, type AppPlatform } from "@/services/app-version.service";

type Flags = {
  min?: number;
  url?: string;
  msg?: string;
};

const usage = () => {
  console.log(
    `Usage: bun run version:set <platform> <version> <build> [--min=<build>] [--url=<url>] [--msg="<text>"]\n` +
    `       platform: android | ios`,
  );
};

const parse_flags = (argv: string[]): Flags => {
  const out: Flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
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

  await redis.quit();
  process.exit(0);
};

main().catch((err) => {
  console.error("❌ Failed to set app version:", err);
  process.exit(1);
});
