// =============================================================================
// /api/sub-admin/load-test/* — load & accuracy test tool (hidden app screen)
// =============================================================================
// OFF unless the backend env has LOAD_TEST_ENABLED=true (read on every
// request, so flipping it needs no code change; a restart is enough for an
// env file). When off, every endpoint answers 404 reason "load_test_off"
// BEFORE authentication, so a server without the tool does not even reveal
// that the routes exist behind a token. Not set in any deploy/*.env.example
// on purpose: enable it only on a server meant for load testing.
//
// Then the same guard as sub-admin.routes.ts: authenticate the token, gate on
// the LIVE DB role (admin | sub_admin), business 403 without auth_error so a
// refused call never logs the app out. Logic: services/load-test.service.ts;
// body rules / caps / verify math: services/load-test-core.ts. Contract:
// shared with the app (scratchpad loadtest/CONTRACT.md).
// =============================================================================
import Elysia, { t } from "elysia";
import { eq } from "drizzle-orm";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { app_middleware } from "@/middleware";
import { deny_request, request_auth } from "@/middleware/request-auth";
import {
  load_test_enabled,
  parse_cleanup_body,
  parse_dms_body,
  parse_groups_body,
  parse_members_body,
  parse_page_query,
  parse_receipts_body,
  parse_send_body,
  parse_users_body,
  parse_verify_body,
  type Parsed,
} from "@/services/load-test-core";
import {
  lt_change_members,
  lt_cleanup,
  lt_create_dms,
  lt_create_groups,
  lt_create_users,
  lt_list_chats,
  lt_list_users,
  lt_receipts,
  lt_send,
  lt_status,
  lt_verify,
} from "@/services/load-test.service";

const OFF_BODY = {
  success: false,
  code: 404,
  message: "Load testing is disabled on this server",
  reason: "load_test_off",
  data: null,
} as const;

type SetLike = { status?: number | string };

// One envelope for every outcome: status = body.code.
const reply = <T extends { code: number }>(set: SetLike, body: T): T => {
  set.status = body.code;
  return body;
};

const bad_request = (set: SetLike, p: Extract<Parsed<unknown>, { ok: false }>) =>
  reply(set, { success: false, code: 400, message: p.message, reason: p.reason, data: null });

// Unexpected throw (DB down, ...): a 500 in the same envelope, logged.
const guarded = async <T extends { code: number }>(set: SetLike, label: string, fn: () => Promise<T>) => {
  try {
    return reply(set, await fn());
  } catch (err: any) {
    console.error(`[LOAD-TEST] ${label} failed:`, err);
    return reply(set, { success: false, code: 500, message: `Load test ${label} failed: ${err?.message ?? err}`, reason: "server_error", data: null });
  }
};

export const load_test_routes = new Elysia({ prefix: "/sub-admin/load-test" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide store.
  .resolve(async ({ cookie, set, headers }) => {
    if (!load_test_enabled()) return deny_request(set, OFF_BODY);

    const state_result = app_middleware({ cookie, headers });
    const r = request_auth(set, state_result);
    if (!("auth" in r)) return r;

    // LIVE role, not the token's (see sub-admin.routes.ts for why).
    const [row] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, r.auth.id))
      .limit(1);

    if (!row || (row.role !== "admin" && row.role !== "sub_admin")) {
      return deny_request(set, {
        success: false,
        code: 403,
        message: "Not authorized for load testing",
        reason: "not_sub_admin",
        data: null,
      });
    }

    return { auth: { id: r.auth.id.toLowerCase(), role: row.role } };
  })

  .get("/status", ({ set }) => guarded(set, "status", () => lt_status()))

  .post("/users", ({ set, body }) => {
    const p = parse_users_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "users", () => lt_create_users(p.value.count));
  }, { body: t.Any() })

  .get("/users", ({ set, query }) => {
    const { limit, offset } = parse_page_query(query as Record<string, unknown>);
    return guarded(set, "users list", () => lt_list_users(limit, offset));
  })

  .post("/dms", ({ set, auth, body }) => {
    const p = parse_dms_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "dms", () => lt_create_dms(auth.id, p.value.pairs));
  }, { body: t.Any() })

  .post("/groups", ({ set, auth, body }) => {
    const p = parse_groups_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "groups", () => lt_create_groups(auth.id, p.value));
  }, { body: t.Any() })

  .get("/chats", ({ set, auth }) => guarded(set, "chats", () => lt_list_chats(auth.id)))

  .post("/members", ({ set, auth, body }) => {
    const p = parse_members_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "members", () => lt_change_members(auth.id, p.value));
  }, { body: t.Any() })

  .post("/send", ({ set, auth, body }) => {
    const p = parse_send_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "send", () => lt_send(auth.id, p.value));
  }, { body: t.Any() })

  .post("/receipts", ({ set, auth, body }) => {
    const p = parse_receipts_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "receipts", () => lt_receipts(auth.id, p.value));
  }, { body: t.Any() })

  .post("/verify", ({ set, auth, body }) => {
    const p = parse_verify_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "verify", () => lt_verify(auth.id, p.value));
  }, { body: t.Any() })

  .post("/cleanup", ({ set, auth, body }) => {
    const p = parse_cleanup_body(body);
    if (!p.ok) return bad_request(set, p);
    return guarded(set, "cleanup", () => lt_cleanup(auth.id, p.value.scope));
  }, { body: t.Any() });

export default load_test_routes;
