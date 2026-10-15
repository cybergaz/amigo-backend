import { sql } from "drizzle-orm";
import db, { pg_client } from "@/config/db";
import type postgres from "postgres";
import { count, observe_ms } from "@/utils/counters";
import { WORKER_ID } from "./identity";
import { k } from "./keys";
import { deadline, rfast } from "./redis-fast";
import { is_draining } from "./lifecycle";

// =============================================================================
// Single-runner jobs (SYNC_V2 §13.8)
// =============================================================================
// Periodic DB writers (receipt flush, missed-message cleanup, ring backstop)
// must run on ONE worker at a time once there is more than one process — and
// there already is one during every A/B swap. The fence is a TRANSACTION-
// scoped advisory lock taken per batch:
//   - no session locks: dev runs through Neon's transaction pooler, where a
//     session lock would be held by whatever backend the pooler handed out
//     and released at random; an xact lock lives and dies with the batch;
//   - a worker that wedges or dies mid-batch loses the lock with its
//     transaction, so nobody waits on a ghost;
//   - every job stays idempotent or monotone anyway, so a lock that is
//     skipped (held elsewhere) only delays work, never loses it.
//
// pg_try_advisory_xact_lock(int4, int4) namespace: ASCII "JOBS". Must differ
// from LOCK_NS_BROADCAST_SENDER "BCST" (0x42435354) and LOCK_NS_DM_PAIR
// "BCPR" (0x42435052) in utils/broadcast.utils.ts — the (ns, key) pair is the
// lock identity, so a job name that hashed onto a sender id could otherwise
// block that sender's broadcast.
const LOCK_NS_JOBS = 0x4a4f4253;

// A job batch that runs longer than this is cancelled (and rolled back)
// instead of pinning a pool connection; the next tick resumes the work.
const JOB_STATEMENT_TIMEOUT = "60s";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside one transaction that holds the job's advisory lock.
 * Returns undefined WITHOUT running `fn` when another worker holds it.
 * Errors from `fn` roll the transaction back and are rethrown.
 */
