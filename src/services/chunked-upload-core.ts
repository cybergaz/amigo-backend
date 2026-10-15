// =============================================================================
// Chunked resumable uploads: rules + engine (SYNC_V2_PROTOCOL.md §14.11)
// =============================================================================
// WHY: S3's 5 MiB minimum part size cannot finish on a 64 kbps uplink that
// drops every 2 minutes, and the single-request route buffers up to 95 MiB
// per request in the worker (and is capped below Cloudflare's 100 MB body
// limit). So the app sends small chunks (64 KiB–1 MiB) to us and WE assemble
// S3 parts:
//
//   PUT chunk ─► staging object staging/{id}/{offset}-{nonce} (private)
//             ─► UPDATE media_uploads … WHERE received_bytes = $offset
//                (the row lock is the serialisation point: of two racing
//                retries of the same chunk exactly one advances the offset,
//                the other gets 409 {offset} and deletes its staging copy)
//             ─► once ≥ 5 MiB is staged: under run_pg_singleton('upload:'+id)
//                read those staging objects (in-region, ≤ ~6 MiB in memory),
//                UploadPart, append {n, etag, size}, then delete them
//   complete  ─► the rest becomes the last (small) part, CompleteMultipartUpload
//
// Cluster-safe: every bit of state is in PG (UploadLedger) and S3
// (UploadStore), so any worker serves any request. Memory is bounded per
// process: chunk bodies ≤ 1 MiB each under `chunk_sem`, assembly ≤ ~6 MiB
// each under `assembly_sem`. Nothing here imports the db / redis / AWS
// clients: the wiring (chunked-upload.service.ts) injects them, the tests
// inject an in-memory ledger + fake S3, and the PGlite harness the real SQL
// (chunked-upload-pg.ts) + fake S3.
// =============================================================================
import { count, observe_ms } from "@/utils/counters";
import {
  get_file_category,
  get_file_size_limit,
  is_valid_file_type,
  S3_FOLDERS,
  type S3Folder,
} from "@/services/s3.service";
import { MAX_UPLOAD_FILE_BYTES } from "@/config/upload-limits";

const KiB = 1024;
const MiB = 1024 * KiB;

// S3: every part but the last must be ≥ 5 MiB.
export const PART_MIN_BYTES = 5 * MiB;
// Powers of two only: each divides 5 MiB, so parts are exactly 5 MiB on a
// steady upload, and every non-final chunk boundary is a multiple of the
// chunk size (a resume offset is always one). §14.11 picks 256 KB / 512 KB /
// 1 MB by uplink; 64/128 KiB leave room for worse links.
export const ALLOWED_CHUNK_SIZES: readonly number[] = [64 * KiB, 128 * KiB, 256 * KiB, 512 * KiB, 1 * MiB];
export const DEFAULT_CHUNK_SIZE = 512 * KiB;
export const MAX_CHUNK_BYTES = 1 * MiB;
// Staged-but-not-assembled ceiling per upload. Assembly normally keeps this
// under 6 MiB; past 16 MiB (assembly failing / starved) a chunk is refused
// with 503 instead of letting staging grow without bound.
export const MAX_PENDING_BYTES = 16 * MiB;
// Open uploads per user. The app runs ≤ 2 at once (M0); the slack covers
// queued sends. At the cap the user's oldest upload idle for EVICT_IDLE_S is
// aborted to make room — an app that lost its local state (reinstall,
// cleared data) must not be locked out until the idle expiry.
export const MAX_OPEN_UPLOADS_PER_USER = 8;
export const EVICT_IDLE_S = 15 * 60;
// Sliding idle expiry (each accepted chunk extends it) under an absolute cap.
// The cap must stay below the S3 lifecycle expiry of staging/ (2 days): a
// live upload must never lose a staged chunk to the lifecycle rule.
export const IDLE_TTL_S = 24 * 3600;
export const HARD_TTL_S = 36 * 3600;
// complete / aborted rows are kept this long so a retried complete (lost
// response) still gets its URL, then the daily GC deletes them.
export const TERMINAL_RETENTION_S = 7 * 86400;
// Video poster (§14.7 item 5: 320 px q60 JPEG, typically 10–30 KB).
export const MAX_POSTER_BYTES = 128 * KiB;
export const MAX_INIT_BODY_BYTES = 4 * KiB;
export const STAGING_PREFIX = "staging/";

const GC_BATCH = 50;
const GC_MAX_BATCHES = 40;
const PURGE_BATCH = 1000;
const PURGE_MAX_BATCHES = 20;
// §14.11 "one chunk in flight; two on good": the second chunk of a pipelined
// pair usually reaches the server while the first is still between its S3
// PUT and its row write. Its body has already crossed the client's link
// (nginx buffers request bodies), so a 409 there wastes it. A PUT exactly one
// chunk ahead waits this long for the earlier chunk to commit instead (body
// not read, no permit held, one row read per poll).
const PIPELINE_WAIT_MS = 2_000;
const PIPELINE_POLL_MS = 100;
// One assemble() call never builds more than this many parts; the next chunk
// or complete continues.
const MAX_PARTS_PER_CALL = 24;

export type UploadState = "open" | "complete" | "aborted";
export type PartRef = { n: number; etag: string; size: number };
export type StagedChunk = { o: number; l: number; s: string };

