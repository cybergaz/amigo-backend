import { count } from "@/utils/counters";

// =============================================================================
// Large-upload semaphore (SYNC_V2 §13.10.3 "Media uploads")
// =============================================================================
// The legacy upload routes buffer the whole multipart body in this process
// (Bun's formData), then copy it again for the S3 PutObject (s3.service.ts
// file.arrayBuffer()). A handful of near-cap uploads (95 MiB each, see
// config/upload-limits.ts) at once can push the worker past its cgroup
// MemoryMax, and an OOM kill drops all ~2.6k sockets
// — far worse than asking one uploader to retry. So, per worker: at most
// MAX_LARGE_UPLOADS requests whose body is larger than LARGE_UPLOAD_BYTES may
// be in flight; the next one gets 503 + Retry-After before its body is read.
// Small uploads (every image, voice note, most videos) are never gated.
//
// The gate keys on Content-Length, which the app's Dio multipart upload and
// nginx (request buffering) always send. A request without it is not gated
// here (the route's own size limits still apply).
//
// App behaviour on 503 (checked in amigo-app MediaUploadManager): any non-2xx
// upload result is a TRANSIENT failure — the message stays pending (clock)
// and is retried with backoff — so old builds handle this without change.
//
// Removed once chunked uploads (§14.11) replace in-process buffering.

const LARGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_LARGE_UPLOADS = 3;
const RETRY_AFTER_S = 10;
// A permit whose release was missed (an aborted request whose response hook
// never ran) is reclaimed after this long, so a leak can only shrink
// capacity for a while, never wedge large uploads for good. Longer than any
// legitimate large upload (nginx has already received the body; this is the
// localhost read + S3 put).
const MAX_HOLD_MS = 10 * 60 * 1000;

const held = new Map<Request, number>(); // request → acquired_at (ms)

const reclaim_stale = (now: number) => {
  for (const [req, at] of held) {
    if (now - at > MAX_HOLD_MS) {
      held.delete(req);
      count("UPLOAD", "permit_reclaimed");
    }
  }
};

const declared_length = (request: Request): number | null => {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Call before the body is read. Returns a 503 Response to send instead of
 * handling the request, or undefined to proceed (a permit is held for large
 * bodies until release_upload(request)).
 */
const admit_upload = (request: Request): Response | undefined => {
  const len = declared_length(request);
  if (len === null || len <= LARGE_UPLOAD_BYTES) return undefined;
  if (held.has(request)) return undefined;
  const now = Date.now();
  if (held.size >= MAX_LARGE_UPLOADS) reclaim_stale(now);
  if (held.size >= MAX_LARGE_UPLOADS) {
    count("UPLOAD", "large_rejected_503");
    return new Response(
      JSON.stringify({
        success: false,
        code: 503,
        message: "Server is busy with other uploads, please retry shortly",
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": String(RETRY_AFTER_S),
          "cache-control": "no-store",
        },
      },
    );
  }
  held.set(request, now);
  count("UPLOAD", "large_admitted");
  return undefined;
};

/** Idempotent; safe to call for requests that never held a permit. */
const release_upload = (request: Request): void => {
  held.delete(request);
};

const large_uploads_in_flight = () => held.size;

export {
  admit_upload,
  release_upload,
  large_uploads_in_flight,
  LARGE_UPLOAD_BYTES,
  MAX_LARGE_UPLOADS,
  RETRY_AFTER_S,
};