const run_pg_singleton = async <T>(
  name: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T | undefined> => {
  const t0 = performance.now();
  let acquired = false;
  try {
    const out = await db.transaction(async (tx) => {
      // One round-trip: the try-lock never waits, and set_config(.., true)
      // is SET LOCAL (this transaction only).
      const rows = await tx.execute<{ ok: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(${LOCK_NS_JOBS}::int, hashtext(${name}::text)) AS ok,
               set_config('statement_timeout', ${JOB_STATEMENT_TIMEOUT}, true) AS st
      `);
      if (rows[0]?.ok !== true) return undefined;
      acquired = true;
      return fn(tx);
    });
    count("JOBS", acquired ? `${name}_ran` : `${name}_skipped`);
    if (acquired) observe_ms("JOBS", `${name}_ms`, performance.now() - t0);
    return out;
  } catch (err: any) {
    count("JOBS", `${name}_failed`);
    console.error(
      `[JOBS] ${name} failed ${Math.round(performance.now() - t0)}ms: ${err?.message ?? err}`,
    );
    throw err;
  }
};

/**
 * run_pg_singleton for work written against the raw postgres-js client
 * (the Sync v2 write-path SQL in services/sync/write-queries.ts takes a
 * postgres-js `Sql`, so the PGlite harness can run the very same statements).
 * Same lock namespace, statement timeout, counters and return contract.
 *
 * `opts.label` names the [JOBS] counters / log line instead of `name`, for
 * locks whose name carries an id (chunked uploads lock 'upload:'+id): the
 * counters must keep a bounded set of names.
 */
const run_pg_singleton_sql = async <T>(
  lock_name: string,
  fn: (tx: postgres.TransactionSql<{}>) => Promise<T>,
  opts: { label?: string } = {},
): Promise<T | undefined> => {
  const name = opts.label ?? lock_name;
  const t0 = performance.now();
  let acquired = false;
  try {
    const out = (await pg_client.begin(async (tx) => {
      const rows = await tx<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_NS_JOBS}::int, hashtext(${lock_name}::text)) AS ok,
               set_config('statement_timeout', ${JOB_STATEMENT_TIMEOUT}, true) AS st`;
      if (rows[0]?.ok !== true) return undefined;
      acquired = true;
      return fn(tx);
    })) as T | undefined;
    count("JOBS", acquired ? `${name}_ran` : `${name}_skipped`);
    if (acquired) observe_ms("JOBS", `${name}_ms`, performance.now() - t0);
    return out;
  } catch (err: any) {
    count("JOBS", `${name}_failed`);
    console.error(
      `[JOBS] ${name} failed ${Math.round(performance.now() - t0)}ms: ${err?.message ?? err}`,
    );
    throw err;
  }
};

/**
 * Long loops: every batch is its own fenced transaction (lock → work →
 * commit), so a second worker can never interleave inside a batch, and a
 * drain stops between batches instead of mid-write. Stops when a batch
 * returns 0 / undefined (nothing left, or another worker holds the lock),
 * when the process starts draining, or when `should_stop` says so.
 * Returns the total of the batch counts.
 */
const run_batched_singleton = async (
  name: string,
  batch: (tx: Tx) => Promise<number>,
  opts: { max_batches?: number; should_stop?: () => boolean } = {},
): Promise<number> => {
  const max_batches = opts.max_batches ?? 1000;
  const should_stop = opts.should_stop ?? (() => false);
  let total = 0;
  for (let i = 0; i < max_batches && !is_draining() && !should_stop(); i++) {
    const n = await run_pg_singleton(name, batch);
    if (!n) break;
    total += n;
  }
  return total;
};

type DailyOutcome = "ran" | "skipped" | "failed";

/**
 * At most one run per `every_s` across all workers, decided in Redis: a short
 * NX claim (10 min) while the job runs, then the finish time with a TTL of
 * `every_s - 1 h` (the hour of slack keeps a run from drifting a whole tick
 * later every day). A failure deletes the marker so it never blocks for 23 h.
 * The job itself must still fence its writes (run_batched_singleton): the
 * claim can expire under a slow run.
 *
 * Never throws; the outcome is returned and logged as
 * `[JOBS] name ran|skipped|failed ms rows`.
 */
const run_daily = async (
  name: string,
  fn: () => Promise<number | void>,
  every_s = 86_400,
): Promise<DailyOutcome> => {
  const key = k.jobs_last(name);
  try {
    const claimed = await deadline(
      rfast.set(key, WORKER_ID, "EX", 600, "NX"),
      1_000,
      `jobs claim ${name}`,
    );
    if (claimed !== "OK") {
      count("JOBS", `${name}_skipped`);
      return "skipped";
    }
  } catch (err: any) {
    // Redis unreachable: try again on the next tick rather than run blind.
    count("JOBS", `${name}_claim_failed`);
    console.error(`[JOBS] ${name} skipped: claim failed: ${err?.message ?? err}`);
    return "skipped";
  }

  const t0 = performance.now();
  try {
    const rows = await fn();
    const ms = Math.round(performance.now() - t0);
    console.log(`[JOBS] ${name} ran ${ms}ms rows=${typeof rows === "number" ? rows : "-"}`);
    try {
      await deadline(
        rfast.set(key, new Date().toISOString(), "EX", Math.max(60, every_s - 3600)),
        1_000,
        `jobs mark ${name}`,
      );
    } catch (err: any) {
      // The claim expires within 10 min and the job runs again; it is
      // idempotent, so that only costs a redundant pass.
      console.error(`[JOBS] ${name} done but marker write failed: ${err?.message ?? err}`);
    }
    return "ran";
  } catch (err: any) {
    console.error(
      `[JOBS] ${name} failed ${Math.round(performance.now() - t0)}ms: ${err?.message ?? err}`,
    );
    try {
      await deadline(rfast.del(key), 1_000, `jobs unclaim ${name}`);
    } catch { }
    return "failed";
  }
};

// redis_lease lives in lease.ts (main Redis connection, usable from CLI
// scripts); re-exported so §13.8's "jobs.ts: redis_lease" still holds.
export { redis_lease } from "./lease";
export { run_pg_singleton, run_pg_singleton_sql, run_batched_singleton, run_daily, LOCK_NS_JOBS };
export type { Tx, DailyOutcome };
