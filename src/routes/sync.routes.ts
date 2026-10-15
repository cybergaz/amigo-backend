// =============================================================================
// /chat/sync/*: Sync v2 pull + intents (SYNC_V2_PROTOCOL.md §4.2)
// =============================================================================
// Same guard as chat-poll.routes.ts (app_middleware + enforce_device_token),
// unchanged auth. Then THE gate (read-core sync_v2_gate): unless
// app_settings.sync_v2 = 'on', the backfill + post-index markers are set and
// the user is in the rollout bucket, every route answers 404 — exactly what
// an old backend answers, which is how the app's capability probe decides to
// stay on the legacy paths (§4.1). Then admission control (429).
//
//   GET  /chat/sync/heads?stubs_after=<ms>            If-None-Match → 304
//   GET  /chat/sync/:chat_id?since=&limit=&mode=&before=
//   POST /chat/sync/chats    {ids ≤ 100}
//   POST /chat/sync/resolve  {ids ≤ 500}
//   POST /chat/sync/intents  {intents ≤ 100}
//   POST /chat/sync/poll     long-poll of the whole sync state (R3, §3.11;
//                            contract at handle_poll / poll-core)
// =============================================================================
import Elysia, { t } from "elysia";
import { app_middleware, enforce_device_token } from "@/middleware";
import { deny_request, request_auth } from "@/middleware/request-auth";
import { sync_v2_flags } from "@/services/app-settings.service";
import {
  CHATS_MAX_IDS,
  INTENTS_MAX,
  RESOLVE_MAX_IDS,
  SYNC_PROTO,
  is_uuid,
  parse_delta_params,
  parse_id_list,
  parse_stubs_after,
  sync_v2_gate,
} from "@/services/sync/read-core";
import { get_chat_delta, get_heads, get_sync_chats, resolve_messages, type Served } from "@/services/sync/read.service";
import { process_intents } from "@/services/sync/intents.service";
import { is_busy, with_sync_admission } from "@/services/sync/admission";
import { set_proto_lease_soon } from "@/services/sync/proto-lease";
import { parse_poll_request } from "@/services/sync/poll-core";
import { handle_poll } from "@/services/sync/poll.service";

type SetLike = { status?: number | string; headers: Record<string, string | number> };

// POST bodies carry NO Elysia schema on purpose: Elysia validates a body
// before the auth resolve, so a schema would answer 400 (with
// validation details) to an unauthenticated caller and while the gate is
// closed, where the contract is 401 / 404 exactly like an old backend. The
// handlers validate after the guard (parse_id_list, the intents check).
const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;

const bad = (set: SetLike, reason: string, message = "Bad request") => {
  set.status = 400;
  return { success: false, code: 400, message, reason };
};

// Admission + a uniform answer for thrown errors: a sync call that failed on
// the server is always retryable for the client (503, never a terminal 4xx).
const run = async (set: SetLike, label: string, fn: () => Promise<Served>) => {
  try {
    const r = await with_sync_admission(fn);
    if (is_busy(r)) {
      set.status = 429;
      set.headers["retry-after"] = String(r.retry_after_s);
      return { success: false, code: 429, message: "Busy, retry later", reason: "busy" };
    }
    if (r.status === 304) {
      return new Response(null, { status: 304, headers: { etag: `"${r.etag}"`, "cache-control": "private, no-cache" } });
    }
    set.status = r.status;
    if (r.status === 200 && r.etag) {
      set.headers.etag = `"${r.etag}"`;
      set.headers["cache-control"] = "private, no-cache";
    }
    return r.body;
  } catch (err: any) {
    console.error(`[SYNC] ${label} failed: ${err?.code ?? ""} ${err?.message ?? err}`);
    set.status = 503;
    return { success: false, code: 503, message: "Temporarily unavailable", reason: "server_error" };
  }
};

