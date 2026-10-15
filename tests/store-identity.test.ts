// Per-request identity (src/middleware/request-auth.ts) vs the old shared
// Elysia `store`. Elysia's store is ONE object for the whole app: a route
// plugin that wrote store.id in a guard and read it after an await served one
// user's request as another whenever two requests interleaved. The plugins
// now resolve `{ auth }` onto each request's own context.
//
//   1. a plugin built with the helpers, two concurrent requests with an await
//      between auth and the read: each sees its OWN identity — and the same
//      plugin on the old `.state + guard` pattern does NOT (control);
//   2. the REAL admin / sub-admin / chat-poll / livekit route modules, with
//      the real app_middleware + enforce_device_token and every service,
//      cache and config stubbed (tests/helpers/route-identity-probe.ts, run
//      in a child process with --no-env-file and dead DB/Redis URLs, so no
//      database or Redis is ever reached and the module stubs never leak into
//      the other test files);
//   3. the unauthenticated GET /admin/seed-admin-for-admin-panel is gone.
// Run: `bun test tests/store-identity.test.ts`.
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { join } from "node:path";
import { deny_request, request_auth } from "@/middleware/request-auth";

// app_middleware-shaped stand-in: "Bearer <id>:<role>", else the 499 body.
const fake_auth = (headers: Record<string, string | undefined>) => {
  const raw = headers["authorization"]?.replace("Bearer ", "") ?? "";
  if (!raw) return { success: false, code: 499, message: "No Access Token in Cookies", auth_error: "TOKEN_MISSING" };
  const [id, role] = raw.split(":");
  return { success: true, code: 200, message: "Valid Token", data: { id: id!, role: role ?? "user" } };
};

// Holds every caller until `n` are waiting, then releases them all in ONE
// tick — as Redis / Postgres replies parsed from one socket read resolve.
const make_barrier = (n: number) => {
  let waiting: (() => void)[] = [];
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= n) {
        const w = waiting;
        waiting = [];
        for (const r of w) r();
      }
    });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const req = (path: string, who?: string) =>
  new Request(`http://localhost${path}`, { headers: who ? { authorization: `Bearer ${who}` } : {} });

// ---- the new pattern -------------------------------------------------------
// Async check between auth and the identity (enforce_device_token / the
// sub-admin live-role lookup), and a handler that reads the identity after
// its own await (change-phone, forward, delete, beacon, uploads).
const build_new = (gate: () => Promise<void>) =>
  new Elysia({ prefix: "/p" })
    .get("/open", () => ({ open: true }))
    .resolve(async ({ headers, set }) => {
      const r = request_auth(set, fake_auth(headers));
      if (!("auth" in r)) return r;
      await gate();
      if (r.auth.role === "banned") return deny_request(set, { success: false, code: 403, message: "Banned" });
      return r;
    })
    .get("/after-check", ({ auth, headers }) => ({ asked_as: headers["authorization"], served_as: auth.id }))
    .get("/after-own-await", async ({ auth, headers }) => {
      await sleep(10);
      return { asked_as: headers["authorization"], served_as: auth.id };
    });

// ---- the old pattern (control) ---------------------------------------------
const build_old = (gate: () => Promise<void>) =>
  new Elysia({ prefix: "/p" })
    .state({ id: "", role: "" })
    .guard({
      async beforeHandle({ headers, set, store }) {
        const state_result = fake_auth(headers);
        set.status = state_result.code;
        if (!state_result.data) return state_result;
        await gate();
        store.id = state_result.data.id;
        store.role = state_result.data.role;
      },
    })
    .get("/after-check", ({ store, headers }) => ({ asked_as: headers["authorization"], served_as: store.id }))
    .get("/after-own-await", async ({ store, headers }) => {
      await sleep(10);
      return { asked_as: headers["authorization"], served_as: store.id };
    });

type Seen = { asked_as: string; served_as: string };

