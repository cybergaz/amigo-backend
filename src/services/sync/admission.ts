// =============================================================================
// Admission control for /chat/sync/* (SYNC_V2_PROTOCOL.md §3.11, §13.11)
// =============================================================================
// A per-worker cap on concurrent sync computations, ~0.8 × the PG pool, so a
// reconnect storm (every phone pulling heads + deltas after a deploy or a
// Wi-Fi blip) queues in the clients instead of in the pool, where it would
// starve sends and receipts. Above the cap: 429 + Retry-After 2..5 s (the
// client honours it). Poll v2 (R3) wraps only its computation, never its wait.
// =============================================================================
import { PG_POOL_MAX } from "@/config/db";
import { count } from "@/utils/counters";

const env_int = (name: string, fallback: number): number => {
  const n = parseInt(process.env[name] ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const SYNC_MAX_INFLIGHT = env_int("SYNC_MAX_INFLIGHT", Math.max(2, Math.floor(PG_POOL_MAX * 0.8)));

let inflight = 0;

export type Busy = { busy: true; retry_after_s: number };

/** Run `fn` if under the cap, else report busy (the caller answers 429). */
export const with_sync_admission = async <T>(fn: () => Promise<T>): Promise<T | Busy> => {
  if (inflight >= SYNC_MAX_INFLIGHT) {
    count("SYNC", "429");
    return { busy: true, retry_after_s: 2 + Math.floor(Math.random() * 4) };
  }
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
  }
};

export const is_busy = (v: unknown): v is Busy =>
  typeof v === "object" && v !== null && (v as Busy).busy === true;

export const sync_inflight = (): number => inflight;
