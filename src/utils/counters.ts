// =============================================================================
// Lightweight in-process counters (SYNC_V2 §14.14 "server counters")
// =============================================================================
// Plain Maps, no Redis, no new infra: the point is to see in the existing log
// stream how often the network edge cases actually happen (backpressure, early
// frames, skipped pings, close codes, FCM priority) before tuning anything.
// Each tag is printed as ONE line per window by flush_counters(), which the
// socket server calls on its existing stats interval, and then reset — so
// every line is a per-window delta, not a lifetime total.
//
// Per process: at N>1 each worker logs its own line (sum them when reading).

type Timing = { n: number; sum: number; max: number };

const counters = new Map<string, Map<string, number>>(); // tag -> name -> value
const timings = new Map<string, Map<string, Timing>>(); // tag -> name -> timing
let window_started_at = Date.now();

// Increment a counter. Names must have bounded cardinality (never put a
// user id or message id in a name).
const count = (tag: string, name: string, n = 1): void => {
  let bucket = counters.get(tag);
  if (!bucket) {
    bucket = new Map();
    counters.set(tag, bucket);
  }
  bucket.set(name, (bucket.get(name) ?? 0) + n);
};

// Record a duration; logged as {name}_n / {name}_avg / {name}_max.
const observe_ms = (tag: string, name: string, ms: number): void => {
  if (!Number.isFinite(ms) || ms < 0) return;
  let bucket = timings.get(tag);
  if (!bucket) {
    bucket = new Map();
    timings.set(tag, bucket);
  }
  const t = bucket.get(name);
  if (t) {
    t.n++;
    t.sum += ms;
    if (ms > t.max) t.max = ms;
  } else {
    bucket.set(name, { n: 1, sum: ms, max: ms });
  }
};

// Snapshot of the current window, grouped by tag. Exposed separately from the
// logger so it can be unit-tested and (later) served by an admin endpoint.
const snapshot_counters = (): Record<string, Record<string, number>> => {
  const out: Record<string, Record<string, number>> = {};
  for (const [tag, bucket] of counters) {
    const row = (out[tag] ??= {});
    for (const [name, value] of bucket) row[name] = value;
  }
  for (const [tag, bucket] of timings) {
    const row = (out[tag] ??= {});
    for (const [name, t] of bucket) {
      row[`${name}_n`] = t.n;
      row[`${name}_avg`] = Math.round(t.sum / t.n);
      row[`${name}_max`] = Math.round(t.max);
    }
  }
  return out;
};

const reset_counters = (): void => {
  counters.clear();
  timings.clear();
  window_started_at = Date.now();
};

// Log one line per tag ("[WS] counters {...}") and start a new window.
// Tags with nothing recorded in the window print nothing.
const flush_counters = (): void => {
  const window_s = Math.round((Date.now() - window_started_at) / 1000);
  const snap = snapshot_counters();
  for (const tag of Object.keys(snap).sort()) {
    console.log(`[${tag}] counters ${JSON.stringify({ window_s, ...snap[tag] })}`);
  }
  reset_counters();
};

export { count, observe_ms, snapshot_counters, reset_counters, flush_counters };