const race_after_check = async (app: { handle: (r: Request) => Promise<Response> }): Promise<Seen[]> => {
  const [a, b] = await Promise.all([app.handle(req("/p/after-check", "A:user")), app.handle(req("/p/after-check", "B:user"))]);
  return [(await a.json()) as Seen, (await b.json()) as Seen];
};

const race_after_own_await = async (app: { handle: (r: Request) => Promise<Response> }): Promise<Seen[]> => {
  const a = app.handle(req("/p/after-own-await", "A:user"));
  await sleep(2); // A is inside its handler's await when B arrives
  const b = app.handle(req("/p/after-own-await", "B:user"));
  return [(await (await a).json()) as Seen, (await (await b).json()) as Seen];
};

describe("per-request identity (request-auth helpers)", () => {
  test("async check between auth and read: each request sees its own id", async () => {
    const seen = await race_after_check(build_new(make_barrier(2)));
    expect(seen).toEqual([
      { asked_as: "Bearer A:user", served_as: "A" },
      { asked_as: "Bearer B:user", served_as: "B" },
    ]);
  });

  test("handler reads after its own await: each request sees its own id", async () => {
    const seen = await race_after_own_await(build_new(async () => { }));
    expect(seen.map((s) => s.served_as)).toEqual(["A", "B"]);
  });

  test("many interleaved requests never cross", async () => {
    const app = build_new(make_barrier(20));
    const ids = Array.from({ length: 20 }, (_, i) => `u${i}`);
    const res = await Promise.all(ids.map((id) => app.handle(req("/p/after-own-await", `${id}:user`))));
    const seen = (await Promise.all(res.map((r) => r.json()))) as Seen[];
    expect(seen.map((s) => s.served_as)).toEqual(ids);
  });

  test("failure paths: same status + body as returning it from beforeHandle", async () => {
    const now = build_new(async () => { });
    const old = build_old(async () => { });
    const [n, o] = await Promise.all([now.handle(req("/p/after-check")), old.handle(req("/p/after-check"))]);
    expect(n.status).toBe(499);
    expect(n.status).toBe(o.status);
    expect(n.headers.get("content-type")).toBe(o.headers.get("content-type"));
    expect(await n.text()).toBe(await o.text());
    const banned = await now.handle(req("/p/after-check", "C:banned"));
    expect(banned.status).toBe(403);
    expect(await banned.json()).toEqual({ success: false, code: 403, message: "Banned" });
  });

  test("resolve is local: routes before it and sibling plugins stay open", async () => {
    const app = new Elysia()
      .use(build_new(async () => { }))
      .get("/sibling", () => ({ sibling: true }));
    expect((await app.handle(req("/p/open"))).status).toBe(200);
    expect((await app.handle(req("/sibling"))).status).toBe(200);
    expect((await app.handle(req("/p/after-check"))).status).toBe(499);
  });

  // CONTROL: the identical plugin on the old shared-store pattern serves A's
  // request as B. If this ever passes as "own identity", the race tests above
  // are no longer exercising the interleaving.
  test("control: the old .state + guard pattern crosses identities", async () => {
    const after_check = await race_after_check(build_old(make_barrier(2)));
    expect(after_check[0]).toEqual({ asked_as: "Bearer A:user", served_as: "B" });

    const after_own_await = await race_after_own_await(build_old(async () => { }));
    expect(after_own_await[0]).toEqual({ asked_as: "Bearer A:user", served_as: "B" });
  });
});

// ---- real route modules, in a child process -------------------------------
type Snap = { status: number; type: string | null; body: string };
type Probe = {
  sub_admin: { a: { status: number; body: any }; b: { status: number; body: any }; calls: string[][] };
  chat_poll: { statuses: number[]; calls: string[][] };
  poll_failures: Record<"missing" | "invalid" | "superseded", [Snap, Snap]>;
  admin_failures: Record<"missing" | "role", [Snap, Snap]>;
  sub_admin_failures: { missing: Snap; plain_user: Snap };
  admin_ok: { sub_admin: number; admin: number };
  seed: { anon: number; admin: number; inserts: number };
  livekit: { public_status: Snap; protected_active: number };
};

