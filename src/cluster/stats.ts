import { STARTED_AT, WORKER_ID } from "./identity";
import { list_live_workers } from "./beat";
import { ROUTING_MODE } from "./mode";

// =============================================================================
// Cluster-wide stats for the admin dashboard (SYNC_V2 §13.7 A10/A11, §13.15)
// =============================================================================
// Read from the worker beats (worker:{wid}, refreshed every 5 s), so the
// numbers are ≤ 5 s old and cover every live worker of this deployment —
// not just whichever worker happened to serve the admin request.

type WorkerRow = {
  wid: string;
  host: string;
  slot: string;
  pid: number;
  rev: string;
  ws: number;
  poll: number;
  lag_ms: number;
  ready: boolean;
  uptime_s: number;
  beat_age_ms: number;
  self: boolean;
};

type ClusterStats = {
  self: string;
  routing: string;
  // false = Redis did not answer; the numbers are this worker's only
  complete: boolean;
  online: number;
  ws: number;
  poll: number;
  workers: WorkerRow[];
};

const cluster_stats = async (): Promise<ClusterStats> => {
  const now = Date.now();
  const { workers, complete } = await list_live_workers();
  const rows: WorkerRow[] = workers.map((b) => ({
    wid: b.wid,
    host: b.host,
    slot: b.slot,
    pid: b.pid,
    rev: b.rev,
    ws: b.ws,
    poll: b.poll,
    lag_ms: b.lag_ms,
    ready: b.ready,
    uptime_s: Math.round((now - (b.wid === WORKER_ID ? STARTED_AT : b.started)) / 1000),
    beat_age_ms: Math.max(0, now - b.ts),
    self: b.wid === WORKER_ID,
  }));
  const ws = rows.reduce((n, r) => n + r.ws, 0);
  const poll = rows.reduce((n, r) => n + r.poll, 0);
  return { self: WORKER_ID, routing: ROUTING_MODE, complete, online: ws + poll, ws, poll, workers: rows };
};

export { cluster_stats };
export type { ClusterStats, WorkerRow };
