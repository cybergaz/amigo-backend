// =============================================================================
// POST /api/net/beacon — client network telemetry (SYNC_V2 §14.14)
// =============================================================================
// Authenticated (app_middleware, like every app route). 404 unless
// app_settings.sync_v2_net_telemetry is on and the net_beacons table exists
// (marker sync_v2_net_beacons) — what an old backend answers, so a client
// simply keeps its counters. The body is read by hand with a hard 4 KB cap
// (parse: 'none'), so an oversized body is refused without being buffered.
//   204  accepted, or dropped by the 1-per-60 s rate limit
//   400  {reason}: not JSON / bad shape      413 {reason:'too_large'}
//   503  Redis unavailable (Retry-After; the client keeps its counters)
// =============================================================================
import Elysia from "elysia";
import { app_middleware } from "@/middleware";
import { deny_request, request_auth } from "@/middleware/request-auth";
import { sync_v2_flags } from "@/services/app-settings.service";
import { net_beacon_active } from "@/services/sync/flags-core";
import { BEACON_MAX_BYTES, parse_beacon_body } from "@/services/net-beacon-core";
import { accept_beacon } from "@/services/net-beacon.service";
import { client_ip_from_headers, truncate_client_ip } from "@/utils/ip.utils";
import { count } from "@/utils/counters";

// The body as text, or null past `max` bytes (Content-Length first, then
// counted while streaming for chunked bodies).
const read_capped = async (req: Request, max: number): Promise<string | null> => {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => { });
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const net_routes = new Elysia({ prefix: "/net" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide store.
  .resolve(({ cookie, set, headers }) => {
    const r = request_auth(set, app_middleware({ cookie, headers }));
    if (!("auth" in r)) return r;

    if (!net_beacon_active(sync_v2_flags())) {
      return deny_request(set, { success: false, code: 404, message: "Not found", reason: "net_beacon_off" });
    }
    return r;
  })

  .post("/beacon", async ({ request, set, auth }) => {
    const text = await read_capped(request, BEACON_MAX_BYTES);
    if (text === null) {
      count("NET", "beacon_too_large");
      set.status = 413;
      return { success: false, code: 413, message: "Beacon too large", reason: "too_large" };
    }
    const v = parse_beacon_body(text);
    if (!v.ok) {
      count("NET", "beacon_rejected");
      set.status = v.reason === "too_large" ? 413 : 400;
      return { success: false, code: set.status, message: "Bad beacon", reason: v.reason };
    }
    const r = await accept_beacon(auth.id, {
      payload: v.payload,
      app_ver: v.app_ver,
      ip24: truncate_client_ip(client_ip_from_headers(request.headers)),
    });
    if (r === "failed") {
      set.status = 503;
      set.headers["retry-after"] = "60";
      return { success: false, code: 503, message: "Temporarily unavailable", reason: "server_error" };
    }
    set.status = 204;
    return null;
  }, { parse: "none" });
