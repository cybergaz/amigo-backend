import type { Server } from "bun";
import {
  await_tracked,
  drain_sleep,
  is_fast_drain,
  state,
  tracked_count,
} from "./lifecycle";
import { beat_draining, has_live_sibling, stop_beat_and_delete } from "./beat";
import { rfast } from "./redis-fast";
import { bus } from "./bus";
import { WORKER_ID } from "./identity";
import {
  close_sockets_for_restart,
  final_last_seen_flush,
  open_socket_count,
  stop_socket_timers,
} from "@/sockets/socket.server";
import { flush_all as flush_all_fcm_batches } from "@/services/fcm-batch.service";
import { flush_fcm_health } from "@/services/fcm-health";
import { drop_pending_db_timers } from "@/cache-management/polling.cache";
import { drain_poll_waiters } from "@/cache-management/sync-nudge";
import { close_db } from "@/config/db";
import { redis } from "@/config/redis";
import { flush_counters } from "@/utils/counters";

// =============================================================================
// Graceful drain (SYNC_V2 §13.9.3)
// =============================================================================
// Slow drain (first SIGTERM/SIGINT), budget ≈ 63 s of the 80 s hard exit:
//   t0      readyz 503, stop listening, answer parked poll v2 requests
//           ({drain:true}), beat draining:true (routable, not a sibling),
//           stop timers, write the pending last_seen batch
//   0–3 s   let in-flight HTTP requests finish
//   3–48 s  close WS in 45 batches (~2% each, 1/s) with 1012 + socket:restart
//           — or 10 batches over 5 s when no live sibling exists (tmux /
//           single-slot restart: nobody can take the users, so waiting only
//           delays the reconnect to the next process)
//   ≤12 s   await tracked work (frame handlers, detached fan-outs)
//   ≤3 s    flush FCM batches, drop DB timers
//   end     close remaining connections, quit the bus, DEL our beat, quit
//           Redis, end PG pool
// A second signal switches every remaining phase to its fast budget (~10 s).

type DrainResources = {
  http_server: Server | null;
  ws_server: Server | null;
  // Background workers (receipt / message-status flush, sweeper); each
  // resolves once its in-flight batch finished.
  stop_workers: Array<() => Promise<void>>;
};

const resources: DrainResources = {
  http_server: null,
  ws_server: null,
  stop_workers: [],
};

const register_drain_resources = (r: Partial<DrainResources>) => {
  Object.assign(resources, r);
};

// slow / fast budgets per phase (ms)
const budget = (slow_ms: number, fast_ms: number) => (is_fast_drain() ? fast_ms : slow_ms);

