import Elysia, { t } from "elysia";
import { app_middleware, enforce_device_token } from "@/middleware";
import { deny_request, request_auth } from "@/middleware/request-auth";
import { fetch_pending_messages } from "@/cache-management/polling.cache";
import { socket_message_handler } from "@/sockets/socket.handlers";
import { ChatMessagePayload, MessageSentAckPayload, WSMessage } from "@/types/socket.types";
import { get_user_details } from "@/services/user.services";
import { touch_poll_lease } from "@/sockets/poll-lease";
import { clear_proto_lease_soon } from "@/services/sync/proto-lease";
import { forget_proto_refresh } from "@/services/sync/poll.service";
import { sync_v2_flags } from "@/services/app-settings.service";
import { v2_on } from "@/services/sync/flags-core";
import { is_bg_flag, is_fg_flag, note_announced_status } from "@/sockets/presence-flags";

export const chat_poll_routes = new Elysia({ prefix: "/chat/poll" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide
  // store: this check awaits Redis, and a shared store.id written after it
  // could be overwritten by a concurrent request before the handler read it.
  .resolve(async ({ cookie, set, headers }) => {
    const state_result = app_middleware({ cookie, headers });
    const r = request_auth(set, state_result);
    if (!("auth" in r) || !state_result.data) return r;

    // Single-device enforcement on the POLLING path. Long polling is the
    // WebSocket's stand-in, so it has to answer the same question the socket's
    // `open` handler does — otherwise a device superseded by a newer login keeps
    // polling and sending forever, which is exactly what kept an old device
    // "logged in" whenever it fell back to (or started on) polling.
    const superseded = await enforce_device_token(state_result.data);
    if (superseded) return deny_request(set, superseded);

    return r;
  })


  // .get("/sync-messages-via-polling", async ({ set, auth, params, query }) => {
  //   const sync_result = await sync_missed_messages(auth.id);
  //
  //   set.status = sync_result.code;
  //   return sync_result;
  // })

  // ============================================================================
  // HTTP Long Polling Endpoints - Fallback transport for WebSocket/SSE
  // ============================================================================

  // POST endpoint to send messages via polling
  .post('/send-message', async ({ body, set, auth, request, query }) => {
    try {
      const user_id = auth.id;
      const message = body as WSMessage;

      // Update polling connection tracking
      const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown';

      // Update or create polling connection (no query schema on this route,
      // so `bg` arrives raw).
      touch_poll_lease(user_id, client_ip, (query as Record<string, unknown>)?.bg);

      const user_res = await get_user_details(user_id);
      let user_name = "";
      let user_pfp = "";
      if (user_res.success) {
        user_name = user_res.data?.name || "";
        user_pfp = user_res.data?.profile_pic || "";
      }

      // Process the message using the socket handler
      const handled = await socket_message_handler({
        user_id: user_id,
        user_name: user_name,
        // user_pfp: user_pfp,
      }, message);


      // ------------------------------------------------------------
      // temp flow
      // ------------------------------------------------------------
      if (message.type == "message:new") {
        const payload = message.payload as ChatMessagePayload;
        const ack_message_payload: MessageSentAckPayload = {
          msg_id: payload.id,
          conv_id: payload.conv_id,
          is_sent: true,
        };

        // SYNC_V2 §4.1 (sync_v2 'on', body carries request_id): the REAL
        // message:sent:ack (with seq) rides the response, so a poll sender
        // need not wait for it on its next poll; a refused / failed send
        // answers non-200 with that ack. The synthetic message:ack stays.
        const request_id = (body as { request_id?: unknown } | null)?.request_id;
        const sent_ack = handled?.data?.sent_ack;
        if (typeof request_id === "string" && request_id.length > 0 && v2_on(sync_v2_flags())) {
          const ok = handled?.success === true && sent_ack?.is_sent === true;
          const code = ok ? 200 : (handled?.code && handled.code >= 400 ? handled.code : 500);
          set.status = code;
          return {
            success: ok,
            code,
            message: ok ? "Message processed successfully" : (handled?.message ?? "Failed to process message"),
            data: {
              type: "message:ack",
              payload: ack_message_payload,
              ws_timestamp: new Date(),
              request_id,
              sent_ack: sent_ack
                ? { type: "message:sent:ack", payload: sent_ack, ws_timestamp: new Date() }
                : null,
            },
          };
        }

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

  .get("/poll-pending-messages", async ({ set, auth, query, request }) => {
    try {
      const user_id = auth.id;
      const messages = await fetch_pending_messages(
        user_id, query.after_message_id, query.for_sync === true,
      );


      // Update polling connection tracking
      const client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown';

      // A poll v1 request means a legacy client: drop the Sync v2 proto
      // lease so legacy pending storing applies again (§3.13 downgrade).
      // No-op while sync_v2_proto_lease is off.
      clear_proto_lease_soon(user_id);
      forget_proto_refresh(user_id);

      if (!query.for_sync) {
        // Update or create polling connection
        touch_poll_lease(user_id, client_ip, query.bg);
      } else if (is_bg_flag(query.bg)) {
        // A reconnect sync GET does not touch the lease, but it is still a
        // background announcement for the next lease this user creates.
        note_announced_status(user_id, "background");
      } else if (is_fg_flag(query.bg)) {
        note_announced_status(user_id, "online");
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
      // Background flag (SYNC_V2 R0.1): "1" while the app is not resumed,
      // "0" (new clients) while it is.
      // Must be declared: Elysia strips undeclared query params (it does not
      // reject them, so old clients and future params are safe either way).
      bg: t.Optional(t.String()),
    })
  });
