import { Elysia, t } from "elysia";
import {
  upload_media_file,
  upload_image,
  upload_audio,
  upload_video,
  upload_document,
  delete_media_file
} from "@/services/media.service";
import { get_allowed_file_types, S3_FOLDERS } from "@/services/s3.service";
import { app_middleware } from "@/middleware";
import { request_auth } from "@/middleware/request-auth";
import { MAX_UPLOAD_FILE_BYTES } from "@/config/upload-limits";

const media_routes = new Elysia({ prefix: "/media" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide store.
  .resolve(({ cookie, set, headers }) => request_auth(set, app_middleware({ cookie, headers })))

  // Generic file upload
  .post("/upload", async ({ set, auth, body }) => {
    const result = await upload_media_file(auth.id, body.file);
    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        file: t.File({
          // Coarse backstop at the largest per-type service limit (95 MiB,
          // config/upload-limits.ts — Cloudflare free plan caps bodies at
          // 100 MB); get_file_size_limit in s3.service.ts does the real
          // per-type validation. Note t.File maxSize validates after the
          // body is received; Bun's maxRequestBodySize (server.ts) is what
          // refuses an oversized body before it is read.
          maxSize: MAX_UPLOAD_FILE_BYTES,
        }),
      }),
    }
  )

  // Image upload
  .post("/upload/image", async ({ set, auth, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No image file provided",
        };
      }

      const result = await upload_image(auth.id, body.file);
      set.status = result.code;
      return result;
    } catch (error: any) {
      console.error("Error in image upload:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  },
    {
      body: t.Object({
        file: t.File({
          type: get_allowed_file_types(S3_FOLDERS.IMAGES),
          maxSize: 5 * 1024 * 1024, // 5MB
        }),
      }),
    }
  )

  // Audio upload
  .post("/upload/audio", async ({ set, auth, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No audio file provided",
        };
      }

      const result = await upload_audio(auth.id, body.file);
      set.status = result.code;
      return result;
    } catch (error: any) {
      console.error("Error in audio upload:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  },
    {
      body: t.Object({
        file: t.File({
          type: get_allowed_file_types(S3_FOLDERS.AUDIOS),
          maxSize: 50 * 1024 * 1024, // 50MB
        }),
      }),
    }
  )

  // Video upload
  .post("/upload/video", async ({ set, auth, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No video file provided",
        };
      }

      const result = await upload_video(auth.id, body.file);
      set.status = result.code;
      return result;
    } catch (error: any) {
      console.error("Error in video upload:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  },
    {
      body: t.Object({
        file: t.File({
          type: get_allowed_file_types(S3_FOLDERS.VIDEOS),
          // Keep in sync with get_file_size_limit (s3.service.ts). Note
          // t.File maxSize validates after the body is received — it is
          // not a transfer abort.
          maxSize: MAX_UPLOAD_FILE_BYTES, // 95 MiB (config/upload-limits.ts)
        }),
      }),
    }
  )

  // Document upload
  .post("/upload/document", async ({ set, auth, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No document file provided",
        };
      }

      const result = await upload_document(auth.id, body.file);
      set.status = result.code;
      return result;
    } catch (error: any) {
      console.error("Error in document upload:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  },
    {
      body: t.Object({
        file: t.File({
          type: get_allowed_file_types(S3_FOLDERS.DOCS),
          maxSize: 25 * 1024 * 1024, // 25MB
        }),
      }),
    }
  )

  // Delete file
  .delete("/delete", async ({ set, auth, body }) => {
    try {
      if (!body.key) {
        set.status = 400;
        return {
          success: false,
          message: "No file key provided",
        };
      }

      // Basic security check - ensure the key contains the user's ID
      if (!body.key.includes(`/${auth.id}/`)) {
        set.status = 403;
        return {
          success: false,
          message: "Unauthorized to delete this file",
        };
      }

      const result = await delete_media_file(body.key);
      set.status = result.code;
      return result;
    } catch (error: any) {
      console.error("Error in file deletion:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  },
    {
      body: t.Object({
        key: t.String(),
      }),
    }
  )

  // Get supported file types for each category
  .get("/supported-types", ({ set }) => {
    try {
      set.status = 200;
      return {
        success: true,
        message: "Supported file types retrieved",
        data: {
          images: get_allowed_file_types(S3_FOLDERS.IMAGES),
          audios: get_allowed_file_types(S3_FOLDERS.AUDIOS),
          videos: get_allowed_file_types(S3_FOLDERS.VIDEOS),
          documents: get_allowed_file_types(S3_FOLDERS.DOCS),
        },
      };
    } catch (error: any) {
      console.error("Error getting supported types:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  });

export default media_routes;
