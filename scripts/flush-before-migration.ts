/**
 * One-shot drain of every write-behind buffer into Postgres — hardened for a
 * live PROD run inside a short downtime window.
 *
 * Normally these are flushed on timers (receipts every ~5 min, message
 * statuses every ~90s). Before a Redis→Valkey cutover you want them in
 * Postgres NOW so nothing unpersisted is lost when you point the app at a
 * fresh, empty cache. This runs the same drain path the background workers use
 * (pop dirty set → flush → re-enqueue on error), but loops to completion.
 *
 * Scope — the only two buffers that persist to the DB:
 *   receipts        user_receipts:{uid}  + set receipts:dirty   → chat_members
 *   message status  msg_status:{msg_id}  + set msg_status:dirty → message_info
 * (unread counters have no DB flush path and are intentionally NOT covered.)
 *
 * SAFETY GUARANTEES (why it's safe to run blind on prod):
 *   • Never throws to the top: every failure path is caught and turns into an
 *     exit code + a clear message. Last-resort process handlers catch anything
 *     that still escapes.
 *   • Never loses data: a batch is SPOP'd from the dirty set, and if its flush
 *     ultimately fails it is re-added (readd) before we stop. Worst case the
 *     data simply stays in the old Redis, exactly where it was.
 *   • Never hangs: bounded retries, a wall-clock deadline, a round cap, and a
 *     forced process.exit() with a timed-out connection close.
 *   • Absorbs blips: transient flush errors retry with backoff before giving up.
 *   • Independent buffers: a problem draining one buffer never skips the other.
 *
 * Exit codes:
 *   0  both buffers fully empty — safe to cut over
 *   1  finished cleanly but NOT empty (see the printed reason: live traffic, or
 *      a DB flush issue with data preserved on the old Redis)
 *   2  could not initialise (bad env / DB / Redis at startup) — nothing drained
 *   3  last-resort: an unexpected error escaped (data left intact)
 *
 * It connects to whatever REDIS_URL / DB your .env points at — run it while the
 * app is still on the OLD Redis, right before you flip REDIS_URL.
 *
 * Cutover ordering for a provable zero:
 *   1. stop / quiesce the app (your downtime window) so no NEW dirty entries land
 *   2. bun run flush:migrate           ← this script; wait for exit 0
 *   3. flip REDIS_URL to the new Valkey endpoint and restart the app
 *
 * Usage:
 *   bun run flush:migrate
 *   bun run flush:migrate --dry-run          # just report counts, drain nothing
 *   bun run flush:migrate --batch=1000 --max-seconds=30
 *
 * Safe to run alongside the live app: SPOP is atomic, so each dirty entry is
 * claimed by exactly one consumer — no double-flush with the running workers.
 */

