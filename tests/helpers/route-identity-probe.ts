// Child process for tests/store-identity.test.ts: loads REAL route modules
// (admin, sub-admin, chat-poll, livekit) with the REAL app_middleware /
// enforce_device_token / request-auth, but every service, cache, socket and
// config module they import replaced by a recording stub — so nothing here
// can reach a database or Redis. The parent spawns it with --no-env-file and
// dead DB_URL / REDIS_URL, so even a missed stub never touches the project's
// infra. Prints one JSON object (the scenario results) on stdout.
//
// A separate process because mock.module is process-global: stubbing
// services inside `bun test` would leak into the other test files.
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import jwt from "jsonwebtoken";

type Call = { fn: string; args: unknown[] };
const calls: Call[] = [];
const STUB_RESULT = { success: true, code: 200, message: "stub", data: null };

// A callable that records its calls; any property is another such stub
// (LivekitService.get_call_info, FcmService.x, ...). Never thenable.
const stub_fn = (label: string): any =>
  new Proxy(function () { }, {
    apply: (_t, _this, args) => {
      calls.push({ fn: label, args });
      return STUB_RESULT;
    },
    construct: () => stub_fn(`new ${label}`),
    get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : stub_fn(`${label}.${prop}`)),
  });

// Real (pure) modules; everything else a route imports is stubbed.
const REAL = [/^elysia$/, /^drizzle-orm/, /^@\/middleware(\/request-auth)?$/, /^@\/models\//, /^@\/types\//, /^@\/constants\//, /^@\/utils\/(general\.utils|counters)$/];

const ROUTES = join(import.meta.dir, "../../src/routes");

// Named + default imports of a route file, by specifier.
const imports_of = (file: string): Map<string, Set<string>> => {
  const src = readFileSync(join(ROUTES, file), "utf8");
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?/gm)) {
    if (m[1]) continue;
    const clause = m[2]!;
    const names = out.get(m[3]!) ?? new Set<string>();
    const braces = clause.match(/\{([\s\S]*)\}/);
    for (const part of braces ? braces[1]!.split(",") : []) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name && !part.trim().startsWith("type ")) names.add(name);
    }
    const def = clause.replace(/\{[\s\S]*\}/, "").replace(",", "").trim();
    if (def && !def.startsWith("*")) names.add("default");
    out.set(m[3]!, names);
  }
  return out;
};

// ---- barrier: holds N async auth lookups, then releases them in ONE tick,
// as replies parsed from one socket read are. Times out so a lone request
// never hangs.
let barrier_n = 0;
let waiting: (() => void)[] = [];
const hold = (): Promise<void> => {
  if (barrier_n <= 1) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
    const flush = () => {
      const w = waiting;
      waiting = [];
      for (const r of w) r();
    };
    if (waiting.length >= barrier_n) flush();
    else setTimeout(flush, 200);
  });
};

// ---- overrides (on top of the generic stubs)
const ROLES: Record<string, string> = {};
const overrides: Record<string, Record<string, unknown>> = {
  // sub-admin's live-role lookup and app_middleware's own import.
  "@/config/db": {
    default: {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => ({
            limit: async () => {
              await hold();
              const id = find_uid(cond);
              return id && ROLES[id] ? [{ role: ROLES[id] }] : [];
            },
          }),
        }),
      }),
    },
  },
  // enforce_device_token's Redis/DB check: current unless the device is "old".
  "@/services/session.service": {
    is_device_token_current: async (_id: string, device_id: string) => {
      await hold();
      return device_id !== "old";
    },
  },
  "@/services/user.services": {
    admin_set_user_password_pin: async (user_id: string, _pin: string, actor_id: string) => {
      calls.push({ fn: "admin_set_user_password_pin", args: [user_id, actor_id] });
      return { success: true, code: 200, message: "ok", data: { actor_id } };
    },
  },
  "@/sockets/socket.handlers": {
    socket_message_handler: async (ctx: { user_id: string }, message: { payload?: { asker?: string } }) => {
      calls.push({ fn: "socket_message_handler", args: [message.payload?.asker, ctx.user_id] });
      return STUB_RESULT;
    },
  },
};