export const sync_routes = new Elysia({ prefix: "/chat/sync" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide store.
  .resolve(async ({ cookie, set, headers }) => {
    const state_result = app_middleware({ cookie, headers });
    const r = request_auth(set, state_result);
    if (!("auth" in r) || !state_result.data) return r;

    // Single-device enforcement, as on the polling path: a superseded
    // device must not keep pulling state.
    const superseded = await enforce_device_token(state_result.data);
    if (superseded) return deny_request(set, superseded);

    const gate = sync_v2_gate(r.auth.id, sync_v2_flags());
    if (!gate.ok) {
      return deny_request(set, { success: false, code: 404, message: "Not found", reason: gate.reason });
    }
    return r;
  })

  .get("/heads", async ({ set, auth, query, headers }) => {
    const stubs_after = parse_stubs_after(query.stubs_after);
    if (stubs_after === undefined) return bad(set, "bad_stubs_after");
    // §3.13: heads (a v2 client's first call, often over HTTP only on
    // cheap Wi-Fi) holds the proto:{uid} lease like a ?proto=2 WS connect.
    // Fire-and-forget, a no-op while sync_v2_proto_lease is off.
    set_proto_lease_soon(auth.id);
    return run(set, "heads", () =>
      get_heads(auth.id, { stubs_after, if_none_match: headers["if-none-match"] ?? null }));
  }, {
    query: t.Object({ stubs_after: t.Optional(t.String()) }),
  })

  .post("/chats", async ({ set, auth, body }) => {
    const ids = parse_id_list(field(body, "ids"), CHATS_MAX_IDS);
    if (!ids.ok) return bad(set, ids.reason);
    return run(set, "chats", () => get_sync_chats(auth.id, ids.value));
  })

  .post("/resolve", async ({ set, auth, body }) => {
    const ids = parse_id_list(field(body, "ids"), RESOLVE_MAX_IDS);
    if (!ids.ok) return bad(set, ids.reason);
    return run(set, "resolve", () => resolve_messages(auth.id, ids.value));
  })

  .post("/intents", async ({ set, auth, body }) => {
    const intents = field(body, "intents");
    if (!Array.isArray(intents)) return bad(set, "intents_required");
    if (intents.length > INTENTS_MAX) return bad(set, `too_many_intents_max_${INTENTS_MAX}`);
    return run(set, "intents", async () => {
      const results = await process_intents(auth.id, intents);
      return {
        status: 200 as const,
        body: {
          success: true,
          code: 200,
          data: { proto: SYNC_PROTO, server_time: new Date().toISOString(), results },
        },
      };
    });
  })

  // Poll v2 (R3). Admission control covers each computation, never the
  // wait (handle_poll). Answers: 200 (also {superseded} / {drain} + Connection:
  // close), 400 {reason}, 404 gate closed, 429 + Retry-After, 503 {reason}
  // (retryable: 'slow' / 'server_error').
  .post("/poll", async ({ set, auth, body, request }) => {
    const parsed = parse_poll_request(body);
    if (!parsed.ok) return bad(set, parsed.reason);
    const client_ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip")
      || "unknown";
    set.headers["cache-control"] = "no-store";
    try {
      const r = await handle_poll(auth.id, client_ip, parsed.value, request.signal);
      if (r.status === 429) {
        set.status = 429;
        set.headers["retry-after"] = String(r.retry_after_s);
        return { success: false, code: 429, message: "Busy, retry later", reason: "busy" };
      }
      if (r.status === 503) {
        set.status = 503;
        set.headers["retry-after"] = "2";
        return { success: false, code: 503, message: "Temporarily unavailable", reason: r.reason };
      }
      // Drain: the keep-alive connection to a leaving worker must not be
      // reused for the re-poll (nginx then picks a sibling).
      if (r.close) set.headers["connection"] = "close";
      set.status = 200;
      return r.body;
    } catch (err: any) {
      console.error(`[SYNC] poll failed: ${err?.code ?? ""} ${err?.message ?? err}`);
      set.status = 503;
      return { success: false, code: 503, message: "Temporarily unavailable", reason: "server_error" };
    }
  })

  .get("/:chat_id", async ({ set, auth, params, query }) => {
    if (!is_uuid(params.chat_id)) return bad(set, "bad_chat_id");
    const p = parse_delta_params(query as Record<string, unknown>);
    if (!p.ok) return bad(set, p.reason);
    return run(set, "delta", () => get_chat_delta(auth.id, params.chat_id.toLowerCase(), p.value));
  }, {
    params: t.Object({ chat_id: t.String() }),
    query: t.Object({
      since: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      mode: t.Optional(t.String()),
      before: t.Optional(t.String()),
    }),
  });
