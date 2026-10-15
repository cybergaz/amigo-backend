// =============================================================================
// Upload size limits — ONE place for every media byte ceiling.
// =============================================================================
// Every upload reaches us through Cloudflare, and the account is on the FREE
// plan: Cloudflare refuses any request body over 100 MB with its own 413
// before we see a byte (after the client has already sent the whole body).
// So nothing we accept may need a bigger body than that.
//
// MAX_UPLOAD_FILE_BYTES is 95 MiB (99,614,720 bytes). That stays under
// 100 MB whichever way Cloudflare counts a megabyte (10^6 or 2^20), with room
// for the multipart framing. The app uses the SAME number (amigo-app
// kMaxUploadBytes in lib/services/message/media-upload.manager.dart): it
// refuses bigger files before uploading, so this server check is a backstop
// for old builds and direct-to-origin requests.
//
// MAX_REQUEST_BODY_BYTES is Bun's maxRequestBodySize (server.ts). Bun answers
// 413 from the Content-Length alone, before the body is read or buffered, so
// an oversized request costs no memory. It is the file cap plus 1 MiB for the
// multipart boundary and part headers (a few hundred bytes in practice). The
// default was 128 MiB, which let a 100–128 MiB body be fully buffered and
// then rejected. Keep nginx `client_max_body_size` at or above this (96m).
//
// There is no upload path that bypasses Cloudflare: every upload is a
// multipart POST to /api/media/* (Cloudflare → nginx → Bun → S3 PutObject),
// or — M track, behind sync_v2_chunked_upload — a series of ≤ 1 MiB chunk
// PUTs to /api/media/upload/:id (routes/media-upload.routes.ts) that the
// server assembles into S3 multipart parts. The chunked route lifts the
// per-REQUEST limit only: the file total is still capped at
// MAX_UPLOAD_FILE_BYTES (chunked-upload-core.ts validate_init).
// s3.service get_presigned_url signs GETs only (and is unused today).

const MiB = 1024 * 1024;

export const MAX_UPLOAD_FILE_BYTES = 95 * MiB;

export const MULTIPART_OVERHEAD_BYTES = 1 * MiB;

export const MAX_REQUEST_BODY_BYTES =
  MAX_UPLOAD_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;