// The uuid inside a drizzle eq(user_model.id, X) condition.
const find_uid = (cond: unknown): string | null => {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | null => {
    if (v === null || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const val = (v as { value?: unknown }).value;
    if (typeof val === "string" && val in ROLES) return val;
    for (const k of Object.keys(v)) {
      const r = walk((v as Record<string, unknown>)[k]);
      if (r) return r;
    }
    return null;
  };
  return walk(cond);
};

const FILES = ["admin.routes.ts", "sub-admin.routes.ts", "chat-poll.routes.ts", "livekit.routes.ts"];
const stubbed = new Map<string, Set<string>>();
for (const file of FILES) {
  for (const [spec, names] of imports_of(file)) {
    if (REAL.some((r) => r.test(spec))) continue;
    const all = stubbed.get(spec) ?? new Set<string>();
    for (const n of names) all.add(n);
    stubbed.set(spec, all);
  }
}
for (const spec of Object.keys(overrides)) if (!stubbed.has(spec)) stubbed.set(spec, new Set());
for (const [spec, names] of stubbed) {
  const mod: Record<string, unknown> = {};
  for (const n of names) mod[n] = stub_fn(`${spec}#${n}`);
  Object.assign(mod, overrides[spec] ?? {});
  mock.module(spec, () => mod);
}

const { Elysia } = await import("elysia");
const { app_middleware, enforce_device_token } = await import("@/middleware");
const { default: admin_routes } = await import("@/routes/admin.routes");
const { default: sub_admin_routes } = await import("@/routes/sub-admin.routes");
const { chat_poll_routes } = await import("@/routes/chat-poll.routes");
const { default: livekit_routes } = await import("@/routes/livekit.routes");

// The app as server.ts mounts it (prefix /api, sibling plugins).
const app = new Elysia({ prefix: "/api" })
  .use(chat_poll_routes)
  .use(livekit_routes)
  .use(admin_routes)
  .use(sub_admin_routes);

// The OLD guard code, verbatim but for the store write, as the reference for
// "the failure path answers exactly as before".
const legacy = new Elysia({ prefix: "/api" })
  .state({ id: "", role: "" })
  .guard({
    async beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      const superseded = await enforce_device_token(state_result.data);
      if (superseded) {
        set.status = superseded.code;
        return superseded;
      }

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    },
  })
  .post("/chat/poll/send-message", () => ({ unreachable: true }))
  .get("/legacy-admin", () => ({ unreachable: true }));
const legacy_admin = new Elysia()
  .state({ id: "", role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers, allowed: ["admin", "sub_admin"] });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    },
  })
  .get("/api/admin/admins", () => ({ unreachable: true }));

const KEY = process.env.ACCESS_KEY!;
const token = (id: string, role: string, device_id?: string) =>
  jwt.sign(device_id ? { id, role, device_id, token_version: 1 } : { id, role }, KEY, { expiresIn: "1h" });

const U_A = "11111111-1111-4111-8111-111111111111";
const U_B = "22222222-2222-4222-8222-222222222222";
const U_PLAIN = "33333333-3333-4333-8333-333333333333";
ROLES[U_A] = "sub_admin";
ROLES[U_B] = "admin";
ROLES[U_PLAIN] = "user";

type Snap = { status: number; type: string | null; body: string };
const snap = async (r: Response): Promise<Snap> => ({ status: r.status, type: r.headers.get("content-type"), body: await r.text() });
const req = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
  new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

const out: Record<string, unknown> = {};

