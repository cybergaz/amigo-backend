// In-memory stand-ins for the chunked upload engine's dependencies
// (services/chunked-upload-core.ts): a fake S3 that enforces the multipart
// rules the real one does (5 MiB minimum for every part but the last, ETag
// match, NoSuchUpload after complete / abort), and a ledger with the same
// CAS semantics as the PG SQL (services/chunked-upload-pg.ts — whose real
// statements run on the PGlite harness). No network, no database.
import {
  PART_MIN_BYTES,
  type InsertResult,
  type LockedLedger,
  type NewUpload,
  type PartRef,
  type UploadLedger,
  type UploadRow,
  type UploadStore,
} from "@/services/chunked-upload-core";

export class S3Error extends Error {
  constructor(public override name: string, message = name) { super(message); }
}

type Op = keyof UploadStore;

export class FakeS3 implements UploadStore {
  objects = new Map<string, { body: Uint8Array; public: boolean; mime?: string }>();
  uploads = new Map<string, { key: string; mime: string; parts: Map<number, { body: Uint8Array; etag: string }> }>();
  calls: Record<string, number> = {};
  max_part_bytes = 0;
  aborted: string[] = [];
  private failures = new Map<string, number>();
  private delays = new Map<string, number>();
  private seq = 0;

  /** The next `n` calls of `op` throw. */
  fail_next(op: Op, n = 1) { this.failures.set(op, n); }
  /** Every call of `op` waits `ms` first (to line up races). */
  delay(op: Op, ms: number) { this.delays.set(op, ms); }

  private async enter(op: Op) {
    this.calls[op] = (this.calls[op] ?? 0) + 1;
    const d = this.delays.get(op);
    if (d) await new Promise((r) => setTimeout(r, d));
    const f = this.failures.get(op) ?? 0;
    if (f > 0) {
      this.failures.set(op, f - 1);
      throw new S3Error("InternalError", `injected ${op} failure`);
    }
  }

  staging_keys() { return [...this.objects.keys()].filter((k) => k.startsWith("staging/")); }

  async create_multipart(key: string, mime: string) {
    await this.enter("create_multipart");
    const id = `mpu-${++this.seq}`;
    this.uploads.set(id, { key, mime, parts: new Map() });
    return id;
  }
  async put_staging(key: string, body: Uint8Array) {
    await this.enter("put_staging");
    this.objects.set(key, { body: body.slice(), public: false });
  }
  async put_public(key: string, body: Uint8Array, mime: string) {
    await this.enter("put_public");
    this.objects.set(key, { body: body.slice(), public: true, mime });
  }
  async get_bytes(key: string) {
    await this.enter("get_bytes");
    const o = this.objects.get(key);
    if (!o) throw new S3Error("NoSuchKey");
    return o.body.slice();
  }
  async upload_part(key: string, upload_id: string, n: number, body: Uint8Array) {
    await this.enter("upload_part");
    const u = this.uploads.get(upload_id);
    if (!u || u.key !== key) throw new S3Error("NoSuchUpload");
    if (n < 1 || n > 10_000) throw new S3Error("InvalidArgument");
    this.max_part_bytes = Math.max(this.max_part_bytes, body.byteLength);
    const etag = `"${Bun.hash(body).toString(16)}-${n}"`;
    u.parts.set(n, { body: body.slice(), etag });
    return etag;
  }
  async complete_multipart(key: string, upload_id: string, parts: { n: number; etag: string }[]) {
    await this.enter("complete_multipart");
    const u = this.uploads.get(upload_id);
    if (!u || u.key !== key) throw new S3Error("NoSuchUpload");
    if (parts.length === 0) throw new S3Error("MalformedXML");
    const bodies: Uint8Array[] = [];
    parts.forEach((p, i) => {
      if (i > 0 && p.n <= parts[i - 1]!.n) throw new S3Error("InvalidPartOrder");
      const have = u.parts.get(p.n);
      if (!have || have.etag !== p.etag) throw new S3Error("InvalidPart");
      if (i < parts.length - 1 && have.body.byteLength < PART_MIN_BYTES) throw new S3Error("EntityTooSmall");
      bodies.push(have.body);
    });
    const total = bodies.reduce((s, b) => s + b.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of bodies) { out.set(b, at); at += b.byteLength; }
    this.objects.set(key, { body: out, public: true, mime: u.mime });
    this.uploads.delete(upload_id);
  }
  async abort_multipart(key: string, upload_id: string) {
    await this.enter("abort_multipart");
    if (this.uploads.delete(upload_id)) this.aborted.push(upload_id);
  }
  async delete_keys(keys: string[]) {
    await this.enter("delete_keys");
    for (const k of keys) this.objects.delete(k);
  }
  async head_size(key: string) {
    await this.enter("head_size");
    return this.objects.get(key)?.body.byteLength ?? null;
  }
  public_url(key: string) { return `https://bucket.s3.test/${key}`; }
}

export class Clock {
  constructor(public t = Date.UTC(2026, 9, 24, 12, 0, 0)) { }
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

/** UploadLedger with the PG statements' semantics, in memory. */
export class MemoryLedger implements UploadLedger {
  rows = new Map<string, UploadRow>();
  locks = new Set<string>();
  constructor(readonly clock: Clock) { }