const U_A = "11111111-1111-4111-8111-111111111111";
const U_B = "22222222-2222-4222-8222-222222222222";

let probe: Promise<Probe> | null = null;
const run_probe = (): Promise<Probe> =>
  (probe ??= (async () => {
    const root = join(import.meta.dir, "..");
    const proc = Bun.spawn([process.execPath, "--no-env-file", "run", join(import.meta.dir, "helpers/route-identity-probe.ts")], {
      cwd: root,
      // Nothing from the project's .env: dead DB / Redis endpoints, a test key.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACCESS_KEY: "store-identity-test-key",
        DB_URL: "postgres://127.0.0.1:1/none",
        REDIS_URL: "redis://127.0.0.1:1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`probe exited ${code}: ${err}`);
    return JSON.parse(out) as Probe;
  })());

describe("real route modules (stubbed deps)", () => {
  test("sub-admin: concurrent callers act as themselves (live-role lookup awaited in resolve)", async () => {
    const p = await run_probe();
    expect(p.sub_admin.a.status).toBe(200);
    expect(p.sub_admin.b.status).toBe(200);
    expect(p.sub_admin.a.body.data.actor_id).toBe(U_A);
    expect(p.sub_admin.b.body.data.actor_id).toBe(U_B);
    expect(p.sub_admin.calls).toEqual([["target-a", U_A], ["target-b", U_B]]);
  }, 30_000);

  test("chat-poll: concurrent devices send as themselves (enforce_device_token awaited in resolve)", async () => {
    const p = await run_probe();
    expect(p.chat_poll.statuses).toEqual([200, 200]);
    // [who asked, whom the socket handler acted as]
    expect(p.chat_poll.calls).toEqual([[U_A, U_A], [U_B, U_B]]);
  }, 30_000);

  test("auth failures answer exactly like the old guard (499 / 498 / superseded 401 / role 403)", async () => {
    const p = await run_probe();
    for (const [now, old] of Object.values(p.poll_failures)) expect(now).toEqual(old);
    for (const [now, old] of Object.values(p.admin_failures)) expect(now).toEqual(old);
    expect(p.poll_failures.missing[0].status).toBe(499);
    expect(p.poll_failures.invalid[0].status).toBe(498);
    expect(JSON.parse(p.poll_failures.superseded[0].body)).toMatchObject({ code: 401, auth_error: "DEVICE_SUPERSEDED" });
    expect(JSON.parse(p.admin_failures.role[0].body)).toMatchObject({ code: 403, auth_error: "ROLE_FORBIDDEN" });
    expect(p.sub_admin_failures.missing.status).toBe(499);
    expect(p.sub_admin_failures.plain_user.status).toBe(403);
    expect(JSON.parse(p.sub_admin_failures.plain_user.body)).toEqual({
      success: false, code: 403, message: "Not authorized for sub-admin actions", data: null,
    });
  }, 30_000);

  test("admin: in-handler role gate reads the per-request role", async () => {
    const p = await run_probe();
    expect(p.admin_ok).toEqual({ sub_admin: 403, admin: 200 });
  }, 30_000);

  test("livekit: public routes before the resolve stay open, protected ones need a token", async () => {
    const p = await run_probe();
    expect(p.livekit.public_status.status).toBe(404);
    expect(JSON.parse(p.livekit.public_status.body)).toMatchObject({ message: "Call not found" });
    expect(p.livekit.protected_active).toBe(499);
  }, 30_000);
});

describe("seed route removed", () => {
  test("GET /admin/seed-admin-for-admin-panel is 404 on the admin routes plugin, nothing inserted", async () => {
    const p = await run_probe();
    expect(p.seed).toEqual({ anon: 404, admin: 404, inserts: 0 });
  }, 30_000);
});
