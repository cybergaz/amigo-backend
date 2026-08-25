/**
 * One-off repair: groups whose chats.creater_id went NULL, and the membership
 * caches those groups were left with.
 *
 * WHY: chats.creater_id is onDelete:'set null' and the admin panel hard-deletes
 * user rows, so deleting the account that created a group silently nulls the
 * group's creater_id. add_new_member then looked the creator up, found nothing
 * and THREW — after the chat_members rows had already committed (there is no
 * transaction) and BEFORE add_members() hydrated conv:{chat_id}:members. The
 * newly added users were therefore missing from the Redis member set, which is
 * what live fan-out, the offline pending queue and FCM all read — and
 * get_conversation_members trusts any non-empty set with no DB fallback. Triple
 * exclusion, invisible (the endpoint just 500'd), and only a full get_chat_list
 * (app restart) recovered them.
 *
 * The code fix (chat-group.service.ts: hydrate the cache before anything that
 * can throw + never throw on a missing creator) stops this happening again.
 * This script repairs what the old code already left behind.
 *
 * Steps:
 *   1. Report every chat with creater_id IS NULL.
 *   2. Backfill creater_id = owner_id where owner_id survived. owner_id is the
 *      transferable "current owner" and was itself backfilled from creater_id,
 *      so it is the closest correct value we have. Rows where BOTH are null
 *      can't be repaired here — they're listed for a manual
 *      /admin force_declare_group_creater.
 *   3. DEL conv:{chat_id}:members for every affected GROUP (via
 *      invalidate_conversation, so the LRU copy in every RUNNING worker is
 *      dropped too — a raw redis.del would leave those serving the stale set
 *      for minutes). The next read rehydrates from chat_members, which is the
 *      truth, so silently-excluded members start receiving fan-out immediately
 *      instead of waiting out the 24h Redis TTL. DMs are skipped: they take no
 *      part in this bug (owner_id is null for DMs, and members aren't added to
 *      a DM after creation).
 *
 * Idempotent — safe to re-run. A second run finds fewer/no null rows and simply
 * re-invalidates caches that are already correct (a rehydrate, not a change).
 * Backward-compatible — can be applied BEFORE or AFTER the new build ships.
 *
 * Two-stage archive: on a successful run the script moves itself one stage
 * along scripts/ → scripts/applied-dev/ → scripts/applied-archive/, so after
 * the dev run it stays runnable for prod:
 *
 *   dev:   bun run scripts/apply-fix-null-creater.ts
 *   prod:  bun run scripts/applied-dev/apply-fix-null-creater.ts
 */

import db from "@/config/db";
import { invalidate_conversation } from "@/cache-management/conv.cache";
import { sql } from "drizzle-orm";
import { mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// drizzle's db.execute returns the postgres.js RowList (array) for SELECT/RETURNING,
// but normalize defensively in case the driver wraps it in { rows }.
const as_rows = (res: unknown): any[] =>
  Array.isArray(res) ? res : ((res as { rows?: any[] })?.rows ?? []);

type AffectedChat = {
  id: string;
  title: string | null;
  type: string;
  owner_id: string | null;
};

async function main(): Promise<boolean> {
  // ── Step 1: report ──────────────────────────────────────────────────────
  const affected = as_rows(
    await db.execute(sql`
      SELECT id::text AS id,
             title,
             type,
             owner_id::text AS owner_id
      FROM chats
      WHERE creater_id IS NULL
      ORDER BY type, created_at
    `),
  ) as AffectedChat[];

  if (affected.length === 0) {
    console.log("[fix-null-creater] No chats with a NULL creater_id — nothing to repair.");
  } else {
    const groups = affected.filter((c) => c.type !== "dm");
    console.log(
      `[fix-null-creater] ${affected.length} chat(s) with creater_id IS NULL ` +
        `(${groups.length} group(s), ${affected.length - groups.length} dm(s)):`,
    );
    for (const c of groups) {
      console.log(
        `  ${c.id}  "${c.title ?? "(untitled)"}"  owner_id=${c.owner_id ?? "NULL"}`,
      );
    }
  }

  // ── Step 2: backfill creater_id from owner_id ───────────────────────────
  const repaired = as_rows(
    await db.execute(sql`
      UPDATE chats
      SET creater_id = owner_id
      WHERE creater_id IS NULL
        AND owner_id IS NOT NULL
      RETURNING id::text AS id
    `),
  ) as Array<{ id: string }>;

  console.log(`[fix-null-creater] Backfilled creater_id on ${repaired.length} chat(s).`);

  // Groups we could not repair: no creator AND no owner (both accounts gone).
  // They still work, but a human should hand them an owner via the admin
  // panel's "force declare creater" action.
  const unrepairable = affected.filter((c) => c.type !== "dm" && !c.owner_id);
  if (unrepairable.length > 0) {
    console.warn(
      `[fix-null-creater] ⚠️  ${unrepairable.length} group(s) have NEITHER creater_id NOR ` +
        `owner_id — assign one manually (admin → force declare creater):`,
    );
    for (const c of unrepairable) {
      console.warn(`  ${c.id}  "${c.title ?? "(untitled)"}"`);
    }
  }

  // ── Step 3: drop the stale membership caches ────────────────────────────
  // Every affected GROUP is a group where an add may have committed rows
  // without ever hydrating the cache, so the cached set can be missing members.
  // Blow it away and let the next read rebuild it from chat_members.
  const group_ids = affected.filter((c) => c.type !== "dm").map((c) => c.id);
  let invalidated = 0;
  for (const id of group_ids) {
    try {
      await invalidate_conversation(id);
      invalidated++;
    } catch (err) {
      console.error(`[fix-null-creater] failed to invalidate member cache for ${id}:`, err);
    }
  }
  if (group_ids.length > 0) {
    console.log(
      `[fix-null-creater] Invalidated conv:{id}:members for ${invalidated}/${group_ids.length} group(s).`,
    );
  }

  if (invalidated !== group_ids.length) {
    console.error(
      "[fix-null-creater] ❌ Some caches could not be invalidated — re-run once Redis is reachable.",
    );
    return false;
  }

  console.log(
    `[fix-null-creater] Done — affected: ${affected.length}, backfilled: ${repaired.length}, ` +
      `caches dropped: ${invalidated}, manual follow-up needed: ${unrepairable.length}.`,
  );
  return true;
}

const succeeded = await main().catch((err) => {
  console.error("[fix-null-creater] FAILED:", err);
  return false;
});

// Self-archive one stage along on success. The stage is inferred from where
// this file lives, so the same script runs unchanged on dev and prod:
//   scripts/             → applied-dev/      (dev run done, prod pending)
//   scripts/applied-dev/ → applied-archive/  (prod run done, fully applied)
if (succeeded) {
  try {
    const self = import.meta.path;
    const dir = dirname(self);
    const target = basename(dir) === "applied-dev"
      ? join(dir, "..", "applied-archive", basename(self))
      : join(dir, "applied-dev", basename(self));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(self, target);
    console.log(`📦 Archived to ${target}`);
  } catch (e) {
    console.warn("⚠️ Could not self-archive (harmless):", e);
  }
}

// The pg pool and the conv-cache's Redis subscriber keep the loop alive; every
// write above is already awaited, so nothing is buffered.
process.exit(succeeded ? 0 : 1);
