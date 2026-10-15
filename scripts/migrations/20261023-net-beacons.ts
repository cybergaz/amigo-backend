// R1b network telemetry (SYNC_V2_PROTOCOL.md §14.14, §14.17 "ledger scripts
// net_beacons"): the beacon table the flusher writes. Purely additive.
//
// SAFE ON A LIVE RDS: a NEW, empty table; its index is built on an empty
// table, so a plain CREATE INDEX costs nothing. Each statement runs with
// lock_timeout + retry (scripts/lib/sync-v2.ts ddl).
//
// SAFE FOR OLD BUILDS: nothing before this build names the table. The new
// build accepts beacons only when app_settings.sync_v2_net_telemetry is on
// AND the marker this script writes (sync_v2_net_beacons = 1) is set; until
// then POST /api/net/beacon answers 404 and the flusher does nothing.
//
// Matches src/models/net-beacon.model.ts (drizzle's default names), so a
// later db:push sees no drift. Re-runnable: IF NOT EXISTS everywhere.
// Retention (14 days) is the app's daily job, not a DB policy.
import { skipIfApplied, recordApplied } from "../lib/migration";
import { ddl, open_sql, set_marker, MARKERS } from "../lib/sync-v2";

await skipIfApplied(import.meta.path);

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS net_beacons (
     id bigserial PRIMARY KEY NOT NULL,
     user_id uuid NOT NULL,
     ts timestamptz NOT NULL DEFAULT now(),
     ip24 text,
     app_ver text,
     payload jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_net_beacons_ts ON net_beacons USING btree (ts)`,
];

const sql = open_sql(1);
let succeeded = false;
try {
  for (const s of STATEMENTS) await ddl(sql, s);
  await set_marker(sql, MARKERS.net_beacons, 1);
  console.log(`✅ net_beacons applied (idempotent — safe to re-run). Marker ${MARKERS.net_beacons}=1.`);
  succeeded = true;
} catch (e) {
  console.error("❌ net_beacons failed:", e);
} finally {
  await sql.end();
}

if (succeeded) await recordApplied(import.meta.path);
process.exit(succeeded ? 0 : 1);
