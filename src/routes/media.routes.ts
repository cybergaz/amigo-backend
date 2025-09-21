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

const media_routes = new Elysia({ prefix: "/media" })
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  // Generic file upload
  .post("/upload", async ({ set, store, body }) => {
    const result = await upload_media_file(store.id, body.file);
    set.status = result.code;
    return result;
  },
    {
      body: t.Object({
        file: t.File({
          maxSize: 500 * 1024 * 1024, // 500MB max (will be validated per file type)
        }),
      }),
    }
  )

  // Image upload
  .post("/upload/image", async ({ set, store, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No image file provided",
        };
      }

      const result = await upload_image(store.id, body.file);
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
  .post("/upload/audio", async ({ set, store, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No audio file provided",
        };
      }

      const result = await upload_audio(store.id, body.file);
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
  .post("/upload/video", async ({ set, store, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No video file provided",
        };
      }

      const result = await upload_video(store.id, body.file);
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
          maxSize: 500 * 1024 * 1024, // 500MB
        }),
      }),
    }
  )

  // Document upload
  .post("/upload/document", async ({ set, store, body }) => {
    try {
      if (!body.file) {
        set.status = 400;
        return {
          success: false,
          message: "No document file provided",
        };
      }

      const result = await upload_document(store.id, body.file);
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
  .delete("/delete", async ({ set, store, body }) => {
    try {
      if (!body.key) {
        set.status = 400;
        return {
          success: false,
          message: "No file key provided",
        };
      }

      // Basic security check - ensure the key contains the user's ID
      if (!body.key.includes(`/${store.id}/`)) {
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
  })

export default media_routes;