  private snap(r: UploadRow): UploadRow {
    return { ...r, parts: r.parts.map((p) => ({ ...p })), chunks: r.chunks.map((c) => ({ ...c })), now_ms: this.clock.now() };
  }
  private live(r: UploadRow) { return r.expires_ms > this.clock.now(); }

  async insert(row: NewUpload, opts: { max_open: number; evict_idle_s: number; idle_s: number; hard_s: number }): Promise<InsertResult> {
    const now = this.clock.now();
    const open = [...this.rows.values()]
      .filter((r) => r.user_id === row.user_id && r.state === "open" && this.live(r))
      .sort((a, b) => a.updated_ms - b.updated_ms);
    let evicted: UploadRow | null = null;
    if (open.length >= opts.max_open) {
      const v = open[0]!;
      if ((now - v.updated_ms) / 1000 < opts.evict_idle_s) return { ok: false };
      if (this.locks.has(v.id)) return { ok: false }; // mid-assembly / mid-complete: not evictable
      v.state = "aborted";
      v.updated_ms = now;
      evicted = this.snap(v);
    }
    this.rows.set(row.id, {
      ...row, received_bytes: 0, assembled_bytes: 0, parts: [], chunks: [], state: "open", url: null, thumb_key: null,
      created_ms: now, updated_ms: now, expires_ms: now + Math.min(opts.idle_s, opts.hard_s) * 1000, now_ms: now,
    });
    return { ok: true, evicted };
  }

  async has_room(user_id: string, opts: { max_open: number; evict_idle_s: number }) {
    const open = [...this.rows.values()].filter((r) => r.user_id === user_id && r.state === "open" && this.live(r));
    if (open.length < opts.max_open) return true;
    const oldest = Math.min(...open.map((r) => r.updated_ms));
    return (this.clock.now() - oldest) / 1000 >= opts.evict_idle_s;
  }

  async get(id: string) {
    const r = this.rows.get(id);
    return r ? this.snap(r) : null;
  }

  async touch(id: string) {
    const r = this.rows.get(id);
    if (r && r.state === "open") r.updated_ms = this.clock.now();
  }

  async advance(a: { id: string; user_id: string; offset: number; len: number; nonce: string; idle_s: number; hard_s: number }) {
    const r = this.rows.get(a.id);
    if (!r || r.user_id !== a.user_id || r.state !== "open" || r.received_bytes !== a.offset
      || r.received_bytes + a.len > r.size || !this.live(r)) return null;
    const now = this.clock.now();
    r.received_bytes += a.len;
    r.chunks.push({ o: a.offset, l: a.len, s: a.nonce });
    r.updated_ms = now;
    r.expires_ms = Math.min(r.created_ms + a.hard_s * 1000, now + a.idle_s * 1000);
    return { received_bytes: r.received_bytes, assembled_bytes: r.assembled_bytes };
  }

  async with_lock<T>(id: string, fn: (l: LockedLedger) => Promise<T>): Promise<T | undefined> {
    if (this.locks.has(id)) return undefined;
    this.locks.add(id);
    try {
      return await fn({
        get: (x) => this.get(x),
        record_part: async (a: { id: string; old_assembled: number; n_before: number; part: PartRef; new_assembled: number }) => {
          const r = this.rows.get(a.id);
          if (!r || r.state !== "open" || r.assembled_bytes !== a.old_assembled || r.parts.length !== a.n_before) return false;
          r.parts.push({ ...a.part });
          r.assembled_bytes = a.new_assembled;
          r.chunks = r.chunks.filter((c) => c.o >= a.new_assembled).sort((x, y) => x.o - y.o);
          return true;
        },
        mark_complete: async (a: { id: string; url: string; thumb_key: string | null }) => {
          const r = this.rows.get(a.id);
          if (!r || r.state !== "open" || r.assembled_bytes !== r.size || r.received_bytes !== r.size) return false;
          Object.assign(r, { state: "complete", url: a.url, thumb_key: a.thumb_key, chunks: [], updated_ms: this.clock.now() });
          return true;
        },
        mark_aborted: (x, user_id) => this.mark_aborted_now(x, user_id),
      });
    } finally {
      this.locks.delete(id);
    }
  }

  /** Only through with_lock (LockedLedger.mark_aborted), as in PG. */
  private async mark_aborted_now(id: string, user_id: string | null) {
    const r = this.rows.get(id);
    if (!r || r.state !== "open" || (user_id !== null && r.user_id !== user_id)) return null;
    r.state = "aborted";
    r.updated_ms = this.clock.now();
    return this.snap(r);
  }

  async list_expired(limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.state === "open" && !this.live(r))
      .sort((a, b) => a.expires_ms - b.expires_ms)
      .slice(0, limit)
      .map((r) => this.snap(r));
  }

  async purge_terminal(older_than_s: number, limit: number) {
    const cutoff = this.clock.now() - older_than_s * 1000;
    let n = 0;
    for (const [id, r] of this.rows) {
      if (n >= limit) break;
      if (r.state !== "open" && r.updated_ms < cutoff) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}
