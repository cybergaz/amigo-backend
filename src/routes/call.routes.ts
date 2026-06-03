import { Elysia, t } from "elysia";
import { CallService } from "@/services/call.service";
import { StreamCallService } from "@/services/stream-call.service";
import { app_middleware } from "@/middleware";
import db from "@/config/db";
import { eq } from "drizzle-orm";
import { call_model } from "@/models/call.model";
import { user_model } from "@/models/user.model";
import { broadcast_message, is_user_online } from "@/sockets/socket.handlers";
import FCMService from "@/services/fcm.service";

const call_routes = new Elysia({ prefix: "/call" })

  // ---- Stream Video webhook (unauthenticated; verified via shared secret) ----
  // Configure this URL in the Stream dashboard:
  //   https://<your-domain>/api/call/stream/webhook
  // and set STREAM_WEBHOOK_SECRET to the value Stream shows you.
  //
  // `parse: 'text'` is critical: Stream signs the webhook with HMAC-SHA256
  // over the EXACT request bytes. If we let Elysia auto-parse the JSON
  // and re-stringify it (the previous behaviour), key ordering and
  // whitespace differ from Stream's payload, the HMAC mismatches, and we
  // 401 every webhook delivery. With `parse: 'text'` Elysia hands us the
  // raw body string straight from the request.
  .post(
    "/stream/webhook",
    async ({ set, body, headers }) => {
      try {
        const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
        const signature = headers["x-signature"] || headers["x-webhook-signature"];

        if (!StreamCallService.verifyWebhookSignature(rawBody, signature as string | undefined)) {
          set.status = 401;
          return { success: false, message: "Invalid webhook signature" };
        }

        const event = JSON.parse(rawBody);
        await StreamCallService.handleWebhookEvent(event);

        set.status = 200;
        return { success: true };
      } catch (err) {
        console.error('[CALL ROUTES] Stream webhook error:', err);
        set.status = 500;
        return { success: false, message: "Webhook processing error" };
      }
    },
    { parse: 'text' }
  )

  // ---- Cold-state Stream-call decline (unauthenticated; auth is the JWT) ----
  // When a user taps the Decline button on an incoming-call notification while
  // the app is in killed state, no Flutter isolate is alive to invoke
  // `call.reject()` against Stream's coordinator — so the caller stays in
  // a ringing limbo until Stream's own ring timeout fires (~20-30s) and the
  // call ends as "missed" rather than "declined". This endpoint bridges
  // that gap: the native Kotlin BroadcastReceiver fires a fire-and-forget
  // POST here with the call cid + the user's Stream JWT (cached in
  // SharedPreferences at last token-fetch). We re-sign a short-lived JWT
  // for the same user (we have the API secret) and call Stream's reject API
  // server-side, no cookie auth required.
  .post("/stream/decline-cold", async ({ set, body }) => {
    try {
      const { call_cid, user_id } = (body || {}) as { call_cid?: string; user_id?: string };
      if (!call_cid || !user_id) {
        set.status = 400;
        return { success: false, message: "call_cid and user_id are required" };
      }
      await StreamCallService.rejectCallAsUser(call_cid, user_id);
      set.status = 200;
      return { success: true };
    } catch (err) {
      console.error('[CALL ROUTES] Stream cold decline error:', err);
      set.status = 500;
      return { success: false, message: "Cold decline failed" };
    }
  })

  // ---- Unprotected routes (accessible from background handlers without auth) ----

  .get("/status/:call_id", async ({ set, params }) => {
    const [call_info] = await db.select().from(call_model).where(eq(call_model.id, params.call_id)).limit(1);

    if (!call_info) {
      set.status = 404;
      return {
        success: false,
        data: null,
        message: "Call not found"
      };
    }

    set.status = 200;
    return {
      success: true,
      data: call_info,
      message: "Call status retrieved successfully"
    };
  })

  .post("/accept/:call_id", async ({ set, params }) => {
    try {
      const callId = params.call_id;
      const [call_info] = await db.select().from(call_model).where(eq(call_model.id, callId)).limit(1);

      if (!call_info) {
        set.status = 404;
        return { success: false, message: "Call not found" };
      }

      const result = await CallService.accept_call(callId, call_info.callee_id);

      if (result.success) {
        const accept_payload = {
          call_id: callId,
          caller_id: call_info.caller_id,
          callee_id: call_info.callee_id,
          timestamp: new Date(),
          data: { success: true },
        };

        broadcast_message({
          to: "users",
          user_ids: [call_info.caller_id],
          message: { type: "call:accept", payload: accept_payload },
        });

        if (is_user_online(call_info.callee_id)) {
          await broadcast_message({
            to: "users",
            user_ids: [call_info.callee_id],
            message: { type: "call:accept", payload: accept_payload },
          });
        }

        await FCMService.send_notification({
          type: "call",
          fcm_mode: "data-only",
          user_ids: [call_info.caller_id, call_info.callee_id],
          ws_message: { type: "call:accept", payload: accept_payload },
        });
      }

      set.status = 200;
      return { success: true, message: "Call accepted successfully" };
    } catch (error) {
      console.error('[CALL ROUTES] Error accepting call:', error);
      set.status = 500;
      return { success: false, message: "Internal server error" };
    }
  })

  .post("/decline/:call_id", async ({ set, params }) => {
    try {
      const callId = params.call_id;

      // Get call info from database
      const [call_info] = await db.select().from(call_model).where(eq(call_model.id, callId)).limit(1);

      if (!call_info) {
        set.status = 404;
        return {
          success: false,
          message: "Call not found"
        };
      }

      // Decline the call using the callee_id from the call record
      const result = await CallService.terminate_call(callId, call_info.callee_id, "declined");

      if (result.success) {
        // Notify the caller about the decline via WebSocket or FCM
        // This ensures the caller gets immediate notification instead of waiting for polling
        const terminate_payload = {
          call_id: callId,
          caller_id: call_info.caller_id,
          callee_id: call_info.callee_id,
          data: {
            success: true,
            terminated_by: call_info.callee_id,
            status: result.data?.status,
            reason: "declined",
          },
          timestamp: new Date(),
        };

        if (is_user_online(call_info.caller_id)) {
          await broadcast_message({
            to: "users",
            user_ids: [call_info.caller_id],
            message: {
              type: "call:terminate",
              payload: terminate_payload,
            },
          });
        } else {
          // Caller might have gone offline - send FCM as fallback
          await FCMService.send_notification({
            type: "call",
            fcm_mode: "data-only",
            user_ids: [call_info.caller_id],
            ws_message: {
              type: "call:terminate",
              payload: terminate_payload,
            },
          });
        }
      }

      set.status = 200;
      return {
        success: true,
        message: "Call declined successfully"
      };
    } catch (error) {
      console.error('[CALL ROUTES] Error declining call:', error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error"
      };
    }
  })

  // ---- Protected routes (require authentication) ----

  .state({ id: "", role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  .get("/history", async ({ set, store, query }) => {
    try {
      const limit = Math.min(parseInt(query.limit as string) || 20, 100); // Max 100 calls

      const result = await CallService.get_call_history(store.id, limit);

      if (result.success) {
        set.status = 200;
        return {
          success: true,
          data: result.data,
          message: "Call history retrieved successfully"
        };
      } else {
        set.status = 500;
        return {
          success: false,
          message: result.error || "Failed to get call history"
        };
      }
    } catch (error) {
      console.error('[CALL ROUTES] Error getting call history:', error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error"
      };
    }
  }, {
    query: t.Object({
      limit: t.Optional(t.String())
    })
  })

  .get("/active", async ({ set, store }) => {
    try {
      const activeCall = CallService.get_user_active_call(store.id);

      set.status = 200;
      return {
        success: true,
        data: activeCall || null,
        message: activeCall ? "Active call found" : "No active call"
      };
    } catch (error) {
      console.error('[CALL ROUTES] Error getting active call:', error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error"
      };
    }
  })

  // ---- Ghost-call recovery: is there a call I can rejoin right now? ----
  // L's client hits this on app open / resume to hydrate the rejoin dot for
  // the killed-then-reopened-within-the-window case (where the WS/FCM push may
  // have been missed). Returns the newest live rejoin window where the caller
  // is the dropped party, or null.
  .get("/stream/rejoinable", async ({ set, store }) => {
    try {
      const w = StreamCallService.getRejoinFor(store.id);
      set.status = 200;
      return {
        success: true,
        data: w
          ? {
              cid: w.cid,
              peer_id: w.waiter_id,
              peer_name: w.peer_name ?? null,
              peer_pfp: w.peer_pfp ?? null,
              expires_at: new Date(w.expires_at).toISOString(),
            }
          : null,
        message: w ? "Rejoinable call found" : "No rejoinable call",
      };
    } catch (error) {
      console.error('[CALL ROUTES] Error getting rejoinable call:', error);
      set.status = 500;
      return { success: false, message: "Internal server error" };
    }
  })

  // ---- Stream Video credentials ----
  // Returns api key + a freshly minted user token. The client should call this
  // when it needs to (re)connect to Stream, and use it as the SDK tokenLoader.
  .get("/stream/credentials", async ({ set, store }) => {
    try {
      if (!StreamCallService.isConfigured()) {
        set.status = 503;
        return { success: false, message: "Stream Video is not configured on this server" };
      }

      const [me] = await db
        .select({ id: user_model.id, name: user_model.name, profile_pic: user_model.profile_pic })
        .from(user_model)
        .where(eq(user_model.id, store.id))
        .limit(1);

      if (!me) {
        set.status = 404;
        return { success: false, message: "User not found" };
      }

      const token = StreamCallService.createUserToken(me.id);

      set.status = 200;
      return {
        success: true,
        data: {
          api_key: StreamCallService.getApiKey(),
          token,
          user: { id: me.id, name: me.name, image: me.profile_pic },
        },
        message: "Stream credentials issued",
      };
    } catch (err) {
      console.error('[CALL ROUTES] Error issuing Stream credentials:', err);
      set.status = 500;
      return { success: false, message: "Failed to issue Stream credentials" };
    }
  })

  // Pre-flight gate for outgoing Stream calls. Mirrors WebRTC `initiate_call`:
  // confirms callee exists, has `call_access`, and neither side is already
  // engaged on another Stream call. The actual call is created on the client
  // via `call.getOrCreate({ ringing: true })`.
  //
  // Response shape on failure carries a stable `code` so the client can
  // pick the right UX (busy → telephony busy tone, call_access → toast,
  // etc.) without parsing English strings.
  .post("/stream/precheck", async ({ set, body, store }) => {
    try {
      const { callee_id } = body as { callee_id: string };
      if (!callee_id) {
        set.status = 400;
        return { success: false, code: "bad_request", message: "callee_id is required" };
      }

      // Self-busy: caller already has an active call. Usually prevented by
      // UI (chat row's call button is hidden while a call is up), but we
      // gate here too in case the UI race-condition slips through (e.g.
      // user taps call right as another incoming starts ringing).
      const selfBusy = StreamCallService.isUserBusy(store.id);
      if (selfBusy) {
        set.status = 409;
        return {
          success: false,
          code: "self_busy",
          message: "You're already on a call",
          data: { call_cid: selfBusy },
        };
      }

      // Callee-busy: drives the telephony-style busy tone on the caller's
      // device. 409 Conflict is the closest HTTP analogue.
      const calleeBusy = StreamCallService.isUserBusy(callee_id);
      if (calleeBusy) {
        set.status = 409;
        return {
          success: false,
          code: "busy",
          message: "Recipient is on another call",
        };
      }

      const result = await StreamCallService.assertCalleeReachable(callee_id);
      if (!result.ok) {
        set.status = result.code;
        return { success: false, code: "unreachable", message: result.message };
      }

      set.status = 200;
      return { success: true, message: "OK" };
    } catch (err) {
      console.error('[CALL ROUTES] Stream precheck error:', err);
      set.status = 500;
      return { success: false, code: "server_error", message: "Internal server error" };
    }
  }, {
    body: t.Object({ callee_id: t.String() }),
  });

// .get("/status", async ({ set, store, query }) => {
//   console.log('[CALL ROUTES] /status called with query:', query);
// })
//
// .put("/accept", async ({ set, store, body }) => {
//   console.log("--------------------------------------------------------------------")
//   console.log("--------------------------------------------------------------------")
//   console.log("body ->", body)
//   console.log("--------------------------------------------------------------------")
//   console.log("--------------------------------------------------------------------")
//   const result = await CallService.accept_call(body.calleId, store.id)
//   set.status = result.code
//   return result
// },
//   {
//     body: t.Object({
//       callID: t.Number(),
//       calleId: t.Number()
//     })
//   }
// )
//

export default call_routes;