export type UploadRow = {
  id: string;
  user_id: string;
  key: string;
  mime: string;
  category: string;
  file_name: string | null;
  size: number;
  chunk_size: number;
  sha256: string | null;
  s3_upload_id: string;
  received_bytes: number;
  assembled_bytes: number;
  parts: PartRef[];
  chunks: StagedChunk[];
  state: UploadState;
  url: string | null;
  thumb_key: string | null;
  created_ms: number;
  updated_ms: number;
  expires_ms: number;
  // the database clock at read time (expiry is judged on it, not ours)
  now_ms: number;
};

export type NewUpload = Pick<
  UploadRow,
  "id" | "user_id" | "key" | "mime" | "category" | "file_name" | "size" | "chunk_size" | "sha256" | "s3_upload_id"
>;

export type InsertResult = { ok: true; evicted: UploadRow | null } | { ok: false };

/** Durable upload state (PG in production: chunked-upload-pg.ts). */
export interface UploadLedger {
  /**
   * Insert under the per-user cap; at the cap, evicts the oldest idle open
   * upload (unless its per-upload lock is held: it may be mid-complete) or refuses.
   */
  insert(row: NewUpload, opts: { max_open: number; evict_idle_s: number; idle_s: number; hard_s: number }): Promise<InsertResult>;
  /** Unlocked pre-check: false = at the cap with nothing evictable. insert() stays authoritative. */
  has_room(user_id: string, opts: { max_open: number; evict_idle_s: number }): Promise<boolean>;
  get(id: string): Promise<UploadRow | null>;
  /** updated_at = now() on an open upload (a complete attempt is activity: never the eviction victim). */
  touch(id: string): Promise<void>;
  /** CAS: advance received_bytes from `offset` by `len`, appending the staged chunk. null = lost / not open / expired. */
  advance(a: {
    id: string; user_id: string; offset: number; len: number; nonce: string; idle_s: number; hard_s: number;
  }): Promise<{ received_bytes: number; assembled_bytes: number } | null>;
  /** Run `fn` holding the cluster-wide per-upload lock; undefined (fn not run) when another worker holds it. */
  with_lock<T>(id: string, fn: (l: LockedLedger) => Promise<T>): Promise<T | undefined>;
  list_expired(limit: number): Promise<UploadRow[]>;
  purge_terminal(older_than_s: number, limit: number): Promise<number>;
}

/** What may be done while holding the per-upload lock. */
export interface LockedLedger {
  get(id: string): Promise<UploadRow | null>;
  /** CAS on assembled_bytes + part count; drops the assembled chunks from `chunks`. */
  record_part(a: { id: string; old_assembled: number; n_before: number; part: PartRef; new_assembled: number }): Promise<boolean>;
  mark_complete(a: { id: string; url: string; thumb_key: string | null }): Promise<boolean>;
  /**
   * open → aborted (CAS). Returns the row as it was, or null when it was not
   * open / not this user's (user_id null = the GC). Under the lock because a
   * complete holds it from CompleteMultipartUpload to its row write: an
   * abort landing in between would leave a finished object nothing points at.
   */
  mark_aborted(id: string, user_id: string | null): Promise<UploadRow | null>;
}

/** The S3 operations the engine needs (s3.service.ts s3_upload_store in production). */
export interface UploadStore {
  create_multipart(key: string, mime: string): Promise<string>;
  /** Private object (staging chunks). */
  put_staging(key: string, body: Uint8Array): Promise<void>;
  /** Public, immutable object (posters). */
  put_public(key: string, body: Uint8Array, mime: string): Promise<void>;
  get_bytes(key: string): Promise<Uint8Array>;
  upload_part(key: string, upload_id: string, n: number, body: Uint8Array): Promise<string>;
  complete_multipart(key: string, upload_id: string, parts: { n: number; etag: string }[]): Promise<void>;
  /** Must not throw when the upload is already gone. */
  abort_multipart(key: string, upload_id: string): Promise<void>;
  delete_keys(keys: string[]): Promise<void>;
  /** Object size, or null when absent. */
  head_size(key: string): Promise<number | null>;
  public_url(key: string): string;
}

// ── Small counting semaphore (process-wide memory bound) ────────────────────

export class Semaphore {
  private used = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];
  constructor(readonly max: number) { }

  /** A release function, or null when no permit came within `timeout_ms`. */
  acquire(timeout_ms: number): Promise<(() => void) | null> {
    if (this.used < this.max) {
      this.used++;
      return Promise.resolve(this.releaser());
    }
    if (timeout_ms <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = {
        grant: () => {
          clearTimeout(timer);
          resolve(this.releaser());
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeout_ms);
      this.waiters.push(w);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      // hand the permit straight to the next waiter (used stays the same)
      if (next) next.grant();
      else this.used--;
    };
  }

  get in_use() { return this.used; }
  get waiting() { return this.waiters.length; }
}

// ── Pure rules ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const is_upload_id = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
// PG's uuid::text is lowercase, and S3 keys and advisory-lock names are
// case-sensitive: every staging key / lock name must use this one spelling,
// whatever case the client sent.
const canon_id = (id: string): string => (typeof id === "string" ? id.toLowerCase() : id);

export const staging_key = (id: string, c: { o: number; s: string }) => `${STAGING_PREFIX}${id}/${c.o}-${c.s}`;
export const poster_key = (key: string) => `${key}.poster.jpg`;