// 1. sub-admin: async resolve (live DB role) — two users, lookups released in one tick.
barrier_n = 2;
calls.length = 0;
const [ra, rb] = await Promise.all([
  app.handle(req("/api/sub-admin/set-password-pin", { method: "POST", token: token(U_A, "sub_admin"), body: { user_id: "target-a", pin: "1234" } })),
  app.handle(req("/api/sub-admin/set-password-pin", { method: "POST", token: token(U_B, "sub_admin"), body: { user_id: "target-b", pin: "1234" } })),
]);
out.sub_admin = {
  a: { status: ra.status, body: await ra.json() },
  b: { status: rb.status, body: await rb.json() },
  calls: calls.filter((c) => c.fn === "admin_set_user_password_pin").map((c) => c.args),
};

// 2. chat-poll: async resolve (enforce_device_token) — two devices, one tick.
calls.length = 0;
const [pa, pb] = await Promise.all([
  app.handle(req("/api/chat/poll/send-message", { method: "POST", token: token(U_A, "user", "dev-a"), body: { type: "noop", payload: { asker: U_A } } })),
  app.handle(req("/api/chat/poll/send-message", { method: "POST", token: token(U_B, "user", "dev-b"), body: { type: "noop", payload: { asker: U_B } } })),
]);
out.chat_poll = {
  statuses: [pa.status, pb.status],
  calls: calls.filter((c) => c.fn === "socket_message_handler").map((c) => c.args),
};
barrier_n = 0;

// 3. failure paths: identical to the old guard.
const bad_sig = jwt.sign({ id: U_A, role: "user" }, "not-the-key");
out.poll_failures = {
  missing: [await snap(await app.handle(req("/api/chat/poll/send-message", { method: "POST", body: {} }))), await snap(await legacy.handle(req("/api/chat/poll/send-message", { method: "POST", body: {} })))],
  invalid: [await snap(await app.handle(req("/api/chat/poll/send-message", { method: "POST", token: bad_sig, body: {} }))), await snap(await legacy.handle(req("/api/chat/poll/send-message", { method: "POST", token: bad_sig, body: {} })))],
  superseded: [
    await snap(await app.handle(req("/api/chat/poll/send-message", { method: "POST", token: token(U_A, "user", "old"), body: {} }))),
    await snap(await legacy.handle(req("/api/chat/poll/send-message", { method: "POST", token: token(U_A, "user", "old"), body: {} }))),
  ],
};
out.admin_failures = {
  missing: [await snap(await app.handle(req("/api/admin/admins"))), await snap(await legacy_admin.handle(req("/api/admin/admins")))],
  role: [
    await snap(await app.handle(req("/api/admin/admins", { token: token(U_PLAIN, "user") }))),
    await snap(await legacy_admin.handle(req("/api/admin/admins", { token: token(U_PLAIN, "user") }))),
  ],
};
out.sub_admin_failures = {
  missing: await snap(await app.handle(req("/api/sub-admin/set-password-pin", { method: "POST", body: { user_id: "x", pin: "1234" } }))),
  plain_user: await snap(await app.handle(req("/api/sub-admin/set-password-pin", { method: "POST", token: token(U_PLAIN, "user"), body: { user_id: "x", pin: "1234" } }))),
};

// 4. admin: role gate inside a handler reads the per-request role.
out.admin_ok = {
  sub_admin: (await app.handle(req("/api/admin/admins", { token: token(U_A, "sub_admin") }))).status,
  admin: (await app.handle(req("/api/admin/admins", { token: token(U_B, "admin") }))).status,
};

// 5. the unauthenticated seed route is gone (no token, and with an admin token).
out.seed = {
  anon: (await app.handle(req("/api/admin/seed-admin-for-admin-panel"))).status,
  admin: (await app.handle(req("/api/admin/seed-admin-for-admin-panel", { token: token(U_B, "admin") }))).status,
  inserts: calls.filter((c) => c.fn.includes("insert")).length,
};

// 6. scoping: livekit's public routes (before its resolve) stay open, its
// protected ones still demand a token.
out.livekit = {
  public_status: await snap(await app.handle(req("/api/livekit/calls/status/c1", { method: "POST" }))),
  protected_active: (await app.handle(req("/api/livekit/calls/active"))).status,
};

process.stdout.write(JSON.stringify(out));
process.exit(0);
