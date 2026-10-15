// Upload size ceilings (Cloudflare free plan: request bodies over 100 MB are
// refused at the edge). Pure — no database / Redis / network.
// Run: `bun test tests/upload-limits.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_UPLOAD_FILE_BYTES,
} from "@/config/upload-limits";
import { get_file_size_limit } from "@/services/s3.service";

// Cloudflare's "100 MB", read the strict way (10^6 bytes per MB).
const CLOUDFLARE_FREE_BODY_BYTES = 100 * 1000 * 1000;

describe("upload limits", () => {
  test("the file cap plus real multipart framing fits under Cloudflare's 100 MB", () => {
    expect(MAX_UPLOAD_FILE_BYTES).toBe(95 * 1024 * 1024);
    // Framing for one file part is a few hundred bytes; allow 64 KiB.
    expect(MAX_UPLOAD_FILE_BYTES + 64 * 1024).toBeLessThan(
      CLOUDFLARE_FREE_BODY_BYTES,
    );
  });

  test("Bun's body limit admits a max-size file with its framing", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_UPLOAD_FILE_BYTES);
    expect(MAX_REQUEST_BODY_BYTES - MAX_UPLOAD_FILE_BYTES).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });

  test("no per-type service limit exceeds the file cap", () => {
    const mimes = [
      "image/jpeg",
      "image/gif",
      "audio/mpeg",
      "video/mp4",
      "video/webm",
      "application/pdf",
      "application/zip",
      "application/vnd.android.package-archive",
      "application/x-unknown-type",
    ];
    for (const mime of mimes) {
      expect(get_file_size_limit(mime)).toBeLessThanOrEqual(
        MAX_UPLOAD_FILE_BYTES,
      );
    }
    expect(get_file_size_limit("video/mp4")).toBe(MAX_UPLOAD_FILE_BYTES);
    expect(get_file_size_limit("application/pdf")).toBe(MAX_UPLOAD_FILE_BYTES);
    expect(get_file_size_limit("image/jpeg")).toBe(15 * 1024 * 1024);
  });
});
