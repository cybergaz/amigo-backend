import { app_middleware } from "@/middleware";
import FcmService from "@/services/fcm.service";
import { LivekitService } from "@/services/livekit.service";
import { broadcast_message, is_user_online } from "@/sockets/socket.handlers";
import { ResultType } from "@/types/core.types";
import Elysia from "elysia";

const livekit_routes = new Elysia({
  prefix: "/livekit/calls",
})

  // <-----------------Unprotected routes------------------>
  // Get status of a call
  .post("/status/:call_id", async ({ set, params }): Promise<ResultType> => {
    try {
      const call_info = (await LivekitService.get_call_info(params.call_id))
        .data;

      if (!call_info) {
        set.status = 404;
        return {
          success: false,
          code: 404,
          message: "Call not found",
        };
      }

      set.status = 200;
      return {
        success: true,
        message: "Call info retrieved successfully",
        code: 200,
        data: call_info,
      };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
      };
    }
  })

  // Accept a call:
  .post("/accept/:call_id", async ({ set, params }): Promise<ResultType> => {
    try {
      const call_id = params.call_id;
      const call_info = (await LivekitService.get_call_info(call_id)).data;

      if (!call_info) {
        set.status = 404;
        return {
          success: false,
          code: 404,
          message: "Call not found",
        };
      }

      // Update the call status to accepted
      const accept_call_result = await LivekitService.accept_call(
        call_id,
        call_info.callee_id,
      );

      if (accept_call_result.success) {
        const accept_call_payload = {
          call_id,
          caller_id: call_info.caller_id,
          callee_id: call_info.callee_id,
          status: "accepted",
          accepted_at: new Date(),
          data: { success: true },
        };

        broadcast_message({
          to: "users",
          user_ids: [call_info.caller_id, call_info.callee_id],
          message: {
            type: "call:accept",
            payload: accept_call_payload,
          },
        });

        if (is_user_online(call_info.callee_id)) {
          await broadcast_message({
            to: "users",
            user_ids: [call_info.callee_id],
            message: { type: "call:accept", payload: accept_call_payload },
          });
        }

        await FcmService.send_notification({
          type: "call",
          fcm_mode: "data-only",
          user_ids: [call_info.caller_id, call_info.callee_id],
          ws_message: { type: "call:accept", payload: accept_call_payload },
        });
      }

      set.status = 200;
      return {
        success: true,
        message: "Call accepted successfully",
        code: 200,
        data: accept_call_result,
      };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
      };
    }
  })

  // decline a call:
  .post("/decline/:call_id", async ({ set, params }): Promise<ResultType> => {
    try {
      const call_id = params.call_id;
      const call_info = (await LivekitService.get_call_info(call_id)).data;

      if (!call_info) {
        set.status = 404;
        return {
          success: false,
          code: 404,
          message: "Call not found",
        };
      }

      // Update the call status to declined
      const decline_call_result = await LivekitService.terminate_call(
        call_id,
        call_info.callee_id,
        "declined",
      );

      if (decline_call_result.success) {
        const decline_call_payload = {
          call_id,
          caller_id: call_info.caller_id,
          callee_id: call_info.callee_id,
          status: "declined",
          declined_at: new Date(),
          data: {
            success: true,
            terminated_by: call_info.callee_id,
            status: decline_call_result.data?.status,
            reason: "declined",
          },
        };

        if (is_user_online(call_info.caller_id)) {
          await broadcast_message({
            to: "users",
            user_ids: [call_info.caller_id],
            message: { type: "call:terminate", payload: decline_call_payload },
          });
        } else {
          // Caller might have gone offline - send FCM as fallback
          await FcmService.send_notification({
            type: "call",
            fcm_mode: "data-only",
            user_ids: [call_info.caller_id],
            ws_message: {
              type: "call:terminate",
              payload: decline_call_payload,
            },
          });
        }
      }

      set.status = 200;
      return {
        success: true,
        message: "Call declined successfully",
        code: 200,
        data: decline_call_result,
      };
    } catch (error) {
      console.error("[CALL ROUTES] Error declining call:", error);
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
      };
    }
  })

  // <-----------------Protected routes------------------>

  .state({
    id: "",
    role: "",
  })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;

      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    },
  })

  // active calls of a user:
  .get("/active", async ({ set, store }): Promise<ResultType> => {
    try {
      const user_id = store.id;
      const active_calls =
        await LivekitService.get_active_call_by_user_id(user_id);

      set.status = 200;
      return {
        success: true,
        code: 200,
        message: "Active calls retrieved successfully",
        data: active_calls.data,
      };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
      };
    }
  });

export default livekit_routes;
