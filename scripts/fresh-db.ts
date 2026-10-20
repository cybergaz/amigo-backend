#!/usr/bin/env bun
/**
 * Helpers for `just db_initiate` — building a brand-new, EMPTY database.
 *
 *   bun run scripts/fresh-db.ts check     exit 1 unless DB_URL has no tables in public
 *   bun run scripts/fresh-db.ts markers   write the two boot markers the sync v2
 *                                         ledger scripts wait for
 *
 * `check` is the guard that keeps db_initiate (drizzle-kit push --force) off any
 * database that already holds data — the shared dev DB, a test instance, prod.
 *
 * `markers`: 20261020c / 20261021 / 20261022 require sync_v2_code_deployed and
 * sync_v2_dualwrite, which a deployed server writes at boot. They exist to stop
 * the scripts racing legacy code on live data; an empty DB has neither, so
 * db_initiate writes them itself.
 */
import "dotenv/config";
import { connect, target } from "./lib/migration";

const cmd = process.argv[2];
const t = target();
const sql = connect();

try {
  if (cmd === "check") {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`;
    if (n > 0) {
      console.error(
        `\n  ✖ ${t.label} already has ${n} table(s). db_initiate only builds EMPTY databases.\n` +
        `    For an existing DB use: bun run script:migrate status / up\n`,
      );
      process.exit(1);
    }
    console.log(`  ✔ ${t.label} is empty`);
  } else if (cmd === "markers") {
    for (const key of ["sync_v2_code_deployed", "sync_v2_dualwrite"]) {
      await sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${key}, ${sql.json({ by: "just db_initiate", at: new Date().toISOString() })}, now())
        ON CONFLICT (key) DO NOTHING`;
    }
    console.log(`  ✔ boot markers written on ${t.label}`);
  } else {
    console.log("Usage: bun run scripts/fresh-db.ts check | markers");
    process.exit(1);
  }
} finally {
  await sql.end();
}
process.exit(0);