// `kind` is optional (the mime decides the folder, as on the generic
// /media/upload route); when given it must agree with the mime.
const KIND_TO_FOLDER: Record<string, S3Folder> = {
  image: S3_FOLDERS.IMAGES, images: S3_FOLDERS.IMAGES, photo: S3_FOLDERS.IMAGES,
  video: S3_FOLDERS.VIDEOS, videos: S3_FOLDERS.VIDEOS,
  audio: S3_FOLDERS.AUDIOS, audios: S3_FOLDERS.AUDIOS, voice: S3_FOLDERS.AUDIOS,
  doc: S3_FOLDERS.DOCS, docs: S3_FOLDERS.DOCS, document: S3_FOLDERS.DOCS, documents: S3_FOLDERS.DOCS, file: S3_FOLDERS.DOCS,
};

export type InitInput = {
  mime: string; category: S3Folder; size: number; chunk_size: number; sha256: string | null; name: string;
};

export type InitCheck =
  | { ok: true; v: InitInput }
  | { ok: false; status: number; reason: string; message: string; extra?: Record<string, unknown> };

const bad = (reason: string, message: string, status = 400, extra?: Record<string, unknown>): InitCheck =>
  ({ ok: false, status, reason, message, extra });

/** Validate POST /init against today's single-upload limits (s3.service.ts). */
export const validate_init = (body: unknown): InitCheck => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("bad_body", "Body must be a JSON object");
  const b = body as Record<string, unknown>;
  const mime = typeof b.mime === "string" ? b.mime.trim().toLowerCase() : "";
  if (!mime || !is_valid_file_type(mime)) return bad("bad_mime", `Unsupported file type: ${String(b.mime ?? "")}`.slice(0, 200));
  const category = get_file_category(mime)!;
  if (b.kind !== undefined && b.kind !== null) {
    const k = typeof b.kind === "string" ? KIND_TO_FOLDER[b.kind.trim().toLowerCase()] : undefined;
    if (!k) return bad("bad_kind", "kind must be image | video | audio | document");
    if (k !== category) return bad("kind_mismatch", `kind does not match the mime type (${category})`);
  }
  const size = b.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
    return bad("bad_size", "size must be a positive integer (bytes)");
  }
  // The 95 MiB cap applies to the total too (config/upload-limits.ts): the
  // chunked route removes the per-REQUEST limit, not the per-file one.
  const max = Math.min(get_file_size_limit(mime), MAX_UPLOAD_FILE_BYTES);
  if (size > max) {
    return bad("too_large", `File size too large. Maximum size is ${Math.round(max / MiB)}MB for ${category}.`, 413, { max });
  }
  let chunk_size = DEFAULT_CHUNK_SIZE;
  if (b.chunk_size !== undefined && b.chunk_size !== null) {
    if (typeof b.chunk_size !== "number" || !ALLOWED_CHUNK_SIZES.includes(b.chunk_size)) {
      return bad("bad_chunk_size", `chunk_size must be one of ${ALLOWED_CHUNK_SIZES.join(", ")}`, 400, { allowed: ALLOWED_CHUNK_SIZES });
    }
    chunk_size = b.chunk_size;
  }
  let sha256: string | null = null;
  if (b.sha256 !== undefined && b.sha256 !== null) {
    if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(b.sha256)) return bad("bad_sha256", "sha256 must be 64 hex characters");
    sha256 = b.sha256.toLowerCase();
  }
  let name = "";
  if (b.name !== undefined && b.name !== null) {
    if (typeof b.name !== "string" || b.name.length > 255) return bad("bad_name", "name must be a string of at most 255 characters");
    name = b.name.trim();
  }
  if (!name) name = `upload.${(mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]/g, "") || "bin"}`;
  return { ok: true, v: { mime, category, size, chunk_size, sha256, name } };
};

/**
 * Final object key. Same shape as the single-upload route
 * (`{folder}/{user}/{ms}_{name}`: media.routes DELETE checks `/{user}/`),
 * plus 8 hex of the upload id so two uploads of the same name in the same
 * millisecond never share a key (keys are immutable: Cache-Control
 * immutable, §14.7 item 8).
 */
export const object_key = (category: string, user_id: string, upload_id: string, name: string, now_ms: number) =>
  `${category}/${user_id}/${now_ms}_${upload_id.replace(/-/g, "").slice(-8)}_${name.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 120)}`;

/** Bytes the chunk at `offset` must carry: chunk_size, or the remainder for the last one. */
export const expected_chunk_len = (row: Pick<UploadRow, "size" | "chunk_size">, offset: number) =>
  Math.max(0, Math.min(row.chunk_size, row.size - offset));

/**
 * The next part to assemble from the staged chunks: a contiguous run from
 * `assembled` reaching ≥ 5 MiB (≤ 5 MiB + one chunk), or — `final` — the
 * remainder as the last part. null = nothing to do yet. Throws when the
 * staged chunks are not contiguous from `assembled` (cannot happen through
 * the CAS writes; refusing beats uploading a corrupt object).
 */
