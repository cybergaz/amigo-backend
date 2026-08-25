import { app_middleware } from "@/middleware";
import FcmService from "@/services/fcm.service";
import { LivekitService } from "@/services/livekit.service";
import { broadcast_message, is_user_online } from "@/sockets/socket.handlers";
import { ResultType } from "@/types/core.types";
import {Elysia, t} from "elysia";

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
  //
  // Used by the NATIVE Android notification/Answer button, which fires before
  // (or entirely without) the Flutter engine. It has to do everything the WS
  // `call:accept` handler does — including minting the callee's LiveKit token —
  // otherwise an answer from the lock screen leaves the callee accepted on the
  // server but with no way into the room.
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

      const caller_id = call_info.caller_id;
      const callee_id = call_info.callee_id;

      const accept_call_result = await LivekitService.accept_call(
        call_id,
        callee_id,
      );

      if (!accept_call_result.success) {
        set.status = accept_call_result.code ?? 500;
        return accept_call_result;
      }

      const callee_token = await LivekitService.create_livekit_token(
        call_id,
        callee_id,
      );

      if (!callee_token.success) {
        set.status = 500;
        return {
          success: false,
          code: 500,
          message: "Failed to generate livekit token for the callee",
        };
      }

      const base_payload = {
        call_id,
        caller_id,
        callee_id,
        status: "accepted",
        accepted_at: new Date(),
        // This route is the killed-app answer path, so the callee's client may
        // never have seen `call:ringing` and may not know the call is video.
        callType: call_info.call_type === "video" ? "video" : "audio",
      };

      // Callee: the token is the whole point of this message.
      const callee_payload = {
        ...base_payload,
        data: {
          success: true,
          token: callee_token.data?.token,
          room_id: call_id,
        },
      };

      // Caller: already in the room since `call:init:ack`; just needs to know
      // the ringing is over.
      const caller_payload = {
        ...base_payload,
        data: { success: true },
      };

      // NOT gated on `is_user_online`. This is the one message that carries
      // the callee's room token, and this route is reached precisely when the
      // callee answered from a dead or backgrounded app — exactly when that
      // check says "offline" and the whole broadcast used to be skipped. Since
      // `call:accept` is not a vital event it was never queued for replay
      // either, so the token was simply lost and the callee sat on
      // "Configuring call" until the join watchdog gave up.
      // `broadcast_message` already no-ops safely for a user with no live
      // socket, and the FCM push below is the real fallback.
      await broadcast_message({
        to: "users",
        user_ids: [callee_id],
        message: { type: "call:accept", payload: callee_payload },
      });

      await broadcast_message({
        to: "users",
        user_ids: [caller_id],
        message: { type: "call:accept:ack", payload: caller_payload },
      });

      // Push fallback for whichever side isn't holding a live socket. The
      // callee is the common case here: they answered from a notification, so
      // their app may still be starting up.
      await FcmService.send_notification({
        type: "call",
        fcm_mode: "data-only",
        user_ids: [callee_id],
        ws_message: { type: "call:accept", payload: callee_payload },
      });

      if (!is_user_online(caller_id)) {
        await FcmService.send_notification({
          type: "call",
          fcm_mode: "data-only",
          user_ids: [caller_id],
          ws_message: { type: "call:accept:ack", payload: caller_payload },
        });
      }

      set.status = 200;
      return {
        success: true,
        message: "Call accepted successfully",
        code: 200,
        // Deliberately NO token in the body. This route is unauthenticated (it
        // has to be — it is called by native Android code that has no access to
        // the JWT in secure storage), so anything returned here is readable by
        // whoever can reach the endpoint with a call id. The token goes only to
        // the callee, over their authenticated socket or their FCM token, both
        // of which are addressed to the user rather than to the caller of this
        // HTTP request. The native caller ignores the body anyway.
        data: {
          call_id,
          room_id: call_id,
        },
      };
    } catch (error) {
      console.error("[CALL ROUTES] Error accepting call:", error);
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

  // End an in-progress (or outgoing, not-yet-answered) call.
  //
  // The native call screen's End/Cancel button needs a way to hang up when the
  // Flutter engine isn't running — otherwise the other party keeps ringing (or
  // sits in a dead call) until the ring cap fires. `/decline` can't serve this:
  // it always terminates as the CALLEE, which is wrong for a caller cancelling.
  //
  // Unauthenticated, matching the existing `/accept` and `/decline` routes it
  // sits beside — knowing a call's UUID is the only credential. Terminating as
  // the caller yields the right DB status either way ('ended'); only the
  // recorded `reason` is coarser than the WS path's.
  .post("/end/:call_id", async ({ set, params }): Promise<ResultType> => {
    try {
      const call_id = params.call_id;
      const call_info = (await LivekitService.get_call_info(call_id)).data;

      if (!call_info) {
        set.status = 404;
        return { success: false, code: 404, message: "Call not found" };
      }

      const caller_id = call_info.caller_id;
      const callee_id = call_info.callee_id;
      const was_answered = !!call_info.answered_at || call_info.status === "answered";

      const result = await LivekitService.terminate_call(
        call_id,
        caller_id,
        was_answered ? "caller_hungup" : "abandoned",
      );

      if (result.success) {
        const terminate_payload = {
          call_id,
          caller_id,
          callee_id,
          data: {
            success: true,
            terminated_by: caller_id,
            status: result.data?.status,
            reason: result.data?.reason,
          },
        };

        // Both ends need to hear this: the remote party to stop ringing, and
        // the local one because its Flutter side may come back to life later
        // and would otherwise restore a call that no longer exists.
        for (const id of [caller_id, callee_id]) {
          if (is_user_online(id)) {
            await broadcast_message({
              to: "users",
              user_ids: [id],
              message: { type: "call:terminate", payload: terminate_payload },
            });
          } else {
            await FcmService.send_notification({
              type: "call",
              fcm_mode: "data-only",
              user_ids: [id],
              ws_message: {
                type: "call:terminate",
                payload: terminate_payload,
              },
            });
          }
        }
      }

      set.status = 200;
      return {
        success: true,
        code: 200,
        message: "Call ended",
        data: result.data,
      };
    } catch (error) {
      console.error("[CALL ROUTES] Error ending call:", error);
      set.status = 500;
      return { success: false, code: 500, message: "Internal server error" };
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

  // Mint a room token for a call the requester is part of.
  //
  // The token normally arrives on the `call:accept` broadcast, which is
  // fire-and-forget: if the app was killed when the user answered from the
  // notification, that message is gone and there is no way back into the room.
  // This lets a (re)starting client pull a fresh one instead of waiting for a
  // replay that will never come. Also covers rejoining after a process death
  // mid-call.
  .post("/join/:call_id", async ({ set, params, store }): Promise<ResultType> => {
    try {
      const call_id = params.call_id;
      const user_id = store.id;

      const call_info = (await LivekitService.get_call_info(call_id)).data;

      if (!call_info) {
        set.status = 404;
        return { success: false, code: 404, message: "Call not found" };
      }

      if (call_info.caller_id !== user_id && call_info.callee_id !== user_id) {
        set.status = 403;
        return {
          success: false,
          code: 403,
          message: "Not a participant of this call",
        };
      }

      // A finished call has no room to hand out access to.
      const status = String(call_info.status ?? "");
      if (call_info.ended_at || ["ended", "missed", "declined"].includes(status)) {
        set.status = 409;
        return {
          success: false,
          code: 409,
          message: `Call is no longer active (${status || "ended"})`,
        };
      }

      // Joining IS answering. Without this the call can still be sitting at
      // 'initiated', and the 60s ring cap then fires mid-conversation and
      // terminates a call both parties are talking on — the recovery path
      // (killed-state accept, or the token-fetch backstop) reaches this route
      // precisely when the normal accept didn't land.
      const answered =
        !!call_info.answered_at || call_info.status === "answered";
      if (!answered && call_info.callee_id === user_id) {
        const accepted = await LivekitService.accept_call(call_id, user_id);
        if (!accepted.success) {
          console.warn(
            `[CALL ROUTES] join could not mark ${call_id} answered:`,
            accepted.message,
          );
        }
      }

      const token = await LivekitService.create_livekit_token(call_id, user_id);

      if (!token.success) {
        set.status = 500;
        return {
          success: false,
          code: 500,
          message: "Failed to generate livekit token",
        };
      }

      set.status = 200;
      return {
        success: true,
        code: 200,
        message: "Livekit token issued",
        data: {
          call_id,
          room_id: call_id,
          token: token.data?.token,
          // The recovery paths reach this route precisely when the client
          // missed `call:ringing` / `call:accept` — a killed-app answer, or
          // the token backstop. Without the call type here they would rejoin a
          // video call with the camera off and no way to know better.
          call_type: call_info.call_type === "video" ? "video" : "audio",
        },
      };
    } catch (error) {
      console.error("[CALL ROUTES] Error issuing join token:", error);
      set.status = 500;
      return { success: false, code: 500, message: "Internal server error" };
    }
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
  })


  // call-history of a user:
  .get(
    "/history",
    async ({ set, store, query }) => {
      try {
        const limit = Math.min(parseInt(query.limit as string) || 20, 100); // Max 100 calls

        const result = await LivekitService.get_call_history(store.id, limit);

        if (result.success) {
          set.status = 200;
          return {
            success: true,
            data: result.data,
            message: "Call history retrieved successfully",
          };
        } else {
          set.status = 500;
          return {
            success: false,
            message: result.error || "Failed to get call history",
          };
        }
      } catch (error) {
        console.error("[CALL ROUTES] Error getting call history:", error);
        set.status = 500;
        return {
          success: false,
          message: "Internal server error",
        };
      }
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
      }),
    },
  )

export default livekit_routes;
