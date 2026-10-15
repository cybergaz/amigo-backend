import { sql } from "drizzle-orm";
import { pgTable, bigint, integer, jsonb, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";

// Chunked resumable uploads (SYNC_V2 §14.11): one row per upload session.
// Created by scripts/migrations/20261024-media-uploads.ts; declared here so
// drizzle-kit sees no drift. Every statement that touches it lives in
// services/chunked-upload-pg.ts (raw postgres-js, so the PGlite harness runs
// the very same SQL); this model is the schema of record only.
//
// State lives HERE and in S3, never in a worker's memory, so any worker can
// serve any chunk:
//   received_bytes   bytes accepted (the resume offset); advanced only by
//                    "UPDATE … WHERE received_bytes = $offset" (row lock = the
//                    serialisation point between racing chunk retries)
//   chunks           staged chunks not yet in an S3 part: [{o, l, s}] (offset,
//                    length, staging-key nonce). Holds ≤ ~5 MiB worth: a part
//                    is assembled as soon as that much is staged
//   assembled_bytes  bytes already uploaded as S3 parts
//   parts            [{n, etag, size}] for CompleteMultipartUpload
// No FK to users on purpose (like net_beacons): a user delete must never be
// blocked by an upload, and the daily GC removes stale rows.
const media_upload_model = pgTable(
  "media_uploads",
  {
    id: uuid().primaryKey(),
    user_id: uuid().notNull(),
    // final object key (images/… videos/… audios/… docs/…)
    key: text().notNull(),
    mime: text().notNull(),
    category: text().notNull(),
    file_name: text(),
    size: bigint({ mode: "number" }).notNull(),
    chunk_size: integer().notNull(),
    sha256: text(),
    s3_upload_id: text().notNull(),
    received_bytes: bigint({ mode: "number" }).notNull().default(0),
    assembled_bytes: bigint({ mode: "number" }).notNull().default(0),
    parts: jsonb().notNull().default(sql`'[]'::jsonb`),
    chunks: jsonb().notNull().default(sql`'[]'::jsonb`),
    // open | complete | aborted
    state: text().notNull().default("open"),
    url: text(),
    // video poster (or any client-made preview) uploaded with complete
    thumb_key: text(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp({ withTimezone: true }).notNull(),
    completed_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    // per-user open-upload cap (init) — only open rows are ever counted
    index("idx_media_uploads_user_open").on(table.user_id).where(sql`state = 'open'`),
    // daily GC: open uploads past expires_at
    index("idx_media_uploads_expires_open").on(table.expires_at).where(sql`state = 'open'`),
  ],
);

type MediaUploadType = InferSelectModel<typeof media_upload_model>;
type InsertMediaUploadType = InferInsertModel<typeof media_upload_model>;

export { media_upload_model };
export type { MediaUploadType, InsertMediaUploadType };
