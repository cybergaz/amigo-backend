/**
 * One-off applier: harden the `otps` table for OTP-as-primary-login.
 *
 * WHY: the table was (phone PRIMARY KEY, otp integer) and nothing else. That was
 * survivable while OTP was a secondary path, but it is now the DEFAULT login
 * credential, and three properties were missing:
 *
 *   1. NO EXPIRY. A code stayed valid forever. A row left over from a login six
 *      months ago is a live credential for that phone number.
 *   2. NO PURPOSE. One code shape served every flow, so a code minted to reset a
 *      forgotten PIN could be replayed against the login endpoint.
 *   3. NO ISSUE TIME. Nothing to audit or reason about.
 *
 * This adds purpose / channel / expires_at / created_at (all nullable + defaulted,
 * so the ALTER is instant and needs no table rewrite) and DELETES every existing
 * row — those are pre-expiry codes with no purpose scoping, i.e. exactly the
 * credentials described in (1). They are transient by nature; the cost of dropping
 * them is that anyone mid-signup at deploy time taps "Resend".
 *
 * ORDER: run this BEFORE deploying the new build. The new generate_otp writes the
 * new columns and would fail against the old table. The new verify_otp tolerates a
 * NULL expires_at, which covers the reverse window.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS throughout, safe to re-run.
 *
 * Two-stage archive: on a successful run the script moves itself one stage along
 * scripts/ → scripts/applied-dev/ → scripts/applied-archive/, so after the dev run
 * it stays runnable for prod:
 *
 *   dev:   bun run scripts/apply-otp-hardening.ts
 *   prod:  bun run scripts/applied-dev/apply-otp-hardening.ts
 */

import db from "@/config/db";
import { sql } from "drizzle-orm";
import { mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const as_rows = (res: unknown): any[] =>
  Array.isArray(res) ? res : ((res as { rows?: any[] })?.rows ?? []);

async function main(): Promise<boolean> {
  // ── Step 1: how much are we dropping? ───────────────────────────────────
  const [{ count: stale } = { count: 0 }] = as_rows(
    await db.execute(sql`SELECT count(*)::int AS count FROM otps`),
  ) as Array<{ count: number }>;
  console.log(`[otp-harden] ${stale} existing OTP row(s) — all unexpiring, all unscoped.`);

  // ── Step 2: the new columns ─────────────────────────────────────────────
  // Nullable with no default value backfill ⇒ metadata-only ALTER, no rewrite.
  await db.execute(sql`
    ALTER TABLE otps
      ADD COLUMN IF NOT EXISTS purpose    varchar(20),
      ADD COLUMN IF NOT EXISTS channel    varchar(20),
      ADD COLUMN IF NOT EXISTS expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()
  `);
  console.log("[otp-harden] ✅ purpose / channel / expires_at / created_at in place.");

  // ── Step 3: burn the legacy codes ───────────────────────────────────────
  // Every surviving row predates expiry and purpose scoping. Keeping them would
  // mean shipping the hardening while leaving the exact holes it closes.
  if (stale > 0) {
    await db.execute(sql`DELETE FROM otps`);
    console.log(`[otp-harden] ✅ Deleted ${stale} pre-hardening code(s).`);
  }

  // ── Step 4: verify the shape ────────────────────────────────────────────
  const cols = as_rows(
    await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'otps'
      ORDER BY ordinal_position
    `),
  ) as Array<{ column_name: string; data_type: string; is_nullable: string }>;

  const have = new Set(cols.map((c) => c.column_name));
  const want = ["phone", "otp", "purpose", "channel", "expires_at", "created_at"];
  const missing = want.filter((c) => !have.has(c));

  console.log("[otp-harden] otps columns:", cols.map((c) => c.column_name).join(", "));

  if (missing.length > 0) {
    console.error(`[otp-harden] ❌ Still missing: ${missing.join(", ")}`);
    return false;
  }

  console.log("[otp-harden] Done — table is ready for purpose-scoped, expiring codes.");
  return true;
}

const succeeded = await main().catch((err) => {
  console.error("[otp-harden] FAILED:", err);
  return false;
});

// Self-archive one stage along on success. The stage is inferred from where this
// file lives, so the same script runs unchanged on dev and prod:
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

process.exit(succeeded ? 0 : 1);
