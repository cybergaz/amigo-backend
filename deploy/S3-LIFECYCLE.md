# S3 for chunked uploads and resumable downloads (M track)

Ops steps for SYNC_V2_PROTOCOL.md §14.10 / §14.11. **Done by you, by hand.**
Nothing in this repository calls AWS on its own. Use the bucket named by
`S3_BUCKET_NAME` in the prod env (shown below as `$BUCKET`).

## 1. Lifecycle rules (`deploy/s3-lifecycle.json`)

| Rule | What it does | Why |
|---|---|---|
| `amigo-abort-incomplete-multipart-7d` | Aborts any multipart upload still open 7 days after it started (whole bucket). | Backstop for uploads the app abandoned and the daily `upload_gc` job could not abort (S3 or DB error, job not running). Unfinished parts are billed storage that no listing shows. |
| `amigo-expire-upload-staging-2d` | Deletes objects under `staging/` 2 days after they were written. | Chunks are staged privately as `staging/{upload_id}/{offset}-{nonce}` until they are folded into a 5 MiB part. The server deletes them itself; this catches what a crash or a lost race left behind. An upload can live at most 36 h (`HARD_TTL_S` in `src/services/chunked-upload-core.ts`), which is less than 2 days, so a live upload never loses a staged chunk to this rule. Keep it that way if either number changes. |

**`put-bucket-lifecycle-configuration` REPLACES the bucket's whole lifecycle
configuration.** Read the current one first and merge.

```bash
# 0. What is there now (an error "NoSuchLifecycleConfiguration" means: none)
aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" > /tmp/lifecycle-current.json

# 1a. No existing rules: apply ours as is
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file://deploy/s3-lifecycle.json

# 1b. Existing rules: merge them (rule IDs must stay unique), then apply the merge
jq -s '{Rules: (.[0].Rules + .[1].Rules)}' /tmp/lifecycle-current.json deploy/s3-lifecycle.json > /tmp/lifecycle-merged.json
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file:///tmp/lifecycle-merged.json

# 2. Check
aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"
```

If bucket versioning is on (`aws s3api get-bucket-versioning --bucket "$BUCKET"`
prints `"Status": "Enabled"`), the staging rule only adds delete markers. Add
`"NoncurrentVersionExpiration": {"NoncurrentDays": 1}` to that rule so the
staged bytes really go. Today's code never overwrites a key, so that is the
only versioning effect.

## 2. IAM for the backend's key

The single-request route only needs `s3:PutObject` / `s3:PutObjectAcl` /
`s3:DeleteObject`. Chunked uploads also need the following. Check the policy
of the key in the prod env before switching the flag on.

| Action | Used for |
|---|---|
| `s3:PutObject`, `s3:PutObjectAcl` | staging chunks, posters, and `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` (all covered by PutObject) |
| `s3:GetObject` | reading staged chunks back to assemble a part (they are private, so the bucket's public read does not cover them) |
| `s3:DeleteObject` | staging deletes (`DeleteObjects`) |
| `s3:AbortMultipartUpload` | abort, the per-user cap eviction, and `upload_gc` |

`HeadObject` (used once, to recover a `complete` whose answer was lost) is
covered by `s3:GetObject`. No `s3:ListBucket` is needed: staged keys are
tracked in `media_uploads.chunks`.

## 3. Switching chunked uploads on (after the test-env check)

1. `bun run script:migrate up 20261024-media-uploads`. This creates the
   `media_uploads` table and the marker `sync_v2_media_uploads`. It does not
   depend on the sync v2 scripts, so it can run before or after them.
2. Apply the lifecycle rules (section 1) and check IAM (section 2).
3. `bun run scripts/set-sync-v2-flag.ts sync_v2_chunked_upload on`
   (off again the same way). With the flag off the endpoints answer 404, and
   the app falls back to the single-request route. The daily `upload_gc` keeps
   cleaning up while the flag is off.
4. Watch `GET /api/admin/net-health`: `data.uploads` (open uploads, permits)
   and `data.counters.UPLOAD` (`init`, `chunk`, `chunk_409`,
   `part_assembled`, `complete`, `abort`, `gc_aborted`, `*_bytes`,
   `*_failed`).

## 4. Downloads: Range / If-Range (§14.10). Nothing to configure.

Media is not served by the API. Every media URL is a direct S3 object URL
(`https://$BUCKET.s3.$AWS_REGION.amazonaws.com/{key}`,
`s3.service.ts public_object_url`), with no proxy and no CDN (D-N7, later).
S3 answers `Range: bytes=N-` with `206 Partial Content` + `Content-Range`, so
resumable downloads work end to end with no server code. Objects are never
overwritten (unique keys, `Cache-Control: immutable`).

Client rules (the app's `media-fetcher.service.dart`):

- Resume with `Range: bytes=<part-length>-` plus `If-Match: <ETag of the first
  response>`. S3 documents `If-Match`. Do **not** rely on `If-Range` alone:
  it may be sent, but S3's GetObject documentation lists only `If-Match` /
  `If-None-Match` / `If-Modified-Since` / `If-Unmodified-Since`.
- Accept the bytes only on `206` with `Content-Range: bytes <part-length>-…`
  and the same `ETag`. A `200` (range ignored) or `412` (object changed)
  means: drop the `.part` file and start again from 0.
- Multipart objects have ETags like `"<hex>-3"`. Compare them as opaque
  strings.

Test-env check (read-only):
`curl -s -o /dev/null -D - -H 'Range: bytes=100-' "<any media url>"` must
print `HTTP/1.1 206` and `Content-Range: bytes 100-…`.

If a CDN is ever put in front of the bucket (D-N7), it must forward `Range`
and `If-Match` and keep `206` responses intact. Repeat the curl check through
the CDN hostname.
