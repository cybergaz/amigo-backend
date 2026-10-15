// GET /api/admin/sync-health (SYNC_V2_PROTOCOL.md §10, R1a subset): flags and
// markers this worker sees, the Sync v2 counters of the current window, how
// many chats are still unnumbered, and the receipt runner backlog. Per
// worker (counters are per process); admin-only, never on a hot path.
import { pg_client } from "@/config/db";
import { sync_v2_flags } from "@/services/app-settings.service";
import { snapshot_counters } from "@/utils/counters";
import { rfast, deadline } from "@/cluster/redis-fast";
import { k } from "@/cluster/keys";
import { WORKER_ID } from "@/cluster/identity";
import { watermark_stats } from "./watermark.service";
import { poll_waiter_count } from "@/cache-management/sync-nudge";

const TAGS = ["SEQ", "RCPT", "UNREAD-SHADOW", "SWEEPER", "SYNC", "JOBS", "POLL2", "HEADS", "DELTA"];

export const sync_health = async () => {
  const counters = snapshot_counters();
  const picked: Record<string, Record<string, number>> = {};
  for (const t of TAGS) if (counters[t]) picked[t] = counters[t]!;
  const [chats, dirty] = await Promise.all([
    pg_client<{ unnumbered: string; total: string }[]>`
      SELECT count(*) FILTER (WHERE seq_head IS NULL)::text AS unnumbered, count(*)::text AS total FROM chats`
      .then((r) => ({ unnumbered: Number(r[0]?.unnumbered ?? 0), total: Number(r[0]?.total ?? 0) }))
      .catch(() => null),
    deadline(rfast.scard(k.minwm_dirty()), 1_000, "minwm scard").catch(() => null),
  ]);
  return {
    worker: WORKER_ID,
    flags: sync_v2_flags(),
    chats,
    minwm_dirty_backlog: dirty,
    // §10 [POLL2] waiters: poll v2 requests parked on THIS worker right now.
    poll_waiters: poll_waiter_count(),
    ...watermark_stats(),
    counters: picked,
  };
};