export const plan_part = (
  chunks: StagedChunk[], assembled: number, final: boolean,
): { take: StagedChunk[]; size: number } | null => {
  const sorted = [...chunks].sort((a, b) => a.o - b.o);
  const take: StagedChunk[] = [];
  let at = assembled;
  for (const c of sorted) {
    if (c.o < at) continue; // already assembled (a stale entry can only be behind)
    if (c.o !== at) throw new Error(`staged chunks not contiguous at ${at} (next ${c.o})`);
    take.push(c);
    at += c.l;
    if (at - assembled >= PART_MIN_BYTES) return { take, size: at - assembled };
  }
  if (final && take.length > 0) return { take, size: at - assembled };
  return null;
};

const is_jpeg = (b: Uint8Array) => b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// ── Engine ──────────────────────────────────────────────────────────────────

export type UResult = {
  status: number;
  body: Record<string, unknown> | null;
  headers?: Record<string, string>;
};

const ok = (data: Record<string, unknown>, message = "OK", headers?: Record<string, string>): UResult =>
  ({ status: 200, body: { success: true, code: 200, message, data }, headers });

const fail = (
  status: number, reason: string, message: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>,
): UResult => ({ status, body: { success: false, code: status, message, reason, ...extra }, headers });

const retry = (reason: string, message: string, after_s: number): UResult =>
  fail(503, reason, message, {}, { "retry-after": String(after_s) });

export type ChunkedUploadDeps = {
  ledger: UploadLedger;
  store: UploadStore;
  /** chunk bodies in memory at once (each ≤ 1 MiB) */
  chunk_sem?: Semaphore;
  /**
   * parts being assembled at once (each ≤ ~6 MiB), and completes in their S3
   * step: every holder keeps a PG pool connection (the per-upload lock's
   * transaction) across S3 calls, so this also bounds those connections
   */
  assembly_sem?: Semaphore;
  /** how long complete keeps retrying a per-upload lock held by another worker */
  lock_wait_ms?: number;
  sleep?: (ms: number) => Promise<void>;
  nonce?: () => string;
  uuid?: () => string;
  now?: () => number;
  should_stop?: () => boolean;
};

export type ChunkedUpload = ReturnType<typeof make_chunked_upload>;

