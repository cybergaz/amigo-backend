/**
 * The migration ledger — per-environment state for one-off `apply-*` scripts.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The previous scheme encoded "has this run yet?" in the file's *directory*:
 * scripts/ → applied-dev/ → applied-archive/. That can never work, because the
 * filesystem is the very thing git syncs from dev to prod. One tree cannot
 * simultaneously mean "already applied on dev" and "still pending on prod", so
 * after a push prod saw a folder full of applied-dev scripts with no way to tell
 * the new ones from the old — and every self-move was a tracked rename that
 * conflicted on the next pull.
 *
 * State that differs per environment belongs in the thing that IS per
 * environment: the database. Each DB carries its own `script_migrations` table,
 * so the identical commit checked out on dev and on prod reports two different
 * pending lists, and git never sees a move. Files are written once and never
 * touched again.
 */
import postgres from "postgres";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { hostname } from "node:os";

export const REPO_ROOT = resolve(dirname(import.meta.path), "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "scripts", "migrations");

export type LedgerRow = {
  name: string;
  checksum: string;
  applied_at: Date;
  applied_by: string | null;
};

/** Open a short-lived connection to whatever DB_URL this box's .env points at. */
export function connect() {
  const url = process.env.DB_URL;
  if (!url) throw new Error("DB_URL is not set — check the .env on this machine.");
  return postgres(url, { max: 1, onnotice: () => {} });
}

/**
 * Identity of the DB we are about to touch, for the safety banner.
 *
 * `APP_ENV` in the local .env names the environment. It is absent-by-default and
 * .env is gitignored, so a box that never sets it is treated as prod — the safe
 * way round: a forgotten setting costs you one confirmation prompt, never a
 * surprise write to production.
 */
export function target() {
  const url = process.env.DB_URL ?? "";
  let host = "?", database = "?";
  try {
    const u = new URL(url);
    host = u.hostname;
    database = u.pathname.replace(/^\//, "") || "(default)";
  } catch { /* leave the ?s — the banner will show them and connect() will throw */ }

  const isLocalHost = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/.test(host);
  const env = (process.env.APP_ENV ?? (isLocalHost ? "dev" : "prod")).toLowerCase();
  const isDev = env === "dev" || env === "development" || env === "local";
  return { host, database, env: isDev ? "DEV" : "PROD", isDev, label: `${database} @ ${host}` };
}

/** A migration's identity is its filename minus the extension. Nothing else. */
export function nameOf(filePath: string): string {
  return basename(filePath).replace(/\.ts$/, "");
}

export function checksumOf(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 12);
}

/** Every migration on disk, in filename order (the date prefix makes that run order). */
export function onDisk(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

export async function ensureLedger(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS script_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text
    )
  `;
}

export async function ledger(sql: postgres.Sql): Promise<Map<string, LedgerRow>> {
  await ensureLedger(sql);
  const rows = (await sql`SELECT * FROM script_migrations`) as unknown as LedgerRow[];
  return new Map(rows.map((r) => [r.name, r]));
}

async function write(sql: postgres.Sql, name: string, checksum: string) {
  const who = `${process.env.USER ?? "?"}@${hostname()}`;
  await sql`
    INSERT INTO script_migrations (name, checksum, applied_by)
    VALUES (${name}, ${checksum}, ${who})
    ON CONFLICT (name) DO UPDATE
      SET checksum = EXCLUDED.checksum, applied_at = now(), applied_by = EXCLUDED.applied_by
  `;
}

/**
 * Record a migration as applied against THIS environment's DB.
 * Called by the runner after a clean exit, and by each script's own tail so a
 * direct `bun run scripts/migrations/<file>.ts` is recorded too.
 */
export async function recordApplied(filePath: string): Promise<void> {
  const sql = connect();
  try {
    await ensureLedger(sql);
    await write(sql, nameOf(filePath), checksumOf(filePath));
    console.log(`🧾 ledger: ${nameOf(filePath)} marked applied on ${target().label}`);
  } finally {
    await sql.end();
  }
}

export async function markApplied(sql: postgres.Sql, filePath: string): Promise<void> {
  await write(sql, nameOf(filePath), checksumOf(filePath));
}

export async function forget(sql: postgres.Sql, name: string): Promise<void> {
  await sql`DELETE FROM script_migrations WHERE name = ${name}`;
}

/**
 * Front guard for a migration script: if this DB has already run it, exit 0
 * quietly instead of re-applying. `--force` overrides. Safe to call at the top of
 * any script — makes a blind "run everything" harmless.
 */
export async function skipIfApplied(filePath: string): Promise<void> {
  if (process.argv.includes("--force")) return;
  const sql = connect();
  try {
    const rows = await ledger(sql);
    if (rows.has(nameOf(filePath))) {
      const row = rows.get(nameOf(filePath))!;
      console.log(
        `⏭  ${nameOf(filePath)} already applied on ${target().label} ` +
        `(${new Date(row.applied_at).toISOString().slice(0, 16).replace("T", " ")}). ` +
        `Pass --force to run it again.`,
      );
      process.exit(0);
    }
  } finally {
    await sql.end();
  }
}
