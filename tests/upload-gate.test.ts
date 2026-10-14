// Unit tests for the large-upload semaphore (SYNC_V2 §13.10.3) and the
// Elysia hook wiring server.ts relies on. Pure — no database / Redis /
// network (app.handle() runs in-process). Run: `bun test tests/upload-gate.test.ts`.
import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import {
  admit_upload,
  large_uploads_in_flight,
  LARGE_UPLOAD_BYTES,
  MAX_LARGE_UPLOADS,
  release_upload,
  RETRY_AFTER_S,
} from "@/utils/upload-gate";

const req = (len: number | null) =>
  new Request("http://localhost/api/media/upload", {
    method: "POST",
    headers: len === null ? {} : { "content-length": String(len) },
  });

describe("admit_upload", () => {
  test("small and length-less requests are never gated", () => {
    for (let i = 0; i < 10; i++) {
      expect(admit_upload(req(LARGE_UPLOAD_BYTES))).toBeUndefined();
      expect(admit_upload(req(null))).toBeUndefined();
    }
    expect(large_uploads_in_flight()).toBe(0);
  });

  test("the (MAX+1)th large upload gets 503 + Retry-After until one is released", async () => {
    const held = Array.from({ length: MAX_LARGE_UPLOADS }, () => req(LARGE_UPLOAD_BYTES + 1));
    for (const r of held) expect(admit_upload(r)).toBeUndefined();
    expect(large_uploads_in_flight()).toBe(MAX_LARGE_UPLOADS);

    const refused = admit_upload(req(LARGE_UPLOAD_BYTES + 1));
    expect(refused?.status).toBe(503);
    expect(refused?.headers.get("retry-after")).toBe(String(RETRY_AFTER_S));
    expect((await refused!.json()).success).toBe(false);

    release_upload(held[0]);
    release_upload(held[0]); // idempotent
    const next = req(LARGE_UPLOAD_BYTES + 1);
    expect(admit_upload(next)).toBeUndefined();

    for (const r of [...held, next]) release_upload(r);
    expect(large_uploads_in_flight()).toBe(0);
  });
});

describe("Elysia hook wiring (as in server.ts)", () => {
  // Mirrors server.ts: root app with onRequest(admit) + onAfterResponse
  // (release), routes coming from a prefixed plugin with a guard and a
  // t.File body — the shape of media.routes.ts.
  const build = (gate: Promise<void>) => {
    const media = new Elysia({ prefix: "/media" })
      .guard({ beforeHandle() { } })
      .post(
        "/upload",
        async () => {
          await gate;
          return { ok: true };
        },
        { body: t.Object({ file: t.File({ maxSize: 1024 }) }) },
      );
    return new Elysia({ prefix: "/api" })
      .onRequest(({ request }) => {
        const busy = admit_upload(request);
        if (busy) return busy;
      })
      .onAfterResponse(({ request }) => {
        release_upload(request);
      })
      .use(media);
  };

  const big_upload = (bytes = 16) => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)]), "a.bin");
    const body = new Response(fd);
    const headers = new Headers(body.headers);
    // Pretend the declared body is large; the gate only reads the header.
    headers.set("content-length", String(LARGE_UPLOAD_BYTES + 1));
    return body.arrayBuffer().then(
      (buf) =>
        new Request("http://localhost/api/media/upload", { method: "POST", headers, body: buf }),
    );
  };

  test("permits are released after success, validation errors and refusals", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const app = build(gate);

    const first = await big_upload();
    if (first.headers.get("content-length") !== String(LARGE_UPLOAD_BYTES + 1)) {
      // The runtime recomputed Content-Length from the body; the wiring
      // cannot be exercised this way here (the unit tests above still hold).
      console.warn("content-length overridden by runtime; skipping wiring test");
      open();
      return;
    }

    const in_flight = [app.handle(first)];
    for (let i = 1; i < MAX_LARGE_UPLOADS; i++) in_flight.push(app.handle(await big_upload()));
    await Bun.sleep(10);
    expect(large_uploads_in_flight()).toBe(MAX_LARGE_UPLOADS);

    const refused = await app.handle(await big_upload());
    expect(refused.status).toBe(503);

    open();
    const done = await Promise.all(in_flight);
    for (const r of done) expect(r.status).toBe(200);
    await Bun.sleep(10);
    expect(large_uploads_in_flight()).toBe(0);

    // Validation failure (file over the route's maxSize) still releases.
    const invalid = await app.handle(await big_upload(4096));
    expect(invalid.status).toBe(422);
    await Bun.sleep(10);
    expect(large_uploads_in_flight()).toBe(0);
  });
});
