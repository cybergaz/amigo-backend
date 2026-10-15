// =============================================================================
// Chunked resumable uploads — /api/media/upload/* (SYNC_V2_PROTOCOL.md §14.11)
// =============================================================================
//   POST   /media/upload/init           {mime, size, kind?, name?, chunk_size?, sha256?}
//   PUT    /media/upload/:id?offset=N   raw chunk bytes (exactly chunk_size, or the remainder)
//   HEAD   /media/upload/:id            Upload-Offset / -Length / -Chunk-Size / -State / -Expires
//   GET    /media/upload/:id/status     the same as JSON (+ url once complete)
//   POST   /media/upload/:id/complete   optional poster: raw image/jpeg body ≤ 128 KiB
//   DELETE /media/upload/:id            abort
// Authenticated like every app route. 404 {reason:'chunked_upload_off'}
// unless app_settings.sync_v2_chunked_upload is on AND the 20261024 table
// marker is set — what an old backend answers, so the app keeps the
// single-request route (media.routes.ts, unchanged for old builds).
//
// Bodies are read by hand (parse: 'none') with hard caps, so nothing is
// buffered beyond the chunk / poster / 4 KiB init limits and every request
// stays far below Cloudflare's 100 MB body limit.
//
// A factory: server.ts wires the real service / flag / auth; tests pass an
// in-memory ledger + fake S3 and never import the db / redis clients.
// =============================================================================
import { Elysia } from "elysia";
import type { ChunkedUpload, UResult } from "@/services/chunked-upload-core";
import { MAX_INIT_BODY_BYTES, MAX_POSTER_BYTES } from "@/services/chunked-upload-core";
import { deny_request, request_auth } from "@/middleware/request-auth";

type AuthResult = { code: number; data?: { id: string; role: string } | null } & Record<string, unknown>;

export type MediaUploadRouteDeps = {
  service: Pick<ChunkedUpload, "init" | "status" | "put_chunk" | "complete" | "abort">;
  enabled: () => boolean;
  auth: (ctx: { cookie: any; headers: Record<string, string | undefined> }) => AuthResult;
};

/** The body as bytes, or null past `max` (Content-Length first, then counted while streaming). */
export const read_capped_bytes = async (req: Request, max: number): Promise<Uint8Array | null> => {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => { });
      return null;
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

const declared_length = (req: Request): number | null => {
  const raw = req.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const apply = (set: { status?: number | string; headers: Record<string, string | number> }, r: UResult) => {
  set.status = r.status;
  if (r.headers) for (const [k, v] of Object.entries(r.headers)) set.headers[k] = v;
  return r.body;
};

const decode_base64 = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    return new Uint8Array(Buffer.from(s, "base64"));
  } catch {
    return null;
  }
};

export const build_media_upload_routes = (deps: MediaUploadRouteDeps) =>
  new Elysia({ prefix: "/media/upload" })
    // The authenticated user, per request (middleware/request-auth.ts). NOT
    // Elysia's `store`: that is one object shared by every request of the app,
    // and these handlers await the body (parse: 'none') before using the id.
    .resolve(({ cookie, set, headers }) => {
      const r = request_auth(set, deps.auth({ cookie, headers }));
      if (!("auth" in r)) return r;

      if (!deps.enabled()) {
        return deny_request(set, { success: false, code: 404, message: "Not found", reason: "chunked_upload_off" });
      }
      return r;
    })

    .post("/init", async ({ request, auth, set }) => {
      const raw = await read_capped_bytes(request, MAX_INIT_BODY_BYTES);
      if (raw === null) {
        set.status = 413;
        return { success: false, code: 413, message: "Body too large", reason: "body_too_large" };
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        set.status = 400;
        return { success: false, code: 400, message: "Body must be JSON", reason: "bad_body" };
      }
      return apply(set, await deps.service.init(auth.id, body));
    }, { parse: "none" })

    .put("/:id", async ({ request, auth, set, params, query }) => {
      const r = await deps.service.put_chunk(
        auth.id,
        params.id,
        typeof query.offset === "string" ? query.offset : null,
        declared_length(request),
        (max) => read_capped_bytes(request, max),
      );
      return apply(set, r);
    }, { parse: "none" })

    // HEAD carries no body: the state is in the Upload-* headers.
    // There is deliberately NO `GET /:id`: Elysia 1.4.4 answers HEAD on a
    // dynamic path with the GET handler of that path when one exists, and
    // calls it synchronously — an async GET there turns every HEAD into a
    // 500. The JSON twin lives at /:id/status instead.
    .head("/:id", async ({ auth, params }) => {
      const r = await deps.service.status(auth.id, params.id);
      return new Response(null, { status: r.status, headers: r.headers ?? { "cache-control": "no-store" } });
    })

    .get("/:id/status", async ({ auth, set, params }) => apply(set, await deps.service.status(auth.id, params.id)))

    .post("/:id/complete", async ({ request, auth, set, params }) => {
      // Poster: a raw image/jpeg body (preferred), or JSON {"poster": "<base64>"};
      // an empty body or `{}` means no poster.
      const ctype = (request.headers.get("content-type") ?? "").toLowerCase();
      const cap = ctype.includes("json") ? Math.ceil(MAX_POSTER_BYTES * 4 / 3) + 1024 : MAX_POSTER_BYTES;
      const raw = await read_capped_bytes(request, cap);
      if (raw === null) {
        set.status = 413;
        return { success: false, code: 413, message: `Poster must be at most ${MAX_POSTER_BYTES} bytes`, reason: "poster_too_large", max: MAX_POSTER_BYTES };
      }
      let poster: Uint8Array | null = null;
      if (raw.byteLength > 0) {
        if (ctype.includes("json")) {
          let j: unknown;
          try {
            j = JSON.parse(new TextDecoder().decode(raw));
          } catch {
            set.status = 400;
            return { success: false, code: 400, message: "Body must be JSON", reason: "bad_body" };
          }
          const p = j && typeof j === "object" ? (j as { poster?: unknown }).poster : undefined;
          if (typeof p === "string" && p.length > 0) {
            poster = decode_base64(p);
            if (!poster) {
              set.status = 400;
              return { success: false, code: 400, message: "poster must be base64", reason: "bad_poster" };
            }
          }
        } else {
          poster = raw;
        }
      }
      return apply(set, await deps.service.complete(auth.id, params.id, poster));
    }, { parse: "none" })

    .delete("/:id", async ({ auth, set, params }) => apply(set, await deps.service.abort(auth.id, params.id)));
