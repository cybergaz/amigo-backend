import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { fetch_pending_messages } from "@/services/cache-management/polling.cache";
import { socket_message_handler } from "@/sockets/socket.handlers";
import { ChatMessageAckPayload, ChatMessagePayload, WSMessage } from "@/types/socket.types";
import { get_user_details } from "@/services/user.services";
import { polling_connections } from "@/sockets/socket.server";

export const chat_poll_routes = new Elysia({ prefix: "/chat/poll" })
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })


  // .get("/sync-messages-via-polling", async ({ set, store, params, query }) => {
  //   const sync_result = await sync_missed_messages(store.id);
  //
  //   set.status = sync_result.code;
  //   return sync_result;
  // })

  // ============================================================================
  // HTTP Long Polling Endpoints - Fallback transport for WebSocket/SSE
  // ============================================================================

  // POST endpoint to send messages via polling
  .post('/send-message', async ({ body, set, store, request }) => {
    try {
      const user_id = store.id;
      const message = body as WSMessage;

      // Update polling connection tracking
      const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown';

      // Update or create polling connection
      const existing_connection = polling_connections.get(user_id);
      if (existing_connection) {
        existing_connection.last_poll = new Date();
        existing_connection.client_ip = client_ip;
      } else {
        polling_connections.set(user_id, {
          connection_status: "foreground",
          last_poll: new Date(),
          client_ip,
          connected_at: new Date(),
        });
      }

      const user_res = await get_user_details(user_id);
      let user_name = "";
      let user_pfp = "";
      if (user_res.success) {
        user_name = user_res.data?.name || "";
        user_pfp = user_res.data?.profile_pic || "";
      }

      // Process the message using the socket handler
      await socket_message_handler({
        user_id: user_id,
        user_name: user_name,
        user_pfp: user_pfp,
      }, message);


      // ------------------------------------------------------------
      // temp flow
      // ------------------------------------------------------------
      if (message.type == "message:new") {
        const payload = message.payload as ChatMessagePayload;
        const ack_message_payload: ChatMessageAckPayload = {
          id: payload.id,
          conv_id: payload.conv_id,
          sender_id: payload.sender_id,
          delivered_at: new Date(),
          delivered_to: [],
          read_by: [],
          offline_users: [],
        };

        // Return success - the handler will broadcast responses via polling cache
        set.status = 200;
        return {
          success: true,
          code: 200,
          message: "Message processed successfully",
          data: {
            type: "message:ack",
            payload: ack_message_payload,
            ws_timestamp: new Date()
          }
        };
      }

      // Return success - the handler will broadcast responses via polling cache
      set.status = 200;
      return {
        success: true,
        code: 200,
        message: "Message processed successfully",
      };
    } catch (error) {
      console.error("[POLL] Error processing message:", error);
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Failed to process message",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, {
    body: t.Any(),
  })

  .get("/poll-pending-messages", async ({ set, store, query, request }) => {
    try {
      const user_id = store.id;
      const messages = await fetch_pending_messages(user_id, query.after_message_id);


      // Update polling connection tracking
      const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown';

      if (!query.for_sync) {
        // Update or create polling connection
        const existing_connection = polling_connections.get(user_id);
        if (existing_connection) {
          existing_connection.last_poll = new Date();
          existing_connection.client_ip = client_ip;
        } else {
          polling_connections.set(user_id, {
            connection_status: "foreground",
            last_poll: new Date(),
            client_ip,
            connected_at: new Date(),
          });
        }
      }

      return {
        success: true,
        code: 200,
        message: messages.length > 0
          ? `Fetched ${messages.length} pending message(s)`
          : "No pending messages",
        data: {
          messages: messages,
          count: messages.length,
          last_message_id: messages.length > 0
            ? messages[messages.length - 1].message_id
            : query.after_message_id ?? null,
        },
      };
    } catch (error) {
      console.error("[POLL] Error fetching pending messages:", error);
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Failed to fetch pending messages",
      };
    }
  }, {
    query: t.Object({
      after_message_id: t.Optional(t.String()),
      for_sync: t.Optional(t.Boolean()), // If true, indicates this poll is for syncing missed messages after reconnection
    })
  });
