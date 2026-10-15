// =============================================================================
// FCM health (SYNC_V2 §14.13) — pure helpers (no config imports; tested)
// =============================================================================
import type { WSMessage } from "@/types/socket.types";

export const FCM_FAST_WINDOW_MS = 2 * 60_000;
export const FCM_HEALTH_TTL_S = 8 * 86_400;
export const FCM_HEALTH_DAYS = 7;

/** UTC day "yyyymmdd". */
export const utc_day = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

/** The last `n` UTC days ending today, newest first. */
export const last_days = (n: number, now = Date.now()): string[] =>
  Array.from({ length: n }, (_, i) => utc_day(now - i * 86_400_000));

/** fast / sent capped at 1; null when nothing was sent. */
export const fcm_health_ratio = (sent: number, fast: number): number | null =>
  sent > 0 ? Math.min(1, Math.max(0, fast) / sent) : null;

// message:new a client will receipt: system rows / the disappearing notice
// are never acked by either app build, so counting them in `sent` would
// drag every chat with notices below its real health.
export const count_message_new = (ws_messages: WSMessage[]): number => {
  let n = 0;
  for (const m of ws_messages) {
    if (m?.type !== "message:new") continue;
    const p = (m.payload ?? {}) as Record<string, unknown>;
    if (p.msg_type === "system" || p.system_actor === true) continue;
    n++;
  }
  return n;
};

/** Was this FCM-path receipt "fast" (message reached the server ≤ 2 min ago)? */
export const is_fast_receipt = (created_at: Date | string | null | undefined, now = Date.now()): boolean => {
  if (!created_at) return false;
  const t = new Date(created_at).getTime();
  return Number.isFinite(t) && now - t >= 0 && now - t <= FCM_FAST_WINDOW_MS;
};
