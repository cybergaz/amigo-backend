import { Elysia } from "elysia";
import "dotenv/config";
import cors from "@elysiajs/cors";
import "@/config/db";
import auth_routes from "./routes/auth.routes";
import user_routes from "./routes/user.routes";
import chat_routes from "./routes/chat.routes";
import media_routes from "./routes/media.routes";
import community_routes from "./routes/community.routes";
import call_routes from "./routes/call.routes";
import admin_routes from "./routes/admin.routes";
import web_socket_server from "./sockets/socket.server";
import { chat_dm_routes } from "./routes/chat-dm.routes";
import { chat_group_routes } from "./routes/chat-group.routes";
import { chat_poll_routes } from "./routes/chat-poll.routes";
import { message_routes } from "./routes/message.routes";
import { convertBigIntToString } from "./utils/serialization.utils";

const SERVER_PORT = parseInt(process.env.SERVER_PORT || "5000");
if (!SERVER_PORT || isNaN(SERVER_PORT)) {
  throw new Error("SERVER_PORT environment variable is not set or invalid");
}
const app = new Elysia({ prefix: "/api" })

  // .onAfterHandle(({ responseValue }) => {
  //   console.log('[BIGINT-SERIALIZATION] Hook called, responseValue type:', typeof responseValue);
  //
  //   // Only transform if responseValue is an object/array (not already a string or Response object)
  //   if (responseValue && typeof responseValue === 'object' && !(responseValue instanceof Response) && !(responseValue instanceof Date)) {
  //     try {
  //       // Convert all BigInt values to strings recursively
  //       const transformed = convertBigIntToString(responseValue);
  //
  //       // Verify the transformation worked by attempting to stringify
  //       JSON.stringify(transformed);
  //
  //       // Debug: Log if transformation happened (only for conversation history to avoid spam)
  //       if (transformed?.data?.messages) {
  //         console.log('[BIGINT-SERIALIZATION] Transformed response, message count:', transformed.data.messages.length);
  //       }
  //
  //       // Return the transformed response
  //       return transformed;
  //     } catch (error) {
  //       console.error('[BIGINT-SERIALIZATION] Error transforming response:', error);
  //       console.error('[BIGINT-SERIALIZATION] ResponseValue type:', typeof responseValue);
  //       console.error('[BIGINT-SERIALIZATION] ResponseValue keys:', responseValue && typeof responseValue === 'object' ? Object.keys(responseValue) : 'N/A');
  //
  //       // If transformation fails, return original (might still fail, but at least we log the error)
  //       return responseValue;
  //     }
  //   }
  //
  //   // Return responseValue as-is if it doesn't need transformation
  //   return responseValue;
  // })
  .onError(({ error, set, path }) => {
    const err = error as any;
    switch (err.code) {
      case "VALIDATION":
        console.error("[SERVER] Endpoint validation error at", path);
        set.status = 422;
        return {
          success: false,
          code: 422,
          message: `Endpoint validation error`,
          error: {
            expected: err.expected,
            received: err.value,
            valueError: {
              field: err.valueError?.path,
              message: err.valueError?.message,
            }
          },
        };
    }
  })

  .get("/", ({ set }) => {
    set.status = 200;
    return { success: true, code: 200, message: "Welcome to AmigoChats API", };
  })

  .use(cors({
    origin: [process.env.FRONTEND_URL || "http://localhost:3000", "https://amigochats.com", "https://www.amigochats.com", "https://admin.amigochats.com"],
    credentials: true,
  }))

  // Automatically convert BigInt values to strings in all responses
  // Registered BEFORE routes so it applies to all routes registered after
  .onAfterHandle(({ responseValue, path }) => {
    // console.log("path -> ", path);
    // console.log("responseValue -> ", responseValue);
    // console.log('[BIGINT-SERIALIZATION] Hook called, responseValue type:', typeof responseValue);

    // Only transform if responseValue is an object/array (not already a string or Response object)
    if (responseValue && typeof responseValue === 'object' && !(responseValue instanceof Response) && !(responseValue instanceof Date)) {
      try {
        // Convert all BigInt values to strings recursively
        const transformed = convertBigIntToString(responseValue);

        // Verify the transformation worked by attempting to stringify
        JSON.stringify(transformed);

        // Debug: Log if transformation happened (only for conversation history to avoid spam)
        // if (transformed?.data?.messages) {
        //   console.log('[BIGINT-SERIALIZATION] Transformed response, message count:', transformed.data.messages.length);
        // }

        // Return the transformed response
        return transformed;
      } catch (error) {
        console.error('[BIGINT-SERIALIZATION] Error transforming response:', error);
        console.error('[BIGINT-SERIALIZATION] ResponseValue type:', typeof responseValue);
        console.error('[BIGINT-SERIALIZATION] ResponseValue keys:', responseValue && typeof responseValue === 'object' ? Object.keys(responseValue) : 'N/A');

        // If transformation fails, return original (might still fail, but at least we log the error)
        return responseValue;
      }
    }

    // Return responseValue as-is if it doesn't need transformation
    return responseValue;
  })

  .use(auth_routes)
  .use(user_routes)
  .use(chat_routes)
  .use(chat_dm_routes)
  .use(chat_group_routes)
  .use(chat_poll_routes)
  .use(message_routes)
  .use(community_routes)
  .use(media_routes)
  .use(call_routes)
  .use(admin_routes)
  .use(web_socket_server)
  .listen(SERVER_PORT);

console.log(
  `🦊 Elysia is running at port ${app.server?.port} (PID: ${process.pid})`
);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
