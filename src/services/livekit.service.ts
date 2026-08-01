import {
  CallEndReasonsType,
  CallStatusType,
  parse_call_cache_row,
} from "@/types/call.types";
import Redis from "ioredis";
import { redis } from "@/config/redis";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { eq, or } from "drizzle-orm";
import { livekit_call_model } from "@/models/call.model";
import {
  setActiveCallsCache,
  setUserCallCache,
} from "@/cache-management/calls.cache";
import { CALL_TIMEOUT_MS } from "@/constants/calls.constants";
// import { _missedCallNotifier } from "./call.service";
import { ResultType } from "@/types/core.types";

interface ActiveCall {
  call_id: string;
  caller_id: string;
  callee_id: string;
  started_at: Date;
  answered_at?: Date;
  ended_at?: Date;
  status: CallStatusType;
  reason?: CallEndReasonsType;
  timeout_timer?: NodeJS.Timeout;
}

export class LivekitService {
  // <-------------------Initiate Call------------------->
  static async initiate_call(
    caller_id: string,
    callee_id: string,
  ): Promise<ResultType> {
    try {
      const isCallerInCall = await redis.get(`calls:user:${caller_id}`);
      const isCalleeInCall = await redis.get(`calls:user:${callee_id}`);

      if (isCallerInCall || isCalleeInCall) {
        return {
          success: false,
          code: 400,
          message: "Either caller or callee is already in a call.",
        };
      }

      // check if callee exists and has call access enabled
      const [callee] = await db
        .select({ call_access: user_model.call_access, name: user_model.name })
        .from(user_model)
        .where(eq(user_model.id, callee_id))
        .limit(1);

      if (!callee) {
        return {
          success: false,
          code: 404,
          message: "Callee not found",
        };
      }

      if (!callee.call_access) {
        return {
          success: false,
          code: 401,
          message: "Callee does not have call access enabled",
        };
      }

      // create new call in db:
      const [new_call] = await db
        .insert(livekit_call_model)
        .values({
          caller_id,
          callee_id,
          status: "initiated",
          started_at: new Date(),
        })
        .returning();

      if (!new_call) {
        return {
          success: false,
          code: 500,
          message: "Failed to create new call",
        };
      }

      // set active call in redis cache
      const active_call: ActiveCall = {
        call_id: new_call.id,
        caller_id,
        callee_id,
        started_at: new_call.started_at,
        status: new_call.status as CallStatusType,
      };

      setActiveCallsCache(active_call);
      setUserCallCache(caller_id, new_call.id);
      setUserCallCache(callee_id, new_call.id);

      // Set timeout for unanswered calls
      active_call.timeout_timer = setTimeout(async () => {
        // await this.timeout_call(new_call.id);
      }, CALL_TIMEOUT_MS);

      return {
        success: true,
        code: 200,
        message: "Call initiated successfully",
        data: {
          call_id: new_call.id,
          callee_name: callee.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        code: 500,
        message: "Error initiating call",
        error,
      };
    }
  }

  // <-------------------Timeout Call------------------->
  static async timeout_call(call_id: string): Promise<ResultType> {
    try {
      const activeCall = await redis.hgetall(`calls:active_calls:${call_id}`);

      const parsedActiveCall = parse_call_cache_row(
        activeCall as Record<string, string>,
      );

      if (!parsedActiveCall) {
        return {
          success: false,
          code: 404,
          message: "Active call not found",
        };
      }

      // Update call status to 'missed' in the database
      await db
        .update(livekit_call_model)
        .set({
          status: "missed",
          reason: "timeout",
          ended_at: new Date(),
        })
        .where(eq(livekit_call_model.id, call_id));

      // Notify callee of missed call (via WS if online, always via FCM)
      // TODO: enable this to notify missed call when callee is online and has seen the call notification
      // if (_missedCallNotifier) {
      //   await _missedCallNotifier(
      //     parsedActiveCall.callee_id,
      //     call_id,
      //     parsedActiveCall.caller_id,
      //   ).catch((err) => {
      //     console.error("[CALL] Error sending missed-call notification:", err);
      //   });
      // }

      await this.clear_call_cache(call_id);

      return {
        success: true,
        message: "Call timed out and marked as missed",
        code: 200,
        data: {
          duration_seconds:
            Math.floor(
              new Date().getTime() -
                new Date(parsedActiveCall.started_at).getTime(),
            ) / 1000,
          reason: "timeout",
        },
      };
    } catch (error) {
      return {
        success: false,
        code: 500,
        message: "Error timing out call",
        error,
      };
    }
  }

  // <-------------------Accept Call--------------------->
  static async accept_call(
    call_id: string,
    user_id: string,
  ): Promise<ResultType> {
    try {
      const activeCall = await redis.get(`calls:active_calls:${call_id}`);

      const parsedActiveCall = parse_call_cache_row(
        activeCall ? JSON.parse(activeCall) : null,
      );

      if (!parsedActiveCall) {
        return {
          success: false,
          code: 404,
          message: "Active call not found",
        };
      }

      if (parsedActiveCall.callee_id !== user_id) {
        return {
          success: false,
          code: 403,
          message: "User is not the callee of this call",
        };
      }

      // Update call status to 'answered' in the database
      await db
        .update(livekit_call_model)
        .set({
          status: "answered",
          answered_at: new Date(),
        })
        .where(eq(livekit_call_model.id, call_id));

      // Update the active call in Redis cache
      parsedActiveCall.status = "answered";
      parsedActiveCall.answered_at = new Date();
      await setActiveCallsCache(parsedActiveCall);

      return {
        success: true,
        message: "Call accepted",
        code: 200,
        data: {
          call_id,
        },
      };
    } catch (error) {
      console.error("[CALL] Error accepting call:", error);
      return {
        success: false,
        code: 500,
        message: "Error accepting call",
        error,
      };
    }
  }

  // <-------------------Terminate Call------------------->
  static async terminate_call(
    call_id: string,
    user_id: string,
    reason: CallEndReasonsType,
  ): Promise<ResultType> {
    try {
      const active_call = await this.get_active_call(call_id);

      if (!active_call.success) {
        return {
          success: false,
          code: 404,
          message: "Active call not found",
        };
      }

      const parsed_call = active_call.data as ActiveCall;

      if (
        parsed_call.callee_id !== user_id &&
        parsed_call.caller_id !== user_id
      ) {
        return {
          success: false,
          code: 403,
          message: "User is not the callee or caller of this call",
        };
      }

      // Determine status based on call state and who is terminating
      // If the call was answered, it's always 'ended' (hangup by either party)
      // If the call was NOT answered: caller terminating = 'ended' (cancelled), callee terminating = 'declined'
      const status =
        parsed_call.status === "answered"
          ? "ended"
          : parsed_call.caller_id === user_id
            ? "ended"
            : "declined";

      await this.clear_call_cache(call_id);

      // Update call status in the database
      await db
        .update(livekit_call_model)
        .set({
          status: status,
          reason: reason,
          ended_at: new Date(),
        })
        .where(eq(livekit_call_model.id, call_id));

      // Clear the call cache
      await this.clear_call_cache(call_id);

      return {
        success: true,
        code: 200,
        message: "Call terminated",
        data: {
          reason,
          duration_seconds: Math.floor(
            new Date().getTime() -
              new Date(parsed_call.started_at).getTime() / 1000,
          ),
        },
      };
    } catch (error) {
      console.error("[CALL] Error terminating call:", error);
      return {
        success: false,
        code: 500,
        message: "Error terminating call",
        error,
      };
    }
  }

  // <-------------------Clear all active calls cache------------------->
  static async clear_calls_cache(): Promise<ResultType> {
    try {
      const keys = await redis.keys("calls:active_calls:*");
      if (keys.length > 0) {
        await redis.del(...keys);
      }

      return {
        success: true,
        code: 200,
        message: "All active calls cache cleared successfully",
      };
    } catch (error) {
      console.error("[CALL] Error clearing calls cache:", error);
      return {
        success: false,
        code: 500,
        message: "Error clearing calls cache",
        error,
      };
    }
  }

  // <-------------------Clear one active call cache------------------->
  static async clear_call_cache(call_id: string): Promise<ResultType> {
    try {
      const activeCall = await redis.get(`calls:active_calls:${call_id}`);

      const parsedActiveCall = parse_call_cache_row(
        activeCall ? JSON.parse(activeCall) : null,
      );

      if (!parsedActiveCall) {
        return {
          success: false,
          code: 404,
          message: "Active call not found",
        };
      }

      if (parsedActiveCall.timeout_timer) {
        clearTimeout(parsedActiveCall.timeout_timer);
      }

      // Remove call from Redis cache
      await redis.del(`calls:active_calls:${call_id}`);
      await redis.del(`calls:user:${parsedActiveCall.caller_id}`);
      await redis.del(`calls:user:${parsedActiveCall.callee_id}`);

      return {
        success: true,
        code: 200,
        message: "Call cache cleared successfully",
      };
    } catch (error) {
      console.error("[CALL] Error clearing call cache:", error);
      return {
        success: false,
        code: 500,
        message: "Error clearing call cache",
        error,
      };
    }
  }

  // <-------------------Get Active Call------------------->
  static async get_active_call(call_id: string): Promise<ResultType> {
    try {
      const activeCall = await redis.get(`calls:active_calls:${call_id}`);

      const parsedActiveCall = parse_call_cache_row(
        activeCall ? JSON.parse(activeCall) : null,
      );

      if (!parsedActiveCall) {
        return {
          success: false,
          code: 404,
          message: "Active call not found",
        };
      }

      return {
        success: true,
        code: 200,
        message: "Call fetched successfully from cache",
        data: parsedActiveCall,
      };
    } catch (error) {
      console.error("[CALL] Error fetching active call:", error);
      return {
        success: false,
        code: 500,
        message: "Error fetching active call",
        error,
      };
    }
  }

  // <-------------------Get Active Call By User ID------------------->
  static async get_active_call_by_user_id(
    user_id: string,
  ): Promise<ResultType> {
    try {
      const call_id = await redis.get(`calls:user:${user_id}`);
      if (!call_id) {
        return {
          success: false,
          code: 404,
          message: "No active call found for this user",
        };
      }

      return await this.get_active_call(call_id);
    } catch (error) {
      console.error("[CALL] Error fetching active call by user ID:", error);
      return {
        success: false,
        code: 500,
        message: "Error fetching active call by user ID",
        error,
      };
    }
  }

  // <-------------------Get a call info----------------------------->
  static async get_call_info(call_id: string): Promise<ResultType> {
    try {
      const call_info = await this.get_active_call(call_id);
      if (call_info.success) {
        return call_info;
      }

      // get from db if not found in cache
      const [call_data] = await db
        .select()
        .from(livekit_call_model)
        .where(eq(livekit_call_model.id, call_id))
        .limit(1);

      if (!call_data) {
        return {
          success: false,
          code: 404,
          message: "Call not found",
        };
      }

      return {
        success: true,
        code: 200,
        message: "Call info fetched from database",
        data: call_data,
      };
    } catch (error) {
      console.error("[CALL] Error fetching call info:", error);
      return {
        success: false,
        code: 500,
        message: "Error fetching call info",
        error,
      };
    }
  }
}

export { ActiveCall };
