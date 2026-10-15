// Chunked resumable uploads (SYNC_V2_PROTOCOL.md §14.11) + the thumbnail /
// poster passthrough (§14.7 item 5). The engine runs against an in-memory
// ledger with the PG statements' CAS semantics and a fake S3 that enforces
// the multipart rules (tests/helpers/fake-upload-store.ts); the real SQL runs
// on the PGlite harness (scratchpad pglite/mupload.ts). The HTTP layer is
// exercised through Elysia's app.handle(). No database, Redis or network.
// Run: `bun test tests/chunked-upload.test.ts`.
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  DEFAULT_CHUNK_SIZE,
  EVICT_IDLE_S,
  HARD_TTL_S,
  IDLE_TTL_S,
  MAX_OPEN_UPLOADS_PER_USER,
  MAX_PENDING_BYTES,
  MAX_POSTER_BYTES,
  PART_MIN_BYTES,
  TERMINAL_RETENTION_S,
  Semaphore,
  expected_chunk_len,
  make_chunked_upload,
  plan_part,
  validate_init,
  type UResult,
} from "@/services/chunked-upload-core";
import { build_media_upload_routes } from "@/routes/media-upload.routes";
import { MAX_UPLOAD_FILE_BYTES } from "@/config/upload-limits";
import {
  MAX_INLINE_THUMB_CHARS,
  MAX_INLINE_THUMBS_TOTAL_CHARS,
  sanitize_attachments,
  strip_inline_thumbs,
  strip_list,
  strip_ws_thumbs,
} from "@/utils/attachment-thumbs";
import { DEFAULT_SYNC_V2_FLAGS, parse_sync_v2_flags } from "@/services/sync/flags-core";
import { SYNC_V2_KEYS } from "@/services/sync/seq-queries";
import { snapshot_counters } from "@/utils/counters";
import { Clock, FakeS3, MemoryLedger } from "./helpers/fake-upload-store";

const KiB = 1024;
const MiB = 1024 * KiB;
const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const bytes = (n: number, seed = 7): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed + (i >>> 13)) & 255;
  return b;
};
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
const body = (r: UResult) => r.body as Record<string, any>;
const data = (r: UResult) => body(r).data as Record<string, any>;

const setup = (opts: { assembly_permits?: number; ledger?: MemoryLedger; s3?: FakeS3; clock?: Clock } = {}) => {
  const clock = opts.clock ?? new Clock();
  const ledger = opts.ledger ?? new MemoryLedger(clock);
  const s3 = opts.s3 ?? new FakeS3();
  const svc = make_chunked_upload({
    ledger,
    store: s3,
    now: clock.now,
    // complete's busy loop waits on this; advancing the fake clock makes its
    // deadline reachable without real sleeping
    sleep: async (ms) => { clock.advance(ms); await Promise.resolve(); },
    lock_wait_ms: 2_000,
    assembly_sem: new Semaphore(opts.assembly_permits ?? 2),
  });
  return { clock, ledger, s3, svc };
};

const init = async (svc: ReturnType<typeof setup>["svc"], size: number, extra: Record<string, unknown> = {}, user = U) => {
  const r = await svc.init(user, { mime: "video/mp4", size, kind: "video", name: "clip.mp4", ...extra });
  expect(r.status).toBe(200);
  return data(r) as { upload_id: string; chunk_size: number; offset: number };
};

const put = (svc: ReturnType<typeof setup>["svc"], id: string, offset: number, chunk: Uint8Array, user = U, declared: number | null = chunk.byteLength) => {
  let read = false;
  const p = svc.put_chunk(user, id, String(offset), declared, async (max) => {
    read = true;
    return chunk.byteLength > max ? null : chunk;
  });
  return p.then((r) => Object.assign(r, { body_read: read }));
};

const upload_range = async (svc: ReturnType<typeof setup>["svc"], id: string, file: Uint8Array, cs: number, from = 0, to = file.byteLength) => {
  for (let o = from; o < to; o += cs) {
    const r = await put(svc, id, o, file.subarray(o, Math.min(o + cs, file.byteLength)));
    expect(r.status).toBe(200);
    expect(body(r).offset).toBe(Math.min(o + cs, file.byteLength));
  }
};

describe("validate_init (today's limits, 95 MiB total cap)", () => {
  test("accepts a video with the default chunk size", () => {
    const v = validate_init({ mime: "video/mp4", size: 1234, kind: "video" });
    expect(v.ok && v.v.chunk_size).toBe(DEFAULT_CHUNK_SIZE);
    expect(v.ok && v.v.category).toBe("videos");
  });
  test("zero-length, negative, fractional, missing sizes are 400", () => {
    for (const size of [0, -1, 1.5, "10", undefined]) {
      const v = validate_init({ mime: "video/mp4", size });
      expect(v.ok).toBe(false);
      if (!v.ok) expect([v.status, v.reason]).toEqual([400, "bad_size"]);
    }
  });
  test("oversize is 413 with the max: 95 MiB for video/docs, 15 MiB for images", () => {
    const v = validate_init({ mime: "video/mp4", size: MAX_UPLOAD_FILE_BYTES + 1 });
    expect(!v.ok && [v.status, v.reason, v.extra?.max]).toEqual([413, "too_large", MAX_UPLOAD_FILE_BYTES]);
    expect(validate_init({ mime: "video/mp4", size: MAX_UPLOAD_FILE_BYTES }).ok).toBe(true);
    const img = validate_init({ mime: "image/jpeg", size: 15 * MiB + 1 });
    expect(!img.ok && [img.status, img.extra?.max]).toEqual([413, 15 * MiB]);
  });
  test("mime / kind / chunk_size / sha256 / name validation", () => {
    const reason = (b: unknown) => { const v = validate_init(b); return v.ok ? "ok" : v.reason; };
    expect(reason({ mime: "application/x-evil", size: 10 })).toBe("bad_mime");
    expect(reason({ mime: "video/mp4", size: 10, kind: "image" })).toBe("kind_mismatch");
    expect(reason({ mime: "video/mp4", size: 10, kind: "hologram" })).toBe("bad_kind");
    expect(reason({ mime: "video/mp4", size: 10, chunk_size: 300_000 })).toBe("bad_chunk_size");
    expect(reason({ mime: "video/mp4", size: 10, chunk_size: 2 * MiB })).toBe("bad_chunk_size");
    expect(reason({ mime: "video/mp4", size: 10, chunk_size: 256 * KiB })).toBe("ok");
    expect(reason({ mime: "video/mp4", size: 10, sha256: "abc" })).toBe("bad_sha256");
    expect(reason({ mime: "video/mp4", size: 10, sha256: "a".repeat(64) })).toBe("ok");
    expect(reason({ mime: "video/mp4", size: 10, name: "x".repeat(256) })).toBe("bad_name");
    expect(reason([1])).toBe("bad_body");
    expect(reason({ mime: "IMAGE/JPEG", size: 10, kind: "image" })).toBe("ok");
  });
});

