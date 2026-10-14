import { Elysia } from "elysia";
import { client_ip_from_headers, truncate_client_ip } from "@/utils/ip.utils";
import { GIT_REV, WORKER_ID } from "@/cluster/identity";
import {
  event_loop_lag_ms,
  ready_checks,
  state,
} from "@/cluster/lifecycle";
import { db_ping } from "@/config/db";
import { rfast_ping } from "@/cluster/redis-fast";

// =============================================================================
// Health / reachability endpoints (SYNC_V2 §13.9.1, §14.6)
// =============================================================================
// /api/ping (R0.1), /api/healthz and /api/readyz (RC-1). None is behind the
// auth guard. nginx should allow /api/readyz only from 127.0.0.1.
//
// /api/ping is the app's reachability + RTT probe. It must stay cheap and
// dependency-free: no auth, no DB, no Redis — a probe that hangs when Redis
// is slow would make the app think the *network* is down. The JSON marker
// (`svc:"amigo"`) is what tells the app it reached US and not a captive
// portal or a Cloudflare error page (those are HTML, or JSON without it).
// `t` lets the client estimate clock offset; `ip` is the public network
// (/24 or /48) the request came from — used as a coarse per-network key, so
// the full address is never echoed.


// healthz = liveness (the watchdog restarts the process after 3 failures):
// "is this process able to run JavaScript in time". Deliberately NO
// dependency checks — an RDS or Redis outage must not make the watchdog
// restart a healthy process into the same outage.
const HEALTH_MAX_LAG_MS = 2000;

// readyz = "send me traffic": checks the dependencies with tight deadlines.
// The verdict is cached for 2 s and concurrent probes share one evaluation,
// so a probe storm cannot turn into a SELECT 1 storm on the pool.
const READY_CACHE_MS = 2000;
const READY_DB_DEADLINE_MS = 1000;
const READY_RFAST_DEADLINE_MS = 500;
const READY_CHECK_DEADLINE_MS = 500;

type ReadyVerdict = { ok: boolean; reason?: string };
let ready_cache: { at: number; verdict: ReadyVerdict } | null = null;
let ready_in_flight: Promise<ReadyVerdict> | null = null;

const with_deadline = async (p: boolean | Promise<boolean>, ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const evaluate_dependencies = async (): Promise<ReadyVerdict> => {
  const [db_ok, rfast_ok, ...extra] = await Promise.all([
    db_ping(READY_DB_DEADLINE_MS),
    rfast_ping(READY_RFAST_DEADLINE_MS),
    ...ready_checks.map((c) => with_deadline(c.fn(), READY_CHECK_DEADLINE_MS)),
  ]);
  if (!db_ok) return { ok: false, reason: "db" };
  if (!rfast_ok) return { ok: false, reason: "redis" };
  for (let i = 0; i < ready_checks.length; i++) {
    if (!extra[i]) return { ok: false, reason: ready_checks[i].name };
  }
  return { ok: true };
};

const dependencies_verdict = async (): Promise<ReadyVerdict> => {
  const now = Date.now();
  if (ready_cache && now - ready_cache.at < READY_CACHE_MS) return ready_cache.verdict;
  if (!ready_in_flight) {
    ready_in_flight = evaluate_dependencies()
      .then((verdict) => {
        ready_cache = { at: Date.now(), verdict };
        return verdict;
      })
      .finally(() => {
        ready_in_flight = null;
      });
  }
  return ready_in_flight;
};

const health_routes = new Elysia()
  .get("/ping", ({ request, set }) => {
    // no-store: an intermediate cache (Cloudflare, a captive proxy) answering
    // from cache would report "reachable" for a network that is not.
    set.headers["cache-control"] = "no-store";
    return {
      svc: "amigo",
      t: Date.now(),
      ip: truncate_client_ip(client_ip_from_headers(request.headers)),
    };
  })

  .get("/healthz", ({ set }) => {
    set.headers["cache-control"] = "no-store";
    const lag_ms = event_loop_lag_ms();
    const ok = lag_ms <= HEALTH_MAX_LAG_MS;
    if (!ok) set.status = 503;
    return { svc: "amigo", ok, w: WORKER_ID, rev: GIT_REV, ...(ok ? {} : { lag_ms }) };
  })

  .get("/readyz", async ({ set }) => {
    set.headers["cache-control"] = "no-store";
    const not_ready = (reason: string) => {
      set.status = 503;
      return { svc: "amigo", ok: false, w: WORKER_ID, rev: GIT_REV, reason };
    };
    // State first: instant, never cached — a drain must flip readyz to 503
    // on the very next probe.
    if (state.draining) return not_ready("draining");
    if (!state.ready) return not_ready("starting");
    if (!state.http_listening || !state.ws_listening) return not_ready("listener");
    const verdict = await dependencies_verdict();
    if (!verdict.ok) return not_ready(verdict.reason ?? "dependency");
    return { svc: "amigo", ok: true, w: WORKER_ID, rev: GIT_REV };
  });

export default health_routes;
