import { observe_ms } from "@/utils/counters";

// =============================================================================
// Process lifecycle: ready/draining state, tracked work, signals, loop lag
// (SYNC_V2 §13.3 lifecycle.ts, §13.9)
// =============================================================================
// The ONLY place that handles SIGTERM/SIGINT. Before RC-1 there were two sets
// of handlers (server.ts and socket.server.ts): SIGINT exited at once and
// SIGTERM awaited a stop() that does not wait, so every restart was an abrupt
// cut for ~2.6k sockets. Now:
//   1st signal → slow drain (the caller-supplied run_drain)
//   2nd signal → the same drain switches to fast mode (~10 s)
//   3rd signal → exit immediately
// and a hard exit fires 80 s after the first signal whatever happens
// (systemd TimeoutStopSec=90 is the backstop behind that).

type DrainMode = "slow" | "fast";

const state = {
  // deps up, guard passed, both listeners bound
  ready: false,
  draining: false,
  drain_mode: null as DrainMode | null,
  drain_started_at: 0,
  http_listening: false,
  ws_listening: false,
};

const is_draining = () => state.draining;
const is_fast_drain = () => state.drain_mode === "fast";

// -----------------------------------------------------------------------------
// Tracked work (B6): promises the drain waits for before closing pools —
// WS frame handlers and detached fan-outs that already acked the client.
// -----------------------------------------------------------------------------
const tracked = new Set<Promise<unknown>>();

const track = <T>(p: Promise<T>): Promise<T> => {
  tracked.add(p);
  const done = () => {
    tracked.delete(p);
  };
  p.then(done, done);
  return p;
};

const tracked_count = () => tracked.size;

// -----------------------------------------------------------------------------
// Drain-aware sleeping: a slow-drain wait ends early when a second signal
// switches to fast mode, so the drain re-plans with the fast budget at once.
// -----------------------------------------------------------------------------
const wakers = new Set<() => void>();

const drain_sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      wakers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.add(done);
  });

// Wait for every tracked promise (including ones added while waiting), at
// most max_ms. Returns how many are still in flight.
const await_tracked = async (max_ms: number): Promise<number> => {
  const until = Date.now() + max_ms;
  while (tracked.size > 0) {
    const left = until - Date.now();
    if (left <= 0) break;
    await Promise.race([Promise.allSettled([...tracked]), drain_sleep(left)]);
  }
  return tracked.size;
};

// -----------------------------------------------------------------------------
// Signals
// -----------------------------------------------------------------------------
const HARD_EXIT_SLOW_MS = 80_000;
const HARD_EXIT_FAST_MS = 15_000;

let signal_count = 0;
let hard_exit_timer: ReturnType<typeof setTimeout> | null = null;
let hard_exit_at = 0;
let handlers_installed = false;

const arm_hard_exit = (ms: number) => {
  const at = Date.now() + ms;
  if (hard_exit_timer && hard_exit_at <= at) return; // never postpone
  if (hard_exit_timer) clearTimeout(hard_exit_timer);
  hard_exit_at = at;
  hard_exit_timer = setTimeout(() => {
    console.error(
      `[SHUTDOWN] hard exit after ${Date.now() - state.drain_started_at}ms (drain did not finish)`,
    );
    process.exit(1);
  }, ms);
};

const install_signal_handlers = (run_drain: () => Promise<void>) => {
  if (handlers_installed) return;
  handlers_installed = true;

  const on_signal = (sig: NodeJS.Signals) => {
    signal_count++;
    if (signal_count === 1) {
      state.draining = true;
      state.drain_mode = "slow";
      state.drain_started_at = Date.now();
      console.log(`[SHUTDOWN] ${sig} received, starting slow drain`);
      arm_hard_exit(HARD_EXIT_SLOW_MS);
      run_drain()
        .then(() => {
          console.log(`[SHUTDOWN] drained in ${Date.now() - state.drain_started_at}ms, exiting`);
          process.exit(0);
        })
        .catch((err) => {
          console.error("[SHUTDOWN] drain failed, exiting:", err);
          process.exit(1);
        });
      return;
    }
    if (signal_count === 2) {
      console.log(`[SHUTDOWN] second ${sig}, switching to fast drain`);
      state.drain_mode = "fast";
      arm_hard_exit(HARD_EXIT_FAST_MS);
      for (const wake of [...wakers]) wake();
      return;
    }
    console.log(`[SHUTDOWN] third ${sig}, exiting now`);
    process.exit(1);
  };

  process.on("SIGTERM", on_signal);
  process.on("SIGINT", on_signal);
};

// -----------------------------------------------------------------------------
// Event-loop lag (healthz liveness, beat payload)
// -----------------------------------------------------------------------------
// A 500 ms timer measures how late it fires. A process whose loop is blocked
// for seconds still answers TCP (the kernel accepts) but serves nothing in
// time — healthz reports 503 above 2 s so the watchdog restarts it.
const LAG_SAMPLE_MS = 500;
let lag_ms = 0;
let lag_timer: ReturnType<typeof setInterval> | null = null;

const start_lag_sampler = () => {
  if (lag_timer) return;
  let expected = performance.now() + LAG_SAMPLE_MS;
  lag_timer = setInterval(() => {
    const now = performance.now();
    lag_ms = Math.max(0, Math.round(now - expected));
    expected = now + LAG_SAMPLE_MS;
    observe_ms("LOOP", "lag_ms", lag_ms);
  }, LAG_SAMPLE_MS);
};

const event_loop_lag_ms = () => lag_ms;

// -----------------------------------------------------------------------------
// Readiness checks (readyz). Modules register a cheap probe; health.routes
// runs them with deadlines and caches the verdict.
// -----------------------------------------------------------------------------
type ReadyCheck = { name: string; fn: () => boolean | Promise<boolean> };
const ready_checks: ReadyCheck[] = [];

const register_ready_check = (name: string, fn: ReadyCheck["fn"]) => {
  ready_checks.push({ name, fn });
};

export {
  state,
  is_draining,
  is_fast_drain,
  track,
  tracked_count,
  await_tracked,
  drain_sleep,
  install_signal_handlers,
  start_lag_sampler,
  event_loop_lag_ms,
  register_ready_check,
  ready_checks,
};
export type { DrainMode };