export const make_chunked_upload = (deps: ChunkedUploadDeps) => {
  const { ledger, store } = deps;
  const chunk_sem = deps.chunk_sem ?? new Semaphore(32);
  const assembly_sem = deps.assembly_sem ?? new Semaphore(2);
  const lock_wait_ms = deps.lock_wait_ms ?? 10_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nonce = deps.nonce ?? (() => crypto.getRandomValues(new Uint8Array(6)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""));
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const should_stop = deps.should_stop ?? (() => false);

  const expired = (r: UploadRow) => r.state === "open" && r.expires_ms <= r.now_ms;

  const state_headers = (r: UploadRow): Record<string, string> => ({
    "upload-offset": String(r.state === "complete" ? r.size : r.received_bytes),
    "upload-length": String(r.size),
    "upload-chunk-size": String(r.chunk_size),
    "upload-state": expired(r) ? "expired" : r.state,
    "upload-expires": new Date(r.expires_ms).toISOString(),
    "cache-control": "no-store",
  });

  const done_data = (r: UploadRow) => ({
    upload_id: r.id,
    url: r.url ?? store.public_url(r.key),
    key: r.key,
    category: r.category,
    file_name: r.file_name,
    file_size: r.size,
    mime_type: r.mime,
    ...(r.thumb_key ? { thumb_url: store.public_url(r.thumb_key) } : {}),
  });

  // Own row or nothing: another user's upload id answers exactly like an
  // unknown one, so ids cannot be probed.
  const load_own = async (user_id: string, id: string): Promise<UploadRow | UResult> => {
    if (!is_upload_id(id)) return fail(404, "not_found", "Upload not found");
    const row = await ledger.get(id);
    if (!row || row.user_id !== user_id) return fail(404, "not_found", "Upload not found");
    return row;
  };

  const gone = (r: UploadRow): UResult | null => {
    if (r.state === "aborted") return fail(410, "aborted", "Upload was aborted; start a new one", {}, state_headers(r));
    if (expired(r)) return fail(410, "expired", "Upload expired; start a new one", {}, state_headers(r));
    return null;
  };

  // Best effort: the S3 lifecycle rules (deploy/s3-lifecycle.json) are the
  // backstop for staging/ and multipart leftovers. They do NOT cover the
  // final key or its poster, so those are deleted here too: an aborted row
  // never owns a finished object (keys are unique per upload), but one can
  // exist when a CompleteMultipartUpload succeeded and its answer was lost
  // (complete answered 503, then the upload was aborted / evicted / expired).
  // Deleting absent keys is a no-op.
  const cleanup = async (r: UploadRow) => {
    try {
      await store.abort_multipart(r.key, r.s3_upload_id);
    } catch (err: any) {
      count("UPLOAD", "cleanup_failed");
      console.error(`[UPLOAD] abort_multipart failed ${r.id}: ${err?.message ?? err}`);
    }
    try {
      await store.delete_keys([...r.chunks.map((c) => staging_key(r.id, c)), r.key, poster_key(r.key)]);
    } catch (err: any) {
      count("UPLOAD", "cleanup_failed");
      console.error(`[UPLOAD] cleanup delete failed ${r.id}: ${err?.message ?? err}`);
    }
  };

  // An S3 object made for an init that did not get a row. Counted, because a
  // failed fire-and-forget abort leaves it to the 7-day lifecycle rule.
  const drop_multipart = (key: string, upload_id: string) => {
    void store.abort_multipart(key, upload_id).catch(() => count("UPLOAD", "init_abort_failed"));
  };

  type OneResult =
    | { kind: "none" }
    | { kind: "gone" }
    | { kind: "part"; staged: string[]; size: number };

  // One part, inside the per-upload lock (one transaction). The S3 reads and
  // UploadPart happen BEFORE the only row write, so the row lock that write
  // takes is held just for the commit and never blocks chunk PUTs on S3.
  const assemble_one = async (l: LockedLedger, id: string, final: boolean): Promise<OneResult> => {
    const row = await l.get(id);
    if (!row || row.state !== "open") return { kind: "gone" };
    const plan = plan_part(row.chunks, row.assembled_bytes, final);
    if (!plan) return { kind: "none" };
    const t0 = performance.now();
    const buf = new Uint8Array(plan.size);
    let at = 0;
    for (const c of plan.take) {
      const b = await store.get_bytes(staging_key(id, c));
      if (b.byteLength !== c.l) throw new Error(`staging object ${c.o} has ${b.byteLength} bytes, expected ${c.l}`);
      buf.set(b, at);
      at += c.l;
    }
    const n = row.parts.length + 1;
    // Re-running a part number after a rolled-back transaction just replaces
    // that part in S3 with the same bytes.
    const etag = await store.upload_part(row.key, row.s3_upload_id, n, buf);
    const recorded = await l.record_part({
      id,
      old_assembled: row.assembled_bytes,
      n_before: row.parts.length,
      part: { n, etag, size: plan.size },
      new_assembled: row.assembled_bytes + plan.size,
    });
    if (!recorded) return { kind: "gone" };
    count("UPLOAD", "part_assembled");
    count("UPLOAD", "part_bytes", plan.size);
    observe_ms("UPLOAD", "part_ms", performance.now() - t0);
    return { kind: "part", staged: plan.take.map((c) => staging_key(id, c)), size: plan.size };
  };

  type AssembleOutcome = "done" | "busy" | "gone";

  /**
   * Assemble every ready part (final: everything left). "busy" = another
   * worker holds the lock or no assembly permit came in time; the next chunk
   * or complete picks the work up. Throws on S3 / DB errors.
   */
  const assemble = async (id: string, final: boolean): Promise<AssembleOutcome> => {
    for (let i = 0; i < MAX_PARTS_PER_CALL; i++) {
      const release = await assembly_sem.acquire(final ? 30_000 : 2_000);
      if (!release) {
        count("UPLOAD", "assembly_permit_timeout");
        return "busy";
      }
      let r: OneResult | undefined;
      try {
        r = await ledger.with_lock(id, (l) => assemble_one(l, id, final));
      } finally {
        release();
      }
      if (r === undefined) {
        count("UPLOAD", "part_busy");
        return "busy";
      }
      if (r.kind === "none") return "done";
      if (r.kind === "gone") return "gone";
      // Committed: the staged copies are now in the part.
      try {
        await store.delete_keys(r.staged);
      } catch (err: any) {
        count("UPLOAD", "staging_delete_failed");
        console.error(`[UPLOAD] staging delete failed ${id}: ${err?.message ?? err}`);
      }
    }
    return "done";
  };

  // Chunk-path assembly never fails the chunk: it is durably staged and the
  // next chunk / complete retries the part.
  const assemble_quietly = async (id: string): Promise<void> => {
    try {
      await assemble(id, false);
    } catch (err: any) {
      count("UPLOAD", "part_failed");
      console.error(`[UPLOAD] part assembly failed ${id}: ${err?.message ?? err}`);
    }
  };

  const too_many = (): UResult => {
    count("UPLOAD", "init_cap");
    return fail(429, "too_many_uploads",
      `At most ${MAX_OPEN_UPLOADS_PER_USER} uploads may be open at once; finish or abort one first`,
      { max_open: MAX_OPEN_UPLOADS_PER_USER }, { "retry-after": "60" });
  };

  // ── POST /init ────────────────────────────────────────────────────────────
  const init = async (user_id: string, body: unknown): Promise<UResult> => {
    const v = validate_init(body);
    if (!v.ok) {
      count("UPLOAD", v.status === 413 ? "init_too_large" : "init_bad_request");
      return fail(v.status, v.reason, v.message, v.extra ?? {});
    }
    const { mime, category, size, chunk_size, sha256, name } = v.v;
    // The cap first, so a client looping on 429 costs one indexed read, not a
    // CreateMultipartUpload (+ an abort that may fail and leak) each time.
    try {
      if (!(await ledger.has_room(user_id, { max_open: MAX_OPEN_UPLOADS_PER_USER, evict_idle_s: EVICT_IDLE_S }))) {
        return too_many();
      }
    } catch (err: any) {
      count("UPLOAD", "init_failed");
      console.error(`[UPLOAD] init cap check failed: ${err?.message ?? err}`);
      return retry("db_failed", "Temporarily unavailable, please retry", 5);
    }
    const id = uuid();
    const key = object_key(category, user_id, id, name, now());
    let s3_upload_id: string;
    try {
      s3_upload_id = await store.create_multipart(key, mime);
    } catch (err: any) {
      count("UPLOAD", "init_failed");
      console.error(`[UPLOAD] create_multipart failed: ${err?.message ?? err}`);
      return retry("store_failed", "Storage temporarily unavailable, please retry", 5);
    }
    let ins: InsertResult;
    try {
      ins = await ledger.insert(
        { id, user_id, key, mime, category, file_name: name, size, chunk_size, sha256, s3_upload_id },
        { max_open: MAX_OPEN_UPLOADS_PER_USER, evict_idle_s: EVICT_IDLE_S, idle_s: IDLE_TTL_S, hard_s: HARD_TTL_S },
      );
    } catch (err: any) {
      count("UPLOAD", "init_failed");
      console.error(`[UPLOAD] init insert failed: ${err?.message ?? err}`);
      drop_multipart(key, s3_upload_id);
      return retry("db_failed", "Temporarily unavailable, please retry", 5);
    }
    if (!ins.ok) {
      // lost the last slot to a racing init (has_room is unlocked)
      drop_multipart(key, s3_upload_id);
      return too_many();
    }
    if (ins.evicted) {
      count("UPLOAD", "evicted");
      void cleanup(ins.evicted);
    }
    count("UPLOAD", "init");
    return ok({
      upload_id: id,
      chunk_size,
      offset: 0,
      size,
      part_size: PART_MIN_BYTES,
      expires_at: new Date(now() + IDLE_TTL_S * 1000).toISOString(),
    }, "Upload started");
  };

  // ── HEAD / GET /:id ───────────────────────────────────────────────────────
  const status = async (user_id: string, raw_id: string): Promise<UResult> => {
    const id = canon_id(raw_id);
    const row = await load_own(user_id, id);
    if (!("id" in row)) return row;
    const g = gone(row);
    if (g) return g;
    const data: Record<string, unknown> = {
      upload_id: row.id,
      offset: row.state === "complete" ? row.size : row.received_bytes,
      size: row.size,
      chunk_size: row.chunk_size,
      state: row.state,
      expires_at: new Date(row.expires_ms).toISOString(),
    };
    if (row.state === "complete") Object.assign(data, done_data(row));
    return { status: 200, body: { success: true, code: 200, message: "Upload status", offset: data.offset, data }, headers: state_headers(row) };
  };

  // Pipelining: wait for the chunk just before `offset` to commit (see
  // PIPELINE_WAIT_MS). Returns the freshest row seen.
  const await_offset = async (id: string, offset: number, row: UploadRow): Promise<UploadRow> => {
    const deadline = now() + PIPELINE_WAIT_MS;
    let cur = row;
    while (now() < deadline) {
      await sleep(PIPELINE_POLL_MS);
      const r = await ledger.get(id);
      if (!r) return cur;
      cur = r;
      if (r.state !== "open" || r.received_bytes >= offset) break;
    }
    count("UPLOAD", cur.received_bytes === offset ? "chunk_pipelined" : "chunk_pipeline_timeout");
    return cur;
  };

  // ── PUT /:id?offset=N ─────────────────────────────────────────────────────
  const put_chunk = async (
    user_id: string,
    raw_id: string,
    offset_raw: string | null | undefined,
    declared_len: number | null,
    read_body: (max: number) => Promise<Uint8Array | null>,
  ): Promise<UResult> => {
    const t = (offset_raw ?? "").trim();
    const offset = /^\d{1,15}$/.test(t) ? Number(t) : NaN;
    if (!Number.isSafeInteger(offset)) return fail(400, "bad_offset", "offset query parameter (bytes) is required");
    const id = canon_id(raw_id);
    const loaded = await load_own(user_id, id);
    if (!("id" in loaded)) return loaded;
    let row = loaded;
    if (row.state === "open" && !expired(row) && offset === row.received_bytes + row.chunk_size) {
      row = await await_offset(id, offset, row);
    }
    const g = gone(row);
    if (g) return g;
    if (row.state === "complete") {
      return fail(409, "already_complete", "Upload already complete", { offset: row.size }, state_headers(row));
    }
    if (offset !== row.received_bytes) {
      count("UPLOAD", "chunk_409");
      return fail(409, "offset_mismatch", "Resume from the returned offset", { offset: row.received_bytes }, state_headers(row));
    }
    const expected = expected_chunk_len(row, offset);
    if (expected === 0) {
      return fail(409, "all_received", "Every byte was received; call complete", { offset: row.size }, state_headers(row));
    }
    if (declared_len !== null && declared_len !== expected) {
      return declared_len > expected
        ? fail(413, "chunk_too_large", `This chunk must be exactly ${expected} bytes`, { expected })
        : fail(400, "bad_chunk_length", `This chunk must be exactly ${expected} bytes`, { expected });
    }
    // Backpressure: never let staged-but-unassembled bytes run away.
    if (row.received_bytes - row.assembled_bytes >= MAX_PENDING_BYTES) {
      await assemble_quietly(id);
      const again = await ledger.get(id);
      if (again && again.received_bytes - again.assembled_bytes >= MAX_PENDING_BYTES) {
        count("UPLOAD", "assembly_behind_503");
        return retry("assembly_behind", "Server is still processing earlier chunks, please retry", 3);
      }
    }

    const release = await chunk_sem.acquire(5_000);
    if (!release) {
      count("UPLOAD", "chunk_busy_503");
      return retry("busy", "Server is busy, please retry", 2);
    }
    let adv: { received_bytes: number; assembled_bytes: number } | null;
    try {
      const bytes = await read_body(expected);
      if (bytes === null) return fail(413, "chunk_too_large", `This chunk must be exactly ${expected} bytes`, { expected });
      if (bytes.byteLength !== expected) {
        return fail(400, "bad_chunk_length", `This chunk must be exactly ${expected} bytes`, { expected, got: bytes.byteLength });
      }
      const chunk = { o: offset, l: expected, s: nonce() };
      const skey = staging_key(id, chunk);
      try {
        await store.put_staging(skey, bytes);
      } catch (err: any) {
        count("UPLOAD", "chunk_store_failed");
        console.error(`[UPLOAD] staging put failed ${id}@${offset}: ${err?.message ?? err}`);
        return retry("store_failed", "Storage temporarily unavailable, please retry", 3);
      }
      try {
        adv = await ledger.advance({ id, user_id, offset, len: expected, nonce: chunk.s, idle_s: IDLE_TTL_S, hard_s: HARD_TTL_S });
      } catch (err: any) {
        count("UPLOAD", "chunk_db_failed");
        console.error(`[UPLOAD] advance failed ${id}@${offset}: ${err?.message ?? err}`);
        void store.delete_keys([skey]).catch(() => { });
        return retry("db_failed", "Temporarily unavailable, please retry", 3);
      }
      if (!adv) {
        // Lost the race (a retry of this chunk landed first on another
        // request / worker), or the upload stopped being open meanwhile.
        void store.delete_keys([skey]).catch(() => { });
        const now_row = await ledger.get(id);
        if (!now_row) return fail(404, "not_found", "Upload not found");
        row = now_row;
        const g2 = gone(row);
        if (g2) return g2;
        if (row.state === "complete") return fail(409, "already_complete", "Upload already complete", { offset: row.size }, state_headers(row));
        count("UPLOAD", "chunk_409");
        count("UPLOAD", "chunk_409_race");
        return fail(409, "offset_mismatch", "Resume from the returned offset", { offset: row.received_bytes }, state_headers(row));
      }
    } finally {
      release();
    }
    count("UPLOAD", "chunk");
    count("UPLOAD", "chunk_bytes", expected);
    if (adv.received_bytes - adv.assembled_bytes >= PART_MIN_BYTES) await assemble_quietly(id);
    return {
      status: 200,
      body: { success: true, code: 200, message: "Chunk stored", offset: adv.received_bytes, data: { offset: adv.received_bytes, size: row.size } },
      headers: { "upload-offset": String(adv.received_bytes), "cache-control": "no-store" },
    };
  };

  // ── POST /:id/complete ────────────────────────────────────────────────────
  const complete = async (user_id: string, raw_id: string, poster: Uint8Array | null): Promise<UResult> => {
    const t0 = performance.now();
    const id = canon_id(raw_id);
    const loaded = await load_own(user_id, id);
    if (!("id" in loaded)) return loaded;
    const row = loaded;
    if (row.state === "complete") return ok(done_data(row), "Upload complete");
    const g = gone(row);
    if (g) return g;
    if (row.received_bytes < row.size) {
      return fail(409, "incomplete", "Not every byte was received; resume from the returned offset",
        { offset: row.received_bytes }, state_headers(row));
    }
    if (poster) {
      if (poster.byteLength > MAX_POSTER_BYTES) return fail(413, "poster_too_large", `Poster must be at most ${MAX_POSTER_BYTES} bytes`, { max: MAX_POSTER_BYTES });
      if (!is_jpeg(poster)) return fail(400, "bad_poster", "Poster must be a JPEG image");
    }
    // A complete that keeps getting 503 busy is still an active upload: it
    // must not become the per-user cap's idle eviction victim.
    await ledger.touch(id).catch(() => undefined);

    const deadline = now() + lock_wait_ms;
    try {
      // 1. Every staged byte into parts (the last one may be small).
      for (; ;) {
        const out = await assemble(id, true);
        if (out === "done") break;
        if (out === "gone") {
          // aborted / expired / completed meanwhile → answer from the row;
          // still open (a CAS lost to a sibling) → just retry
          const a = await answer_from_row(user_id, id);
          if (a) return a;
        }
        if (now() >= deadline) return retry("busy", "Upload is being processed, please retry", 2);
        await sleep(200);
      }
      // 2. CompleteMultipartUpload under the same lock (a sibling's last
      //    assembly can never interleave, nor can an abort / eviction / GC:
      //    they take this lock too). The lock is a PG transaction, i.e. a
      //    pool connection held across S3 calls, so it runs under the
      //    assembly permits like assembly does: per worker, at most
      //    ASSEMBLY_PERMITS connections of the pool wait on S3 at once.
      for (; ;) {
        const release = await assembly_sem.acquire(Math.max(0, deadline - now()));
        if (!release) {
          count("UPLOAD", "complete_permit_timeout");
          return retry("busy", "Upload is being processed, please retry", 2);
        }
        let r;
        try {
          r = await ledger.with_lock(id, async (l) => {
            const cur = await l.get(id);
            if (!cur) return { kind: "gone" as const };
            // finished by a racing complete: answered, but not counted twice
            if (cur.state === "complete") return { kind: "already" as const, row: cur };
            if (cur.state !== "open") return { kind: "gone" as const };
            // A chunk can never land after received == size, so this only
            // trips if assembly was skipped; retried by the outer loop.
            if (cur.assembled_bytes !== cur.size) return { kind: "not_ready" as const };
            let thumb_key: string | null = cur.thumb_key;
            if (poster && !thumb_key) {
              thumb_key = poster_key(cur.key);
              await store.put_public(thumb_key, poster, "image/jpeg");
            }
            try {
              await store.complete_multipart(cur.key, cur.s3_upload_id, cur.parts.map((p) => ({ n: p.n, etag: p.etag })));
            } catch (err) {
              // Completed by an earlier attempt whose row write was lost
              // (S3 then answers NoSuchUpload): the object is there.
              const have = await store.head_size(cur.key).catch(() => null);
              if (have !== cur.size) throw err;
              count("UPLOAD", "complete_recovered");
            }
            const url = store.public_url(cur.key);
            if (!(await l.mark_complete({ id, url, thumb_key }))) return { kind: "gone" as const };
            return { kind: "done" as const, row: { ...cur, state: "complete" as const, url, thumb_key } };
          });
        } finally {
          release();
        }
        if (r?.kind === "already") return ok(done_data(r.row), "Upload complete");
        if (r?.kind === "done") {
          count("UPLOAD", "complete");
          count("UPLOAD", "complete_bytes", r.row.size);
          observe_ms("UPLOAD", "complete_ms", performance.now() - t0);
          return ok(done_data(r.row), "Upload complete");
        }
        if (r?.kind === "gone" || r?.kind === "not_ready") {
          const a = await answer_from_row(user_id, id);
          if (a) return a;
          if (r.kind === "not_ready") await assemble(id, true);
        }
        if (now() >= deadline) return retry("busy", "Upload is being processed, please retry", 2);
        if (r === undefined) await sleep(200);
      }
    } catch (err: any) {
      count("UPLOAD", "complete_failed");
      console.error(`[UPLOAD] complete failed ${id}: ${err?.message ?? err}`);
      return retry("store_failed", "Could not finish the upload, please retry complete", 5);
    }
  };

  // After a lost CAS: answer from the row as it is now; null = still open
  // (the caller retries).
  const answer_from_row = async (user_id: string, id: string): Promise<UResult | null> => {
    const r = await load_own(user_id, id);
    if (!("id" in r)) return r;
    if (r.state === "complete") return ok(done_data(r), "Upload complete");
    return gone(r);
  };

  // ── DELETE /:id ───────────────────────────────────────────────────────────
  const abort = async (user_id: string, raw_id: string): Promise<UResult> => {
    const id = canon_id(raw_id);
    const loaded = await load_own(user_id, id);
    if (!("id" in loaded)) return loaded;
    if (loaded.state === "complete") return fail(409, "already_complete", "Upload already complete", { offset: loaded.size });
    if (loaded.state === "aborted") return ok({ upload_id: id, state: "aborted" }, "Upload aborted");
    // Under the per-upload lock (LockedLedger.mark_aborted): an abort that
    // meets a running complete waits for it, then answers 409 already_complete.
    const deadline = now() + lock_wait_ms;
    let was: UploadRow | null | undefined;
    for (; ;) {
      was = await ledger.with_lock(id, (l) => l.mark_aborted(id, user_id));
      if (was !== undefined) break;
      if (now() >= deadline) return retry("busy", "Upload is being processed, please retry", 2);
      await sleep(200);
    }
    if (!was) {
      const now_row = await ledger.get(id);
      if (now_row?.state === "complete") return fail(409, "already_complete", "Upload already complete", { offset: now_row.size });
      return ok({ upload_id: id, state: "aborted" }, "Upload aborted");
    }
    await cleanup(was);
    count("UPLOAD", "abort");
    return ok({ upload_id: id, state: "aborted" }, "Upload aborted");
  };

  // ── Daily GC (run_daily('upload_gc')) ─────────────────────────────────────
  const gc_once = async (): Promise<number> => {
    let aborted = 0;
    for (let b = 0; b < GC_MAX_BATCHES && !should_stop(); b++) {
      const rows = await ledger.list_expired(GC_BATCH);
      for (const r of rows) {
        if (should_stop()) break;
        // locked = being assembled / completed right now: the next run retries
        const was = await ledger.with_lock(r.id, (l) => l.mark_aborted(r.id, null));
        if (!was) continue;
        await cleanup(was);
        aborted++;
      }
      if (rows.length < GC_BATCH) break;
    }
    let purged = 0;
    for (let b = 0; b < PURGE_MAX_BATCHES && !should_stop(); b++) {
      const n = await ledger.purge_terminal(TERMINAL_RETENTION_S, PURGE_BATCH);
      purged += n;
      if (n < PURGE_BATCH) break;
    }
    if (aborted) count("UPLOAD", "gc_aborted", aborted);
    if (purged) count("UPLOAD", "gc_purged", purged);
    return aborted + purged;
  };

  const stats = () => ({
    chunk_bodies_in_flight: chunk_sem.in_use,
    chunk_waiting: chunk_sem.waiting,
    assembling: assembly_sem.in_use,
    assembly_waiting: assembly_sem.waiting,
  });

  return { init, status, put_chunk, complete, abort, gc_once, assemble, stats };
};
