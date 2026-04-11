import { Elysia, t } from "elysia";
import { CallService } from "@/services/call.service";
import { app_middleware } from "@/middleware";
import db from "@/config/db";
import { eq } from "drizzle-orm";
import { call_model } from "@/models/call.model";
import { broadcast_message, is_user_online } from "@/sockets/socket.handlers";
import FCMService from "@/services/fcm.service";

const call_routes = new Elysia({ prefix: "/call" })

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