describe("plan_part", () => {
  const ch = (o: number, l: number) => ({ o, l, s: "x" });
  test("waits for 5 MiB, then takes the run that crosses it", () => {
    const one = Array.from({ length: 4 }, (_, i) => ch(i * MiB, MiB));
    expect(plan_part(one, 0, false)).toBeNull();
    const five = Array.from({ length: 6 }, (_, i) => ch(i * MiB, MiB));
    expect(plan_part(five, 0, false)?.size).toBe(5 * MiB);
    expect(plan_part(five, 0, false)?.take.length).toBe(5);
  });
  test("final takes the small remainder; never past a gap", () => {
    expect(plan_part([ch(5 * MiB, 100)], 5 * MiB, true)?.size).toBe(100);
    expect(() => plan_part([ch(6 * MiB, 100)], 5 * MiB, true)).toThrow();
    expect(plan_part([], 0, true)).toBeNull();
  });
  test("expected_chunk_len: chunk_size, then the remainder, then 0", () => {
    expect(expected_chunk_len({ size: 10, chunk_size: 4 }, 0)).toBe(4);
    expect(expected_chunk_len({ size: 10, chunk_size: 4 }, 8)).toBe(2);
    expect(expected_chunk_len({ size: 10, chunk_size: 4 }, 10)).toBe(0);
  });
});

describe("chunk protocol", () => {
  test("small file: one short chunk, complete, idempotent re-complete", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(300 * KiB);
    const up = await init(svc, file.byteLength);
    expect(up.offset).toBe(0);
    await upload_range(svc, up.upload_id, file, up.chunk_size);
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    const d = data(c);
    expect(d.file_size).toBe(file.byteLength);
    expect(d.mime_type).toBe("video/mp4");
    expect(d.category).toBe("videos");
    expect(d.key).toContain(`/${U}/`);
    expect(d.url).toBe(s3.public_url(d.key));
    expect(d.thumb_url).toBeUndefined();
    expect(same(s3.objects.get(d.key)!.body, file)).toBe(true);
    expect(s3.staging_keys()).toEqual([]);
    expect(ledger.rows.get(up.upload_id)!.state).toBe("complete");
    const again = await svc.complete(U, up.upload_id, null);
    expect(again.status).toBe(200);
    expect(data(again).url).toBe(d.url);
    expect(s3.calls.complete_multipart).toBe(1);
  });

  test("out-of-order chunk → 409 {offset}, before the body is read; nothing staged", async () => {
    const { svc, s3 } = setup();
    const up = await init(svc, 3 * MiB, { chunk_size: MiB });
    const ahead = await put(svc, up.upload_id, MiB, bytes(MiB));
    expect(ahead.status).toBe(409);
    expect(body(ahead).reason).toBe("offset_mismatch");
    expect(body(ahead).offset).toBe(0);
    expect(ahead.headers?.["upload-offset"]).toBe("0");
    expect(ahead.body_read).toBe(false);
    expect(s3.staging_keys()).toEqual([]);
    const bad = await svc.put_chunk(U, up.upload_id, "abc", null, async () => bytes(1));
    expect([bad.status, body(bad).reason]).toEqual([400, "bad_offset"]);
  });

  test("duplicate chunk retry is idempotent: 409 with the advanced offset, state unchanged", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(2 * MiB + 5);
    const up = await init(svc, file.byteLength, { chunk_size: MiB });
    const first = await put(svc, up.upload_id, 0, file.subarray(0, MiB));
    expect(first.status).toBe(200);
    const dup = await put(svc, up.upload_id, 0, file.subarray(0, MiB));
    expect(dup.status).toBe(409);
    expect(body(dup).offset).toBe(MiB);
    expect(ledger.rows.get(up.upload_id)!.received_bytes).toBe(MiB);
    expect(ledger.rows.get(up.upload_id)!.chunks.length).toBe(1);
    expect(s3.staging_keys().length).toBe(1);
    await upload_range(svc, up.upload_id, file, MiB, MiB);
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
  });

  test("chunk length rules: exact chunk_size, the remainder last, nothing after the end", async () => {
    const { svc } = setup();
    const up = await init(svc, MiB + 10, { chunk_size: MiB });
    const big = await put(svc, up.upload_id, 0, bytes(MiB + 1));
    expect([big.status, body(big).reason, body(big).expected]).toEqual([413, "chunk_too_large", MiB]);
    expect(big.body_read).toBe(false); // refused from Content-Length
    const lying = await put(svc, up.upload_id, 0, bytes(MiB + 1), U, null); // no Content-Length
    expect([lying.status, body(lying).reason]).toEqual([413, "chunk_too_large"]);
    const short = await put(svc, up.upload_id, 0, bytes(1000), U, null);
    expect([short.status, body(short).reason]).toEqual([400, "bad_chunk_length"]);
    const decl_short = await put(svc, up.upload_id, 0, bytes(1000));
    expect([decl_short.status, body(decl_short).reason]).toEqual([400, "bad_chunk_length"]);
    expect((await put(svc, up.upload_id, 0, bytes(MiB))).status).toBe(200);
    expect((await put(svc, up.upload_id, MiB, bytes(11))).status).toBe(413);
    expect((await put(svc, up.upload_id, MiB, bytes(10))).status).toBe(200);
    const after = await put(svc, up.upload_id, MiB + 10, bytes(1));
    expect([after.status, body(after).reason, body(after).offset]).toEqual([409, "all_received", MiB + 10]);
  });

  test("resume via HEAD on another worker after a restart", async () => {
    const clock = new Clock();
    const a = setup({ clock });
    const file = bytes(3 * MiB + 77);
    const up = await init(a.svc, file.byteLength, { chunk_size: 512 * KiB });
    await upload_range(a.svc, up.upload_id, file, 512 * KiB, 0, 3 * 512 * KiB);
    // "app restart": a different worker process, same PG + S3
    const b = setup({ clock, ledger: a.ledger, s3: a.s3 });
    const h = await b.svc.status(U, up.upload_id);
    expect(h.status).toBe(200);
    expect(h.headers?.["upload-offset"]).toBe(String(3 * 512 * KiB));
    expect(h.headers?.["upload-length"]).toBe(String(file.byteLength));
    expect(h.headers?.["upload-chunk-size"]).toBe(String(512 * KiB));
    expect(h.headers?.["upload-state"]).toBe("open");
    expect(body(h).offset).toBe(3 * 512 * KiB);
    await upload_range(b.svc, up.upload_id, file, 512 * KiB, Number(h.headers!["upload-offset"]));
    const c = await b.svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    expect(same(a.s3.objects.get(data(c).key)!.body, file)).toBe(true);
    // GET after completion carries the url (a client that lost complete's answer)
    const g = await a.svc.status(U, up.upload_id);
    expect([data(g).state, data(g).url, data(g).offset]).toEqual(["complete", data(c).url, file.byteLength]);
  });
});

