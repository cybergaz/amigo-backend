/**
 * Local testing switches: every new feature on, or back to the post-deploy
 * baseline. DEV DATABASES ONLY: refuses anything the ledger treats as prod.
 *
 * Usage:
 *   bun run dev:all-on    # sync v2 ON for 100% of new apps + every extra feature
 *   bun run dev:all-off   # back to the baseline prod has right after deploy
 *
 * all-on, in order (the same steps as the ship plan's flag flips):
 *   sync_v2_rollout_pct 0 → ledger 20261022 --force (fresh watermarks; skipped
 *   when sync v2 is already on) → sync_v2 on → sync_v2_rollout_pct 100 →
 *   system_rows, proto_lease, ack_fallback, net_telemetry, chunked_upload,
 *   inline_thumbs on.
 * all-off: rollout 0, every extra feature off, sync_v2 shadow. Shadow, not
 *   off: apps see exactly the old sync either way, and shadow keeps the new
 *   bookkeeping running, so a later all-on doesn't start from stale numbers.
 *
 * The flags live in the database, so they also apply to every other backend
 * on the same database (e.g. the EC2 test instance shares the dev DB).
 * Running backends pick the change up within ~5 s and log a [FEATURES] block.
 */
import "dotenv/config";
import { redis } from "@/config/redis";
import { close_db } from "@/config/db";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";
import { refresh_sync_v2_flags, set_sync_v2_flag } from "@/services/app-settings.service";
import { describe_live_features } from "@/services/sync/flags-core";
import { target } from "./lib/migration";

const EXTRAS = [
  SYNC_V2_KEYS.system_rows,
  SYNC_V2_KEYS.proto_lease,
  SYNC_V2_KEYS.ack_fallback,
  SYNC_V2_KEYS.net_telemetry,
  SYNC_V2_KEYS.chunked_upload,
  SYNC_V2_KEYS.inline_thumbs,
] as const;

const set = async (key: string, value: unknown) => {
  await set_sync_v2_flag(key, value);
  console.log(`  ✔ ${key} = ${value}`);
};

const done = async (code: number) => {
  await redis.quit().catch(() => undefined);
  await close_db(3).catch(() => undefined);
  process.exit(code);
};

const main = async () => {
  const which = (process.argv[2] ?? "").trim().toLowerCase();
  if (which !== "on" && which !== "off") {
    console.error("Usage: bun run dev:all-on | bun run dev:all-off");
    return done(1);
  }
  const t = target();
  console.log(`\n  target: ${t.label}  [${t.env}]\n`);
  if (!t.isDev) {
    console.error("  ❌ Refusing: this is not a dev database. On prod, flip flags one at a time (ship plan).");
    return done(1);
  }

  const before = await refresh_sync_v2_flags();
  if (which === "on") {
    const m = before.markers;
    if (!(m.schema && m.triggers && m.backfill && m.indexes_post && m.dualwrite)) {
      console.error(`  ❌ The sync v2 database steps aren't done on this DB yet (markers: ${JSON.stringify(m)}).`);
      console.error("     Run the ship plan's stage 2 ledger steps first (20261020a … 20261022, with sync_v2 shadow).");
      return done(1);
    }
    if (before.mode !== "on") {
      await set(SYNC_V2_KEYS.rollout_pct, 0);
      console.log("  … ledger 20261022 --force (fresh watermarks before sync v2 on)");
      const p = Bun.spawn(["bun", "run", "script:migrate", "up", "20261022-sync-v2-watermarks", "--force"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await p.exited) !== 0) {
        console.error("  ❌ 20261022 --force failed; nothing else changed (rollout is 0).");
        return done(1);
      }
      await set(SYNC_V2_KEYS.mode, "on");
    }
    await set(SYNC_V2_KEYS.rollout_pct, 100);
    for (const k of EXTRAS) await set(k, "on");
  } else {
    await set(SYNC_V2_KEYS.rollout_pct, 0);
    for (const k of EXTRAS) await set(k, "off");
    await set(SYNC_V2_KEYS.mode, "shadow");
  }

  const after = await refresh_sync_v2_flags();
  console.log("\n  Now live:");
  for (const line of describe_live_features(after)) console.log(`    ${line}`);
  console.log(
    which === "on"
      ? "\n  Force-quit and reopen the app on each phone. Check: diagnostics (Settings → About → long-press 1.5 s) shows SYNC lines.\n"
      : "\n  Apps are back on the old sync. Force-quit and reopen the app on each phone.\n",
  );
  return done(0);
};

main().catch(async (err) => {
  console.error("❌ dev flags failed:", err);
  await done(1);
});
