/**
 * One-off applier: make users.fcm_token EXCLUSIVE to a single user.
 *
 * WHY: an FCM token identifies a HANDSET, not an account. store_fcm_token used
 * to write it keyed only by the caller's user_id with no reverse eviction and
 * no unique constraint, so when user B logged in on a device where user A had
 * been logged in, BOTH rows ended up holding the same device token — and A's
 * push notifications kept landing on B's phone forever. That is a privacy leak,
 * not just a routing bug.
 *
 * The code fix (fcm-token.cache.ts steals the token from any other holder on
 * write) stops NEW duplicates. This script cleans up the ones already in the
 * database and installs a partial unique index as a permanent backstop so the
 * class of bug cannot silently come back.
 *
 * Steps:
 *   1. Report every token held by more than one user.
 *   2. Keep the MOST RECENTLY ACTIVE owner per token, NULL the rest. Recency is
 *      auth_devices.last_seen_at (the mobile device row, closest thing we have
 *      to "who is actually holding this handset"), falling back to users.last_seen
 *      then users.created_at.
 *   3. Evict the losers from Redis + the in-memory LRU via remove_fcm_token —
 *      the DB alone is not enough, Redis holds a 30-day copy that would
 *      resurrect the stale mapping on the next cache miss, and the publish also
 *      kicks the stale entry out of every RUNNING worker's LRU.
 *   4. CREATE UNIQUE INDEX CONCURRENTLY on users(fcm_token) WHERE NOT NULL.
 *
 * Idempotent — safe to re-run. Step 4 uses IF NOT EXISTS and self-heals an
 * INVALID index left behind by a previously failed CONCURRENTLY build.
 * Backward-compatible — can be applied BEFORE the new build ships (the unique
 * index only ever rejects a write the old code should not have been making,
 * and store_fcm_token already swallows/logs DB write errors).
 *
 * Two-stage archive: on a successful run the script moves itself one stage
 * along scripts/ → scripts/applied-dev/ → scripts/applied-archive/, so after
 * the dev run it stays runnable for prod:
 *
 *   dev:   bun run scripts/apply-fcm-token-unique.ts
 *   prod:  bun run scripts/applied-dev/apply-fcm-token-unique.ts
 */