describe("part assembly", () => {
  test("parts at 5 MiB boundaries and a small last part; ≤ 6 MiB per part in memory", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(12 * MiB + 123);
    const up = await init(svc, file.byteLength, { chunk_size: MiB });
    await upload_range(svc, up.upload_id, file, MiB, 0, 5 * MiB);
    let row = ledger.rows.get(up.upload_id)!;
    expect(row.parts.map((p) => p.size)).toEqual([5 * MiB]);
    expect(row.assembled_bytes).toBe(5 * MiB);
    expect(row.chunks).toEqual([]);
    expect(s3.staging_keys()).toEqual([]); // assembled chunks deleted
    await upload_range(svc, up.upload_id, file, MiB, 5 * MiB);
    row = ledger.rows.get(up.upload_id)!;
    expect(row.parts.map((p) => p.size)).toEqual([5 * MiB, 5 * MiB]);
    expect(row.chunks.length).toBe(3); // 2 MiB + 123 waits for complete
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    row = ledger.rows.get(up.upload_id)!;
    expect(row.parts.map((p) => p.size)).toEqual([5 * MiB, 5 * MiB, 2 * MiB + 123]);
    expect(row.parts.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
    expect(s3.max_part_bytes).toBeLessThanOrEqual(6 * MiB);
    expect(s3.staging_keys()).toEqual([]);
  });

  test("an upload ending exactly on a part boundary completes with no extra part", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(10 * MiB);
    const up = await init(svc, file.byteLength, { chunk_size: 256 * KiB });
    await upload_range(svc, up.upload_id, file, 256 * KiB);
    expect(ledger.rows.get(up.upload_id)!.parts.length).toBe(2);
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    expect(ledger.rows.get(up.upload_id)!.parts.map((p) => p.size)).toEqual([5 * MiB, 5 * MiB]);
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
  });

  test("assembly skipped while another worker holds the lock: complete builds every part", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(11 * MiB + 3);
    const up = await init(svc, file.byteLength, { chunk_size: MiB });
    ledger.locks.add(up.upload_id); // a sibling worker "holds" upload:{id}
    await upload_range(svc, up.upload_id, file, MiB);
    expect(ledger.rows.get(up.upload_id)!.parts.length).toBe(0);
    const busy = await svc.complete(U, up.upload_id, null);
    expect([busy.status, body(busy).reason, busy.headers?.["retry-after"]]).toEqual([503, "busy", "2"]);
    ledger.locks.delete(up.upload_id);
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    expect(ledger.rows.get(up.upload_id)!.parts.map((p) => p.size)).toEqual([5 * MiB, 5 * MiB, MiB + 3]);
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
  });

  test("staging backlog past 16 MiB → 503 assembly_behind (bounded staging)", async () => {
    const { svc, ledger } = setup();
    const up = await init(svc, 40 * MiB, { chunk_size: MiB });
    ledger.locks.add(up.upload_id);
    for (let o = 0; o < MAX_PENDING_BYTES; o += MiB) expect((await put(svc, up.upload_id, o, bytes(MiB))).status).toBe(200);
    const r = await put(svc, up.upload_id, MAX_PENDING_BYTES, bytes(MiB));
    expect([r.status, body(r).reason]).toEqual([503, "assembly_behind"]);
    expect(r.body_read).toBe(false);
    ledger.locks.delete(up.upload_id);
    expect((await put(svc, up.upload_id, MAX_PENDING_BYTES, bytes(MiB))).status).toBe(200);
    expect(ledger.rows.get(up.upload_id)!.parts.length).toBeGreaterThanOrEqual(3);
  });

  test("an S3 failure during UploadPart never fails the chunk; the next chunk retries the part", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(7 * MiB);
    const up = await init(svc, file.byteLength, { chunk_size: MiB });
    s3.fail_next("upload_part");
    await upload_range(svc, up.upload_id, file, MiB, 0, 5 * MiB);
    expect(ledger.rows.get(up.upload_id)!.parts.length).toBe(0);
    expect(snapshot_counters().UPLOAD?.part_failed).toBeGreaterThanOrEqual(1);
    await upload_range(svc, up.upload_id, file, MiB, 5 * MiB);
    expect(ledger.rows.get(up.upload_id)!.parts.length).toBe(1);
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
  });

  test("complete retried after S3 completed but the row write was lost", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(100);
    const up = await init(svc, 100);
    await upload_range(svc, up.upload_id, file, up.chunk_size);
    await svc.assemble(up.upload_id, true);
    const row = ledger.rows.get(up.upload_id)!;
    await s3.complete_multipart(row.key, row.s3_upload_id, row.parts.map((p) => ({ n: p.n, etag: p.etag })));
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    expect(ledger.rows.get(up.upload_id)!.state).toBe("complete");
  });

  test("the assembly semaphore bounds parts in memory across uploads", async () => {
    const { svc, s3 } = setup({ assembly_permits: 1 });
    s3.delay("upload_part", 5);
    const files = [bytes(6 * MiB, 1), bytes(6 * MiB, 2)];
    const ups = await Promise.all(files.map((f) => init(svc, f.byteLength, { chunk_size: MiB })));
    await Promise.all(ups.map((u, i) => upload_range(svc, u.upload_id, files[i]!, MiB)));
    const done = await Promise.all(ups.map((u) => svc.complete(U, u.upload_id, null)));
    done.forEach((c, i) => expect(same(s3.objects.get(data(c).key)!.body, files[i]!)).toBe(true));
  });
});