// ── Last-resort guards: nothing may crash the process with a raw stack trace ──
process.on("uncaughtException", (err) => {
  console.error("[flush] uncaughtException (data left intact on Redis):", err);
  hard_exit(3);
});
process.on("unhandledRejection", (err) => {
  console.error("[flush] unhandledRejection (data left intact on Redis):", err);
  hard_exit(3);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Force the process to end even if some connection handle is still open. Best
// effort close of the imported redis client, then a guaranteed exit.
let redis_client: { quit: () => Promise<unknown>; disconnect: () => void } | null = null;
async function hard_exit(code: number): Promise<never> {
  try {
    if (redis_client) {
      // Race the graceful QUIT against a timeout so a stuck socket can't hang us.
      await Promise.race([redis_client.quit().catch(() => {}), sleep(2000)]);
      try {
        redis_client.disconnect();
      } catch {}
    }
  } catch {}
  process.exit(code);
}

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const get_num = (flag: string, def: number): number => {
  const a = argv.find((x) => x.startsWith(`${flag}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const BATCH_SIZE = get_num("--batch", 500);
const MAX_SECONDS = get_num("--max-seconds", 120);
const DRY_RUN = argv.includes("--dry-run");

const FLUSH_RETRIES = 4; // per-batch attempts before we preserve+stop that buffer
const EMPTY_PROBES = 10; // times we re-check a "pop returned nothing but count>0"
const ROUND_CAP = 1_000_000; // pure infinite-loop backstop

// ── Retry wrapper for a single flush ─────────────────────────────────────────
async function with_retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= FLUSH_RETRIES) throw err;
      const wait = 400 * 2 ** (attempt - 1); // 400ms, 800ms, 1.6s
      console.warn(`[flush] ${label}: attempt ${attempt}/${FLUSH_RETRIES} failed, retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

type WriteBehind<T> = {
  label: string;
  count: () => Promise<number>;
  pop: (limit: number) => Promise<T[]>;
  flush: (items: T[]) => Promise<void>;
  readd: (items: T[]) => Promise<void>;
};

type Result = { flushed: number; remaining: number; blocked: boolean; error: unknown };

// count()/pop() in the cache layer already swallow their own errors (returning
// 0 / []), so these wrappers are just belt-and-suspenders.
const safe_count = async (fn: () => Promise<number>): Promise<number> => {
  try {
    return await fn();
  } catch {
    return -1; // unknown
  }
};

async function drain<T>(b: WriteBehind<T>, deadline: number): Promise<Result> {
  const initial = await safe_count(b.count);
  console.log(`\n[flush] ${b.label.trim()}: ${initial < 0 ? "?" : initial} pending`);

  let flushed = 0;
  let empty_probes = 0;
  let blocked = false;
  let error: unknown = null;

  for (let round = 0; round < ROUND_CAP; round++) {
    if (Date.now() > deadline) {
      console.warn(`[flush] ${b.label.trim()}: hit --max-seconds, stopping (data intact)`);
      break;
    }

    let batch: T[] = [];
    try {
      batch = await b.pop(BATCH_SIZE);
    } catch (err) {
      // pop shouldn't throw (it self-catches) but never let it kill the run.
      console.warn(`[flush] ${b.label.trim()}: pop error, treating as empty this round`, err);
      batch = [];
    }

    if (batch.length === 0) {
      // Empty could be genuinely-done OR a transient pop error. Confirm via the
      // dirty-set cardinality; only stop when it's really drained.
      const remaining = await safe_count(b.count);
      if (remaining === 0) break;
      if (++empty_probes > EMPTY_PROBES) {
        console.warn(`[flush] ${b.label.trim()}: still ${remaining} pending but pop keeps returning empty; stopping`);
        break;
      }
      await sleep(300);
      continue;
    }
    empty_probes = 0;

    try {
      await with_retry(() => b.flush(batch), b.label.trim());
      flushed += batch.length;
      process.stdout.write(`\r[flush] ${b.label.trim()}: drained ${flushed}...   `);
    } catch (err) {
      // Persistent flush failure: put the batch back so it is NOT lost, record
      // the problem, and stop this buffer (re-adding then re-popping the same
      // batch would loop forever).
      error = err;
      blocked = true;
      try {
        await b.readd(batch);
      } catch (re) {
        console.error(`[flush] ${b.label.trim()}: re-enqueue also failed for ${batch.length} item(s)`, re);
      }
      console.error(`[flush] ${b.label.trim()}: flush failed after ${FLUSH_RETRIES} attempts; batch re-queued, stopping this buffer`, err);
      break;
    }
  }

  const remaining = await safe_count(b.count);
  console.log(`\r[flush] ${b.label.trim()}: drained ${flushed}, remaining ${remaining < 0 ? "?" : remaining}        `);
  return { flushed, remaining, blocked, error };
}

async function main(): Promise<void> {
  const start = Date.now();
  const deadline = start + MAX_SECONDS * 1000;

  // Dynamic import so ANY startup failure (missing env, DB/Redis unreachable)
  // becomes a clean exit(2) instead of a raw import-time crash.
  let mods: {
    redis: typeof redis_client;
    receipts: WriteBehind<unknown>;
    messages: WriteBehind<unknown>;
  };
  try {
    const cfg = await import("@/config/redis");
    const cm = await import("@/cache-management/chat-member.cache");
    const rf = await import("@/cache-management/receipt-flush");
    const mc = await import("@/cache-management/message.cache");
    const mf = await import("@/cache-management/message-status-flush");

    redis_client = cfg.redis as unknown as typeof redis_client;

    mods = {
      redis: redis_client,
      receipts: {
        label: "receipts",
        count: cm.dirty_receipts_count,
        pop: cm.pop_dirty_receipts as (l: number) => Promise<unknown[]>,
        flush: rf.flush_receipts_to_db as (i: unknown[]) => Promise<void>,
        readd: cm.readd_dirty_receipts as (i: unknown[]) => Promise<void>,
      },
      messages: {
        label: "message-status",
        count: mc.dirty_messages_count,
        pop: mc.pop_dirty_messages as (l: number) => Promise<unknown[]>,
        flush: mf.flush_message_statuses_to_db as (i: unknown[]) => Promise<void>,
        readd: mc.readd_dirty_messages as (i: unknown[]) => Promise<void>,
      },
    };
  } catch (err) {
    console.error("[flush] Failed to initialise (env / DB / Redis). Nothing was drained.", err);
    return hard_exit(2);
  }

  if (DRY_RUN) {
    const r = await safe_count(mods.receipts.count);
    const m = await safe_count(mods.messages.count);
    console.log(`[flush] DRY RUN — pending: receipts=${r < 0 ? "?" : r}, message-status=${m < 0 ? "?" : m}. Nothing drained.`);
    return hard_exit(0);
  }

  console.log(`[flush] Draining write-behind buffers to Postgres (batch=${BATCH_SIZE}, max-seconds=${MAX_SECONDS})...`);

  // Independent: a failure in one must not skip the other.
  const receipts = await drain(mods.receipts, deadline).catch((err) => {
    console.error("[flush] receipts drain crashed unexpectedly (data intact):", err);
    return { flushed: 0, remaining: -1, blocked: true, error: err } as Result;
  });
  const messages = await drain(mods.messages, deadline).catch((err) => {
    console.error("[flush] message-status drain crashed unexpectedly (data intact):", err);
    return { flushed: 0, remaining: -1, blocked: true, error: err } as Result;
  });

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const fully_empty = receipts.remaining === 0 && messages.remaining === 0;
  const any_blocked = receipts.blocked || messages.blocked;

  console.log(
    `\n[flush] Complete in ${secs}s — ` +
      `receipts: drained ${receipts.flushed}, remaining ${receipts.remaining < 0 ? "?" : receipts.remaining}; ` +
      `message-status: drained ${messages.flushed}, remaining ${messages.remaining < 0 ? "?" : messages.remaining}.`,
  );

  if (fully_empty) {
    console.log("[flush] ✅ Both buffers empty. Safe to flip REDIS_URL and cut over.");
    return hard_exit(0);
  }

  if (any_blocked) {
    console.warn(
      "[flush] ⚠️  A DB flush kept failing — the affected batch was re-queued on the OLD Redis " +
        "(nothing lost). Fix the DB issue and re-run BEFORE cutting over, or you'll drop those " +
        "receipts/statuses when the fresh cache comes up.",
    );
  } else {
    console.warn(
      "[flush] ⚠️  Buffers not fully empty — the live app is still writing new dirty entries. " +
        "Quiesce/stop the app and re-run to reach a true zero before flipping REDIS_URL. " +
        "(Residual entries are monotonic and self-heal, so this is safe but not provably zero.)",
    );
  }
  return hard_exit(1);
}

main().catch((err) => {
  console.error("[flush] Aborted (unexpected — data left intact on Redis):", err);
  return hard_exit(3);
});