import db from "@/config/db";
import { remove_fcm_token } from "@/cache-management/fcm-token.cache";
import { sql } from "drizzle-orm";
import { mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// drizzle's db.execute returns the postgres.js RowList (array) for SELECT/RETURNING,
// but normalize defensively in case the driver wraps it in { rows }.
const as_rows = (res: unknown): any[] =>
  Array.isArray(res) ? res : ((res as { rows?: any[] })?.rows ?? []);

// Never print a full device token to a log file — it is a push credential.
const redact = (token: string): string =>
  token.length <= 14 ? `${token.slice(0, 6)}…` : `${token.slice(0, 12)}…(${token.length})`;

const INDEX_NAME = "idx_users_fcm_token_unique";

async function main(): Promise<boolean> {
  // ── Step 1: report duplicates ───────────────────────────────────────────
  const dupes = as_rows(
    await db.execute(sql`
      SELECT fcm_token, count(*)::int AS owners, array_agg(id::text) AS ids
      FROM users
      WHERE fcm_token IS NOT NULL
      GROUP BY fcm_token
      HAVING count(*) > 1
      ORDER BY count(*) DESC
    `),
  ) as Array<{ fcm_token: string; owners: number; ids: string[] }>;

  if (dupes.length === 0) {
    console.log("[fcm-unique] No duplicated FCM tokens — nothing to dedupe.");
  } else {
    const leaking_users = dupes.reduce((n, d) => n + d.owners, 0);
    console.log(
      `[fcm-unique] ⚠️  ${dupes.length} token(s) shared by ${leaking_users} user rows ` +
        `— every extra owner is/was a cross-account push leak:`,
    );
    for (const d of dupes) {
      console.log(`  ${redact(d.fcm_token)} → ${d.owners} owners: ${d.ids.join(", ")}`);
    }
  }

  // ── Step 2: pick the keeper per token, collect the losers ───────────────
  // One ordered pass: rows come grouped by token, most-recently-active first,
  // so the FIRST row of each group is the keeper and the rest are losers.
  const ranked = as_rows(
    await db.execute(sql`
      SELECT u.id::text AS id,
             u.fcm_token,
             GREATEST(
               COALESCE(d.last_device_seen, 'epoch'::timestamptz),
               COALESCE(u.last_seen,        'epoch'::timestamptz),
               COALESCE(u.created_at,       'epoch'::timestamptz)
             ) AS activity
      FROM users u
      LEFT JOIN (
        SELECT user_id, MAX(last_seen_at) AS last_device_seen
        FROM auth_devices
        GROUP BY user_id
      ) d ON d.user_id = u.id
      WHERE u.fcm_token IS NOT NULL
        AND u.fcm_token IN (
          SELECT fcm_token FROM users
          WHERE fcm_token IS NOT NULL
          GROUP BY fcm_token HAVING count(*) > 1
        )
      ORDER BY u.fcm_token, activity DESC, u.id
    `),
  ) as Array<{ id: string; fcm_token: string; activity: Date | string }>;

  const losers: string[] = [];
  let current_token: string | null = null;
  for (const row of ranked) {
    if (row.fcm_token !== current_token) {
      current_token = row.fcm_token;
      console.log(`[fcm-unique] keeping ${row.id} for ${redact(row.fcm_token)}`);
      continue; // first row of the group = most recently active = keeper
    }
    losers.push(row.id);
  }

  // ── Step 3: clear the losers from ALL tiers (DB + Redis + LRU) ──────────
  // remove_fcm_token does the DB NULL, the Redis DEL of fcm:user:<id>:token and
  // publishes the cross-worker LRU invalidation — doing it here by hand would
  // leave the 30-day Redis copy behind and the leak would survive the cleanup.
  let cleared = 0;
  for (const id of losers) {
    try {
      await remove_fcm_token(id);
      cleared++;
    } catch (err) {
      console.error(`[fcm-unique] failed to clear token for user ${id}:`, err);
    }
  }
  if (losers.length > 0) {
    console.log(`[fcm-unique] Cleared ${cleared}/${losers.length} duplicate owner(s).`);
  }

  if (cleared !== losers.length) {
    console.error("[fcm-unique] ❌ Some duplicates survived — NOT creating the unique index.");
    return false;
  }

  // ── Step 4: the permanent backstop index ────────────────────────────────
  // A failed CONCURRENTLY build leaves an INVALID index behind that IF NOT
  // EXISTS would then happily skip forever — drop it so a re-run can rebuild.
  const invalid = as_rows(
    await db.execute(sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ${INDEX_NAME} AND i.indisvalid = false
    `),
  );
  if (invalid.length > 0) {
    console.warn(`[fcm-unique] Dropping INVALID ${INDEX_NAME} left by an earlier failed build.`);
    await db.execute(sql.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`));
  }

  // CONCURRENTLY cannot run inside a transaction block. db.execute issues a
  // single statement on a pooled connection with no implicit BEGIN, so this is
  // fine — but if a future driver change wraps it, Postgres says so explicitly
  // and we fall back to the locking (still correct, briefly blocking) form.
  try {
    await db.execute(
      sql.raw(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ` +
          `ON users (fcm_token) WHERE fcm_token IS NOT NULL`,
      ),
    );
    console.log(`[fcm-unique] ✅ ${INDEX_NAME} in place (concurrent build).`);
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (!msg.includes("transaction block")) throw err;
    console.warn(
      "[fcm-unique] Driver forced a transaction block — retrying WITHOUT CONCURRENTLY " +
        "(this takes a brief write lock on users).",
    );
    await db.execute(
      sql.raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} ` +
          `ON users (fcm_token) WHERE fcm_token IS NOT NULL`,
      ),
    );
    console.log(`[fcm-unique] ✅ ${INDEX_NAME} in place (locking build).`);
  }

  console.log(
    `[fcm-unique] Done — duplicated tokens: ${dupes.length}, ` +
      `owners revoked: ${cleared}, unique index: ${INDEX_NAME}.`,
  );
  return true;
}

const succeeded = await main().catch((err) => {
  console.error("[fcm-unique] FAILED:", err);
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

// The pg pool and the fcm-cache's Redis subscriber keep the loop alive; every
// write above is already awaited, so nothing is buffered.
process.exit(succeeded ? 0 : 1);
