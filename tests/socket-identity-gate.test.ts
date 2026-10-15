// socket_message_handler's identity gates (src/sockets/socket.handlers.ts):
// with no authenticated id, message:new / message:forward /
// conversation:typing are refused (fail closed, AUTH/no_identity); with one,
// the actor is pinned to it; typing is gated on chat membership.
//
// The real handler runs in tests/helpers/socket-identity-gate.harness.ts with
// its DB / Redis / cluster dependencies stubbed by mock.module(). Those mocks
// are process-wide, so the harness runs in a CHILD `bun test` process instead
// of in this one — the other test files keep the real modules. No database /
// Redis is touched. Run: `bun test tests/socket-identity-gate.test.ts`.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("socket identity gates (isolated harness)", async () => {
  const root = join(import.meta.dir, "..");
  const proc = Bun.spawn(
    [process.execPath, "test", "./tests/helpers/socket-identity-gate.harness.ts"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      // The harness needs no env; don't hand it DB_URL / REDIS_URL either.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" },
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const report = `${out}\n${err}`;
  if (code !== 0) console.error(report);
  expect(code).toBe(0);
  // Guard against the child silently running nothing.
  expect(report).toMatch(/\b8 pass\b/);
  expect(report).toMatch(/\b0 fail\b/);
}, 60_000);