const bounded = async <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } catch (err) {
    console.error("[SHUTDOWN] step failed:", err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const stop_listening = (server: Server | null, label: string) => {
  if (!server) return;
  try {
    // false = stop accepting, keep in-flight requests and open WebSockets.
    // Not awaited: its promise resolves only when every connection is gone.
    void Promise.resolve(server.stop(false)).catch((err) =>
      console.error(`[SHUTDOWN] ${label} stop(false) failed:`, err),
    );
  } catch (err) {
    console.error(`[SHUTDOWN] ${label} stop(false) threw:`, err);
  }
};

const run_drain = async (): Promise<void> => {
  const t0 = Date.now();
  let phase_at = t0;
  const phase = (name: string, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    console.log(
      `[SHUTDOWN] ${name} ${now - phase_at}ms (t=${now - t0}ms) ${JSON.stringify(extra)}`,
    );
    phase_at = now;
  };
  const { http_server, ws_server } = resources;

  // ---- t0: stop being chosen -------------------------------------------
  state.ready = false;
  stop_listening(http_server, "http");
  stop_listening(ws_server, "ws");
  state.http_listening = false;
  state.ws_listening = false;
  // Poll v2 (R3, §13.17.6): every parked long-poll answers {drain:true} +
  // Connection: close NOW, so its client re-polls a sibling at once instead
  // of holding this worker's pendingRequests for up to 25 s (the HTTP phase
  // below waits ≤ 3 s, then the connection would be cut mid-wait).
  const poll_answered = drain_poll_waiters();
  // has_live_sibling only counts READY workers, so it never counts us.
  const sibling_p = has_live_sibling();
  // Not a DEL: siblings' routers must keep delivering to the sockets we still
  // hold for up to ~45 s (P12). The key goes at the end, after the bus.
  await beat_draining();
  await bounded(
    Promise.allSettled([stop_socket_timers(), ...resources.stop_workers.map((stop) => stop())]),
    budget(5_000, 1_000),
  );
  // Before any socket is closed: the batch only writes users still in
  // socket_connections, and drained sockets skip the close-path last_seen.
  await bounded(final_last_seen_flush(), budget(3_000, 1_000));
  phase("stopped_listening", { wid: WORKER_ID, mode: state.drain_mode, poll_answered });

  // ---- 0–3 s: in-flight HTTP ---------------------------------------------
  if (http_server) {
    const until = Date.now() + budget(3_000, 1_000);
    while (http_server.pendingRequests > 0 && Date.now() < until) {
      await drain_sleep(50);
    }
    phase("http_pending", { left: http_server.pendingRequests });
  }

  // ---- 3–48 s: hand WebSockets over ----------------------------------------
  const has_sibling = await bounded(sibling_p, 1_500) ?? false;
  const ws_total = open_socket_count();
  let ws_closed = 0;
  let batches_left = has_sibling ? 45 : 10;
  let switched_to_fast = is_fast_drain();
  if (switched_to_fast) batches_left = Math.min(batches_left, 5);
  while (true) {
    const remaining = open_socket_count();
    if (remaining === 0) break;
    if (is_fast_drain() && !switched_to_fast) {
      switched_to_fast = true;
      batches_left = Math.min(batches_left, 5);
    }
    if (batches_left <= 1) {
      ws_closed += close_sockets_for_restart(remaining);
      break;
    }
    ws_closed += close_sockets_for_restart(Math.ceil(remaining / batches_left));
    batches_left--;
    await drain_sleep(is_fast_drain() || !has_sibling ? 500 : 1_000);
  }
  phase("ws_closed", { ws_total, ws_closed, has_sibling });

  // ---- tracked work ------------------------------------------------------
  const inflight_left = await await_tracked(budget(12_000, 3_000));
  phase("tracked_work", { inflight_left });

  // ---- flushes -----------------------------------------------------------
  const fcm_flushed = await bounded(flush_all_fcm_batches(), budget(3_000, 2_000));
  // The pushes just flushed were counted into the §14.13 health accumulator,
  // whose own timer stopped at t0.
  await bounded(flush_fcm_health(), 1_000);
  const dropped_db_timers = drop_pending_db_timers();
  phase("flushed", { fcm_batches: fcm_flushed ?? "timeout", dropped_db_timers });

  // ---- close everything ------------------------------------------------------
  for (const [server, label] of [
    [http_server, "http"],
    [ws_server, "ws"],
  ] as const) {
    if (!server) continue;
    try {
      await bounded(Promise.resolve(server.stop(true)), 1_000);
    } catch (err) {
      console.error(`[SHUTDOWN] ${label} stop(true) failed:`, err);
    }
  }
  flush_counters();
  // The bus subscriber goes first: from here on no socket is left to deliver
  // an inbox frame or invalidation to. Then the beat key (siblings now see
  // us dead: their publishes are counted as such and our keys released),
  // then the other connections (the DEL needs rfast).
  await bounded(bus.quit().then(() => undefined), 1_000);
  await bounded(stop_beat_and_delete(), 1_500);
  await bounded(
    Promise.allSettled([redis.quit(), rfast.quit()]).then(() => undefined),
    1_000,
  );
  await close_db(is_fast_drain() ? 1 : 3);
  phase("closed", {
    total_ms: Date.now() - t0,
    ws_closed,
    inflight_left: tracked_count(),
    dropped_db_timers,
  });
};

export { run_drain, register_drain_resources };