describe("races between workers", () => {
  test("two workers racing the same offset: one 200, one 409, one staged copy", async () => {
    const clock = new Clock();
    const w1 = setup({ clock });
    const w2 = setup({ clock, ledger: w1.ledger, s3: w1.s3 });
    w1.s3.delay("put_staging", 5); // both pass the offset check before either advances
    const file = bytes(3 * MiB);
    const up = await init(w1.svc, file.byteLength, { chunk_size: MiB });
    const chunk = file.subarray(0, MiB);
    const [a, b] = await Promise.all([put(w1.svc, up.upload_id, 0, chunk), put(w2.svc, up.upload_id, 0, chunk)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(body(loser).offset).toBe(MiB);
    expect(body(loser).reason).toBe("offset_mismatch");
    const row = w1.ledger.rows.get(up.upload_id)!;
    expect(row.received_bytes).toBe(MiB);
    expect(row.chunks.length).toBe(1);
    await Bun.sleep(1); // the loser's staging delete is fire-and-forget
    expect(w1.s3.staging_keys().length).toBe(1);
    expect(w1.s3.staging_keys()[0]).toContain(`-${row.chunks[0]!.s}`);
    await upload_range(w2.svc, up.upload_id, file, MiB, MiB);
    const c = await w1.svc.complete(U, up.upload_id, null);
    expect(same(w1.s3.objects.get(data(c).key)!.body, file)).toBe(true);
  });

  test("a chunk racing an abort: 410, its staged copy removed", async () => {
    const { svc, s3 } = setup();
    s3.delay("put_staging", 5);
    const up = await init(svc, 2 * MiB, { chunk_size: MiB });
    const p = put(svc, up.upload_id, 0, bytes(MiB));
    await Bun.sleep(1);
    expect((await svc.abort(U, up.upload_id)).status).toBe(200);
    const r = await p;
    expect([r.status, body(r).reason]).toEqual([410, "aborted"]);
    await Bun.sleep(1);
    expect(s3.staging_keys()).toEqual([]);
  });
});

// Real timers (sleep / now), for races whose two sides must both make
// progress: the fake sleep only advances the clock.
const real_setup = (assembly_sem = new Semaphore(2)) => {
  const clock = new Clock(Date.now());
  const ledger = new MemoryLedger(clock);
  const s3 = new FakeS3();
  const svc = make_chunked_upload({ ledger, store: s3, lock_wait_ms: 2_000, assembly_sem });
  return { ledger, s3, svc, assembly_sem };
};
const upload_counter = (name: string) => Number(snapshot_counters().UPLOAD?.[name] ?? 0);

describe("serialisation with complete, ids, pipelining", () => {
  test("an abort racing complete's CompleteMultipartUpload waits for it: 409 already_complete, the object stays referenced", async () => {
    const { svc, s3, ledger } = real_setup();
    const file = bytes(300 * KiB);
    const up = await init(svc, file.byteLength);
    await upload_range(svc, up.upload_id, file, up.chunk_size);
    const orig = s3.complete_multipart.bind(s3);
    let abort_p: Promise<UResult> | null = null;
    s3.complete_multipart = async (key, upload_id, parts) => {
      abort_p = svc.abort(U, up.upload_id); // lands while complete holds the lock
      await Bun.sleep(20);
      return orig(key, upload_id, parts);
    };
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    const a = await abort_p!;
    expect([a.status, body(a).reason]).toEqual([409, "already_complete"]);
    expect(ledger.rows.get(up.upload_id)!.state).toBe("complete");
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
  });

  test("abort after a complete whose answer was lost deletes the finished object and poster (no lifecycle rule covers them)", async () => {
    const { svc, s3, ledger } = setup();
    const up = await init(svc, 100);
    await upload_range(svc, up.upload_id, bytes(100), up.chunk_size);
    await svc.assemble(up.upload_id, true);
    const row = ledger.rows.get(up.upload_id)!;
    await s3.put_public(`${row.key}.poster.jpg`, new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");
    await s3.complete_multipart(row.key, row.s3_upload_id, row.parts.map((p) => ({ n: p.n, etag: p.etag })));
    expect(s3.objects.has(row.key)).toBe(true);
    expect((await svc.abort(U, up.upload_id)).status).toBe(200);
    expect(s3.objects.has(row.key)).toBe(false);
    expect(s3.objects.has(`${row.key}.poster.jpg`)).toBe(false);
  });

  test("the GC skips an expired upload whose lock is held (next run), then aborts it", async () => {
    const { svc, ledger, clock } = setup();
    const up = await init(svc, 3 * MiB, { chunk_size: MiB });
    clock.advance((IDLE_TTL_S + 1) * 1000);
    ledger.locks.add(up.upload_id);
    expect(await svc.gc_once()).toBe(0);
    expect(ledger.rows.get(up.upload_id)!.state).toBe("open");
    ledger.locks.delete(up.upload_id);
    expect(await svc.gc_once()).toBe(1);
    expect(ledger.rows.get(up.upload_id)!.state).toBe("aborted");
  });

  test("eviction never takes a locked upload, and a complete attempt counts as activity", async () => {
    const { svc, ledger, clock, s3 } = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_UPLOADS_PER_USER; i++) {
      const up = await init(svc, 10);
      await put(svc, up.upload_id, 0, bytes(10));
      ids.push(up.upload_id);
    }
    clock.advance((EVICT_IDLE_S + 1) * 1000);
    // #0 is mid-complete on another worker: it holds the lock
    ledger.locks.add(ids[0]!);
    expect((await svc.init(U, { mime: "video/mp4", size: 10 })).status).toBe(429);
    // its complete keeps getting 503 busy, but each attempt touches the row
    const busy = await svc.complete(U, ids[0]!, null);
    expect([busy.status, body(busy).reason]).toEqual([503, "busy"]);
    ledger.locks.delete(ids[0]!);
    const creates = s3.calls.create_multipart ?? 0;
    expect((await svc.init(U, { mime: "video/mp4", size: 10 })).status).toBe(200);
    expect(s3.calls.create_multipart).toBe(creates + 1);
    expect(ledger.rows.get(ids[0]!)!.state).toBe("open");
    expect(ledger.rows.get(ids[1]!)!.state).toBe("aborted");
  });

  test("an id in another case uses the canonical staging keys and lock: upper-case PUTs, lower-case complete", async () => {
    const { svc, s3, ledger } = setup();
    const file = bytes(6 * MiB + 1);
    const up = await init(svc, file.byteLength, { chunk_size: MiB });
    const UP = up.upload_id.toUpperCase();
    for (let o = 0; o < file.byteLength; o += MiB) {
      const r = await put(svc, UP, o, file.subarray(o, Math.min(o + MiB, file.byteLength)));
      expect(r.status).toBe(200);
    }
    expect(s3.staging_keys().every((k) => k.startsWith(`staging/${up.upload_id}/`))).toBe(true);
    expect((await svc.status(U, UP)).status).toBe(200);
    const c = await svc.complete(U, up.upload_id, null);
    expect(c.status).toBe(200);
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
    expect(ledger.rows.get(up.upload_id)!.state).toBe("complete");
    const up2 = await init(svc, 10);
    expect((await svc.abort(U, up2.upload_id.toUpperCase())).status).toBe(200);
    expect(ledger.rows.get(up2.upload_id)!.state).toBe("aborted");
  });

  test("at the cap, init answers 429 before any CreateMultipartUpload", async () => {
    const { svc, s3 } = setup();
    for (let i = 0; i < MAX_OPEN_UPLOADS_PER_USER; i++) await init(svc, 10);
    const creates = s3.calls.create_multipart ?? 0;
    const before = upload_counter("init_cap");
    for (let i = 0; i < 5; i++) expect((await svc.init(U, { mime: "video/mp4", size: 10 })).status).toBe(429);
    expect(s3.calls.create_multipart).toBe(creates);
    expect(upload_counter("init_cap")).toBe(before + 5);
  });

  test("two racing completes: both answered with the url, counted once", async () => {
    const { svc } = setup();
    const up = await init(svc, 300 * KiB);
    await upload_range(svc, up.upload_id, bytes(300 * KiB), up.chunk_size);
    const before = [upload_counter("complete"), upload_counter("complete_bytes")];
    const [a, b] = await Promise.all([svc.complete(U, up.upload_id, null), svc.complete(U, up.upload_id, null)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(data(a).url).toBe(data(b).url);
    expect([upload_counter("complete"), upload_counter("complete_bytes")]).toEqual([before[0]! + 1, before[1]! + 300 * KiB]);
  });

  test("complete's S3 step holds an assembly permit (bounds pool connections held across S3)", async () => {
    const { svc, s3, assembly_sem } = real_setup(new Semaphore(1));
    const up = await init(svc, 10);
    await put(svc, up.upload_id, 0, bytes(10));
    const orig = s3.complete_multipart.bind(s3);
    let in_use = -1;
    s3.complete_multipart = async (key, upload_id, parts) => {
      in_use = assembly_sem.in_use;
      return orig(key, upload_id, parts);
    };
    expect((await svc.complete(U, up.upload_id, null)).status).toBe(200);
    expect(in_use).toBe(1);
    expect(assembly_sem.in_use).toBe(0);
  });

  test("two chunks in flight (§14.11 'two on good'): the second waits for the first instead of 409", async () => {
    const { svc, s3, ledger } = real_setup();
    s3.delay("put_staging", 30);
    const file = bytes(4 * 256 * KiB);
    const up = await init(svc, file.byteLength, { chunk_size: 256 * KiB });
    const cs = 256 * KiB;
    const [a, b] = await Promise.all([
      put(svc, up.upload_id, 0, file.subarray(0, cs)),
      put(svc, up.upload_id, cs, file.subarray(cs, 2 * cs)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(ledger.rows.get(up.upload_id)!.received_bytes).toBe(2 * cs);
    // two chunks ahead is still a plain 409 (no waiting)
    const far = await put(svc, up.upload_id, 4 * cs, file.subarray(0, cs));
    expect(far.status).toBe(409);
    s3.delay("put_staging", 0);
    await upload_range(svc, up.upload_id, file, cs, 2 * cs);
    const c = await svc.complete(U, up.upload_id, null);
    expect(same(s3.objects.get(data(c).key)!.body, file)).toBe(true);
  });
});

describe("complete edge cases, poster, abort, ownership", () => {
  test("complete before every byte arrived → 409 incomplete {offset}", async () => {
    const { svc } = setup();
    const up = await init(svc, 2 * MiB, { chunk_size: MiB });
    const none = await svc.complete(U, up.upload_id, null);
    expect([none.status, body(none).reason, body(none).offset]).toEqual([409, "incomplete", 0]);
    await put(svc, up.upload_id, 0, bytes(MiB));
    const half = await svc.complete(U, up.upload_id, null);
    expect([half.status, body(half).offset]).toEqual([409, MiB]);
  });

  test("zero-length and oversize uploads are refused at init", async () => {
    const { svc, s3 } = setup();
    const zero = await svc.init(U, { mime: "video/mp4", size: 0 });
    expect([zero.status, body(zero).reason]).toEqual([400, "bad_size"]);
    const big = await svc.init(U, { mime: "video/mp4", size: MAX_UPLOAD_FILE_BYTES + 1 });
    expect([big.status, body(big).reason, body(big).max]).toEqual([413, "too_large", MAX_UPLOAD_FILE_BYTES]);
    expect(s3.calls.create_multipart ?? 0).toBe(0);
  });

  test("poster: JPEG stored public next to the video → thumb_url; bad / big refused", async () => {
    const { svc, s3 } = setup();
    const up = await init(svc, 10);
    await put(svc, up.upload_id, 0, bytes(10));
    const not_jpeg = await svc.complete(U, up.upload_id, new Uint8Array([1, 2, 3, 4]));
    expect([not_jpeg.status, body(not_jpeg).reason]).toEqual([400, "bad_poster"]);
    const huge = new Uint8Array(MAX_POSTER_BYTES + 1); huge.set([0xff, 0xd8, 0xff]);
    expect((await svc.complete(U, up.upload_id, huge)).status).toBe(413);
    const jpeg = new Uint8Array(2000); jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const c = await svc.complete(U, up.upload_id, jpeg);
    expect(c.status).toBe(200);
    const d = data(c);
    expect(d.thumb_url).toBe(s3.public_url(`${d.key}.poster.jpg`));
    const obj = s3.objects.get(`${d.key}.poster.jpg`)!;
    expect([obj.public, obj.mime, obj.body.byteLength]).toEqual([true, "image/jpeg", 2000]);
    expect(data(await svc.complete(U, up.upload_id, null)).thumb_url).toBe(d.thumb_url);
  });

  test("abort: S3 upload aborted, staging removed, then 410 everywhere; abort is idempotent", async () => {
    const { svc, s3, ledger } = setup();
    const up = await init(svc, 3 * MiB, { chunk_size: MiB });
    await put(svc, up.upload_id, 0, bytes(MiB));
    const mpu = ledger.rows.get(up.upload_id)!.s3_upload_id;
    const a = await svc.abort(U, up.upload_id);
    expect([a.status, data(a).state]).toEqual([200, "aborted"]);
    expect(s3.aborted).toContain(mpu);
    expect(s3.staging_keys()).toEqual([]);
    expect((await put(svc, up.upload_id, MiB, bytes(MiB))).status).toBe(410);
    const h = await svc.status(U, up.upload_id);
    expect([h.status, h.headers?.["upload-state"]]).toEqual([410, "aborted"]);
    expect((await svc.complete(U, up.upload_id, null)).status).toBe(410);
    expect((await svc.abort(U, up.upload_id)).status).toBe(200);
  });

  test("abort after complete → 409", async () => {
    const { svc } = setup();
    const up = await init(svc, 10);
    await put(svc, up.upload_id, 0, bytes(10));
    await svc.complete(U, up.upload_id, null);
    const r = await svc.abort(U, up.upload_id);
    expect([r.status, body(r).reason]).toEqual([409, "already_complete"]);
  });

  test("only the uploader: another user's id is 404 everywhere (never 403)", async () => {
    const { svc } = setup();
    const up = await init(svc, 10);
    for (const r of [
      await svc.status(OTHER, up.upload_id),
      await put(svc, up.upload_id, 0, bytes(10), OTHER),
      await svc.complete(OTHER, up.upload_id, null),
      await svc.abort(OTHER, up.upload_id),
      await svc.status(U, "not-a-uuid"),
    ]) expect([r.status, body(r).reason]).toEqual([404, "not_found"]);
  });
});

describe("per-user cap, expiry and GC", () => {
  test("the 9th open upload is 429 unless the oldest is idle ≥ 15 min (then it is evicted)", async () => {
    const { svc, s3, ledger, clock } = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_UPLOADS_PER_USER; i++) ids.push((await init(svc, 10)).upload_id);
    const refused = await svc.init(U, { mime: "video/mp4", size: 10 });
    expect([refused.status, body(refused).reason, refused.headers?.["retry-after"]]).toEqual([429, "too_many_uploads", "60"]);
    expect(s3.uploads.size).toBe(MAX_OPEN_UPLOADS_PER_USER); // the refused one's MPU was aborted
    expect((await svc.init(OTHER, { mime: "video/mp4", size: 10 })).status).toBe(200); // per user
    clock.advance((EVICT_IDLE_S + 1) * 1000);
    await put(svc, ids[1]!, 0, bytes(10)); // keeps #1 active
    const ok = await svc.init(U, { mime: "video/mp4", size: 10 });
    expect(ok.status).toBe(200);
    expect(ledger.rows.get(ids[0]!)!.state).toBe("aborted");
    expect(ledger.rows.get(ids[1]!)!.state).toBe("open");
  });

  test("idle expiry slides with each chunk, capped by the absolute TTL", async () => {
    const { svc, ledger, clock } = setup();
    const up = await init(svc, 40 * 256 * KiB, { chunk_size: 256 * KiB });
    const t0 = clock.now();
    expect(ledger.rows.get(up.upload_id)!.expires_ms).toBe(t0 + IDLE_TTL_S * 1000);
    let o = 0;
    for (let h = 0; h < 3; h++) {
      clock.advance(10 * 3600 * 1000); // 10 h idle each time: inside the 24 h window
      expect((await put(svc, up.upload_id, o, bytes(256 * KiB))).status).toBe(200);
      o += 256 * KiB;
    }
    // slid past created + 24 h, but never past created + 36 h
    expect(ledger.rows.get(up.upload_id)!.expires_ms).toBe(t0 + HARD_TTL_S * 1000);
    clock.advance(7 * 3600 * 1000); // 37 h after init
    const late = await put(svc, up.upload_id, o, bytes(256 * KiB));
    expect([late.status, body(late).reason]).toEqual([410, "expired"]);
  });

  test("expired → 410; gc aborts it in S3 and purges terminal rows after 7 days", async () => {
    const { svc, s3, ledger, clock } = setup();
    const stale = await init(svc, 3 * MiB, { chunk_size: MiB });
    await put(svc, stale.upload_id, 0, bytes(MiB));
    const done = await init(svc, 10);
    await put(svc, done.upload_id, 0, bytes(10));
    await svc.complete(U, done.upload_id, null);
    clock.advance((IDLE_TTL_S + 1) * 1000);
    const r = await put(svc, stale.upload_id, MiB, bytes(MiB));
    expect([r.status, body(r).reason]).toEqual([410, "expired"]);
    expect((await svc.complete(U, stale.upload_id, null)).status).toBe(410);
    const mpu = ledger.rows.get(stale.upload_id)!.s3_upload_id;
    expect(await svc.gc_once()).toBe(1);
    expect(ledger.rows.get(stale.upload_id)!.state).toBe("aborted");
    expect(s3.aborted).toContain(mpu);
    expect(s3.staging_keys()).toEqual([]);
    expect(await svc.gc_once()).toBe(0); // idempotent
    clock.advance((TERMINAL_RETENTION_S + 1) * 1000);
    expect(await svc.gc_once()).toBe(2);
    expect(ledger.rows.size).toBe(0);
  });
});

describe("HTTP routes (Elysia, flag-gated)", () => {
  const build = (enabled: { on: boolean }) => {
    const env = setup();
    const app = new Elysia({ prefix: "/api" }).use(build_media_upload_routes({
      service: env.svc,
      enabled: () => enabled.on,
      auth: ({ headers }) => headers["x-user"]
        ? { code: 200, data: { id: headers["x-user"]!, role: "user" } }
        : { success: false, code: 401, message: "Unauthorized", data: null },
    }));
    const call = (method: string, path: string, init: { body?: string | Uint8Array; headers?: Record<string, string> } = {}) =>
      app.handle(new Request(`http://localhost/api/media/upload${path}`, {
        method, body: init.body as BodyInit | undefined, headers: { "x-user": U, ...(init.headers ?? {}) },
      }));
    return { ...env, call };
  };

  test("flag off → 404 chunked_upload_off on every endpoint; unauthenticated → 401", async () => {
    const { call } = build({ on: false });
    for (const [m, p] of [["POST", "/init"], ["PUT", `/${U}?offset=0`], ["GET", `/${U}/status`], ["POST", `/${U}/complete`], ["DELETE", `/${U}`]] as const) {
      const r = await call(m, p, { body: m === "POST" || m === "PUT" ? "{}" : undefined });
      expect(r.status).toBe(404);
      expect((await r.json()).reason).toBe("chunked_upload_off");
    }
    const h = await call("HEAD", `/${U}`);
    expect(h.status).toBe(404);
    const anon = await build({ on: true }).call("POST", "/init", { body: "{}", headers: { "x-user": "" } });
    expect(anon.status).toBe(401);
  });

  test("init → PUT chunks → HEAD → complete (poster) → GET, end to end", async () => {
    const { call, s3 } = build({ on: true });
    const file = bytes(6 * MiB + 9);
    const r0 = await call("POST", "/init", {
      body: JSON.stringify({ mime: "video/mp4", size: file.byteLength, kind: "video", name: "a b.mp4", chunk_size: MiB }),
      headers: { "content-type": "application/json" },
    });
    expect(r0.status).toBe(200);
    const { data: d0 } = await r0.json();
    expect([d0.chunk_size, d0.offset, d0.part_size]).toEqual([MiB, 0, PART_MIN_BYTES]);
    const id = d0.upload_id as string;

    const r409 = await call("PUT", `/${id}?offset=${MiB}`, { body: file.subarray(0, MiB) });
    expect(r409.status).toBe(409);
    expect((await r409.json()).offset).toBe(0);

    for (let o = 0; o < file.byteLength; o += MiB) {
      const chunk = file.subarray(o, Math.min(o + MiB, file.byteLength));
      const r = await call("PUT", `/${id}?offset=${o}`, { body: chunk, headers: { "content-type": "application/octet-stream" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("upload-offset")).toBe(String(o + chunk.byteLength));
      if (o === 0) {
        const h = await call("HEAD", `/${id}`);
        expect([h.status, h.headers.get("upload-offset"), h.headers.get("upload-state")]).toEqual([200, String(MiB), "open"]);
        expect(await h.text()).toBe("");
      }
    }
    const big = await call("PUT", `/${id}?offset=0`, { body: bytes(MiB + 1) });
    expect(big.status).toBe(409); // offset checked first: already past 0

    const jpeg = new Uint8Array(500); jpeg.set([0xff, 0xd8, 0xff, 0xdb]);
    const rc = await call("POST", `/${id}/complete`, { body: jpeg, headers: { "content-type": "image/jpeg" } });
    expect(rc.status).toBe(200);
    const { data: dc } = await rc.json();
    expect(dc.thumb_url).toBe(`${dc.url}.poster.jpg`);
    expect(dc.file_name).toBe("a b.mp4");
    expect(dc.key).toContain("a_b.mp4");
    expect(same(s3.objects.get(dc.key)!.body, file)).toBe(true);

    // JSON complete body (no poster) on an already complete upload: same answer
    const again = await call("POST", `/${id}/complete`, { body: "{}", headers: { "content-type": "application/json" } });
    expect((await again.json()).data.url).toBe(dc.url);
    const g = await call("GET", `/${id}/status`);
    expect((await g.json()).data.state).toBe("complete");
    const h = await call("HEAD", `/${id}`);
    expect([h.status, h.headers.get("upload-state"), h.headers.get("upload-offset")]).toEqual([200, "complete", String(file.byteLength)]);
    const h404 = await call("HEAD", `/${OTHER}`);
    expect(h404.status).toBe(404);
  });

  test("a slow init body never runs as another user (the id is per request, not the shared store)", async () => {
    const { app_handle, ledger } = (() => {
      const env = build({ on: true });
      return { app_handle: env.call, ledger: env.ledger };
    })();
    let push!: () => void;
    const gate = new Promise<void>((r) => (push = r));
    const enc = new TextEncoder();
    const slow = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode('{"mime":"video/mp4",'));
        await gate; // the body's second half arrives after another user's request
        c.enqueue(enc.encode('"size":10}'));
        c.close();
      },
    });
    const a = app_handle("POST", "/init", { body: slow as unknown as Uint8Array, headers: { "x-user": U } });
    await Bun.sleep(5);
    const b = await app_handle("GET", `/${U}/status`, { headers: { "x-user": OTHER } });
    expect(b.status).toBe(404);
    push();
    const ra = await a;
    expect(ra.status).toBe(200);
    const id = (await ra.json()).data.upload_id as string;
    expect(ledger.rows.get(id)!.user_id).toBe(U);
    expect(ledger.rows.get(id)!.key).toContain(`/${U}/`);
  });

  test("bad JSON / oversized init body, JSON base64 poster, DELETE", async () => {
    const { call } = build({ on: true });
    expect((await call("POST", "/init", { body: "nope" })).status).toBe(400);
    expect((await call("POST", "/init", { body: "x".repeat(5000) })).status).toBe(413);
    const r0 = await call("POST", "/init", { body: JSON.stringify({ mime: "application/pdf", size: 4 }) });
    const id = (await r0.json()).data.upload_id;
    await call("PUT", `/${id}?offset=0`, { body: new Uint8Array([1, 2, 3, 4]) });
    const poster = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 9]).toString("base64");
    const bad = await call("POST", `/${id}/complete`, { body: JSON.stringify({ poster: "%%%" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const rc = await call("POST", `/${id}/complete`, { body: JSON.stringify({ poster }), headers: { "content-type": "application/json" } });
    expect((await rc.json()).data.thumb_url).toContain(".poster.jpg");
    const r1 = await call("POST", "/init", { body: JSON.stringify({ mime: "application/pdf", size: 4 }) });
    const id1 = (await r1.json()).data.upload_id;
    const del = await call("DELETE", `/${id1}`);
    expect([del.status, (await del.json()).data.state]).toEqual([200, "aborted"]);
  });
});

describe("thumbnail / poster passthrough (§14.7 item 5)", () => {
  const thumb = "/9j/" + "A".repeat(2000);
  const ON = { inline_thumbs: true };
  const OFF = { inline_thumbs: false };
  test("old payloads are returned as the same object (byte-identical)", () => {
    const att = [{ url: "https://x/y.jpg", key: "k", category: "images", file_name: "y.jpg", file_size: 1, mime_type: "image/jpeg" }];
    expect(sanitize_attachments(att, ON)).toBe(att);
    expect(sanitize_attachments(att, OFF)).toBe(att);
    expect(sanitize_attachments(null, ON)).toBeNull();
    expect(sanitize_attachments(undefined, ON)).toBeUndefined();
    const good = [{ url: "u", thumb, thumb_url: "https://bucket/x.poster.jpg" }];
    expect(sanitize_attachments(good, ON)).toBe(good);
  });
  test("sync_v2_inline_thumbs off (default, the kill switch): thumb dropped at ingress, thumb_url kept", () => {
    expect(DEFAULT_SYNC_V2_FLAGS.inline_thumbs).toBe(false);
    expect(parse_sync_v2_flags([{ key: SYNC_V2_KEYS.inline_thumbs, value: "on" }]).inline_thumbs).toBe(true);
    const att = [{ url: "u", thumb, thumb_url: "https://bucket/x.poster.jpg" }, { url: "v", thumb: null }];
    const out = sanitize_attachments(att, OFF) as Record<string, unknown>[];
    expect(out[0]).toEqual({ url: "u", thumb_url: "https://bucket/x.poster.jpg" });
    expect(out[1]).toBe(att[1]!);
  });
  test("bad / oversize fields are dropped, never the attachment or message", () => {
    const att = [
      { url: "a", thumb: "not base64 !", thumb_url: "http://insecure/x.jpg" },
      { url: "b", thumb: "/9j/" + "A".repeat(MAX_INLINE_THUMB_CHARS) },
      { url: "c", thumb: "iVBORw0KGgo=" }, // a PNG, not a JPEG
      { url: "d", thumb_url: "https://ok/x.jpg\" onerror" },
      { url: "e", thumb: 42, thumb_url: "https://" + "x".repeat(1100) },
    ];
    const out = sanitize_attachments(att, ON) as Record<string, unknown>[];
    expect(out).not.toBe(att);
    expect(out.map((a) => a.url)).toEqual(["a", "b", "c", "d", "e"]);
    for (const a of out) {
      expect("thumb" in a).toBe(false);
      expect("thumb_url" in a).toBe(false);
    }
    expect("thumb" in att[0]!).toBe(true); // the input is not mutated
  });
  test("an album keeps thumbs up to the per-message total", () => {
    const n = Math.floor(MAX_INLINE_THUMBS_TOTAL_CHARS / thumb.length) + 2;
    const att = Array.from({ length: n }, (_, i) => ({ url: String(i), thumb }));
    const out = sanitize_attachments(att, ON) as Record<string, unknown>[];
    const kept = out.filter((a) => "thumb" in a).length;
    expect(kept).toBe(Math.floor(MAX_INLINE_THUMBS_TOTAL_CHARS / thumb.length));
  });
  test("FCM projection drops inline thumbs (also in the reply preview), keeps thumb_url", () => {
    const p: Record<string, any> = { id: "m", attachments: [{ url: "u", thumb, thumb_url: "https://p" }], replied_to_message: { id: "r", attachments: [{ url: "v", thumb }] } };
    const s = strip_inline_thumbs(p);
    expect(s).not.toBe(p);
    expect(s.attachments[0]).toEqual({ url: "u", thumb_url: "https://p" });
    expect(s.replied_to_message.attachments[0]).toEqual({ url: "v" });
    expect(p.attachments[0].thumb).toBe(thumb);
    const plain = { id: "m", attachments: [{ url: "u" }], replied_to_message: null };
    expect(strip_inline_thumbs(plain)).toBe(plain);
  });
  test("pending store / chat_meta copies carry no inline thumb (one copy per recipient on a noeviction Redis)", () => {
    const m = { type: "message:new", payload: { id: "m", attachments: [{ url: "u", thumb, thumb_url: "https://p" }], replied_to_message: { id: "r", attachments: [{ url: "v", thumb }] } } };
    const s = strip_ws_thumbs(m) as { payload: Record<string, any> };
    expect(s.payload.attachments[0]).toEqual({ url: "u", thumb_url: "https://p" });
    expect(s.payload.replied_to_message.attachments[0]).toEqual({ url: "v" });
    expect(m.payload.attachments[0]!.thumb).toBe(thumb);
    const plain = { type: "message:new", payload: { id: "m", attachments: [{ url: "u" }] } };
    expect(strip_ws_thumbs(plain)).toBe(plain);
    const other = { type: "message:delete", payload: { ids: ["a"] } };
    expect(strip_ws_thumbs(other)).toBe(other);
    const list = [{ url: "u", thumb }];
    expect(strip_list(list)).toEqual([{ url: "u" }]);
    const bare = [{ url: "u" }];
    expect(strip_list(bare)).toBe(bare);
  });
  test("the app's single-object attachments shape is bounded and stripped the same way", () => {
    const one = { url: "https://x/y.jpg", mime_type: "image/jpeg" };
    expect(sanitize_attachments(one, ON)).toBe(one);
    expect(strip_list(one)).toBe(one);
    const withThumb = { url: "u", thumb, thumb_url: "https://p" };
    expect(sanitize_attachments(withThumb, ON)).toBe(withThumb);
    expect(sanitize_attachments(withThumb, OFF) as unknown).toEqual({ url: "u", thumb_url: "https://p" });
    const bad = { url: "u", thumb: "/9j/" + "A".repeat(MAX_INLINE_THUMB_CHARS), thumb_url: "http://insecure" };
    expect(sanitize_attachments(bad, ON) as unknown).toEqual({ url: "u" });
    expect(bad.thumb).toBeDefined(); // the input is not mutated
    expect(strip_list(withThumb)).toEqual({ url: "u", thumb_url: "https://p" });
    const p: Record<string, any> = { id: "m", attachments: { url: "u", thumb }, replied_to_message: { id: "r", attachments: { url: "v", thumb } } };
    const s = strip_inline_thumbs(p);
    expect(s.attachments).toEqual({ url: "u" });
    expect(s.replied_to_message.attachments).toEqual({ url: "v" });
    const m = { type: "message:new", payload: { id: "m", attachments: { url: "u", thumb } } };
    expect((strip_ws_thumbs(m) as { payload: Record<string, any> }).payload.attachments).toEqual({ url: "u" });
  });
});

describe("Semaphore", () => {
  test("hands permits over in order and times out", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire(0);
    expect(r1).not.toBeNull();
    expect(await s.acquire(0)).toBeNull();
    expect(await s.acquire(5)).toBeNull();
    const waiting = s.acquire(1000);
    expect(s.waiting).toBe(1);
    r1!();
    r1!(); // idempotent
    const r2 = await waiting;
    expect(r2).not.toBeNull();
    expect(s.in_use).toBe(1);
    r2!();
    expect(s.in_use).toBe(0);
  });
});
