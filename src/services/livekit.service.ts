import {
  CallEndReasonsType,
  CallStatusType,
  CallTypeType,
  parse_call_cache_row,
} from "@/types/call.types";
import Redis from "ioredis";
import { redis } from "@/config/redis";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { eq, or } from "drizzle-orm";
import { call_model, livekit_call_model } from "@/models/call.model";
import {
  setActiveCallsCache,
  setUserCallCache,
  getCallKey,
  getUserCallKey,
} from "@/cache-management/calls.cache";
import { CALL_TIMEOUT_MS } from "@/constants/calls.constants";
// import { _missedCallNotifier } from "./call.service";
import { ResultType } from "@/types/core.types";
import { livekit } from "@/config/livekit.config";
import { AccessToken, VideoGrant } from "livekit-server-sdk";
import { ConvJoinPayloadSchema } from "@/types/socket.elysia-schema";

/**
 * Called when a call rings past {@link CALL_TIMEOUT_MS} without being
 * answered. Registered from `socket.service.ts` (which owns broadcasting) so
 * this module doesn't have to import the socket layer and create a cycle.
 */
type CallTimeoutNotifier = (call: ActiveCall) => Promise<void> | void;

let _call_timeout_notifier: CallTimeoutNotifier | null = null;

function register_call_timeout_notifier(fn: CallTimeoutNotifier) {
  _call_timeout_notifier = fn;
}

interface ActiveCall {
  call_id: string;
  caller_id: string;
  callee_id: string;
  /// 'video' when the caller pressed the video button. Cached so the accept
  /// path can tell the callee what kind of call it is answering without
  /// trusting the client's own echo of it.
  call_type?: CallTypeType;
  started_at: Date;
  answered_at?: Date;
  ended_at?: Date;
  status: CallStatusType;
  reason?: CallEndReasonsType;
  timeout_timer?: NodeJS.Timeout;
}

/**
 * Ring-timeout handles, keyed by call id. Redis can't hold a live timer, so the
 * process that started the call owns cancelling it. A different process
 * terminating the call simply finds nothing to cancel — harmless, because
 * `timeout_call` re-reads the cache and no-ops once the call is gone.
 */
const _pending_timeouts = new Map<string, NodeJS.Timeout>();

export class LivekitService {
  // <-------------------Initiate Call------------------->
  static async initiate_call(
    caller_id: string,
    callee_id: string,
    call_type: CallTypeType = "audio",
  ): Promise<ResultType> {
    try {
      if (caller_id === callee_id) {
        return {
          success: false,
          code: 400,
          message: "You cannot call yourself",
        };
      }

      const isCallerInCall = await redis.get(getUserCallKey(caller_id));
      const isCalleeInCall = await redis.get(getUserCallKey(callee_id));

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
        call_type,
      };

      // Awaited: these throw on failure, and un-awaited they became unhandled
      // rejections AND let the ack race the cache — a `call:accept` arriving
      // before the write landed would 404 on a call that plainly exists.
      await Promise.all([
        setActiveCallsCache(active_call),
        setUserCallCache(new_call.id, caller_id),
        setUserCallCache(new_call.id, callee_id),
      ]);

      // Ring cap for an unanswered call. Without this a callee who never
      // answers (app killed, no network) leaves the DB row 'initiated' and
      // both users pinned "in a call" until the cache TTL expires hours later.
      active_call.timeout_timer = setTimeout(() => {
        this.timeout_call(new_call.id).catch((err) =>
          console.error("[CALL] timeout sweep failed:", err),
        );
      }, CALL_TIMEOUT_MS);
      // Never block process exit on a ringing call.
      active_call.timeout_timer.unref?.();
      _pending_timeouts.set(new_call.id, active_call.timeout_timer);

      return {
        success: true,
        code: 200,
        message: "Call initiated successfully",
        data: {
          call_id: new_call.id,
          callee_name: callee.name,
          call_type,
        },
      };
    } catch (error) {
      console.error("[CALL] Error initiating call:", error);
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

      // Answered before the timer fired — this is a live call, not a missed one.
      if (
        parsedActiveCall.status === "answered" ||
        parsedActiveCall.answered_at
      ) {
        return {
          success: true,
          code: 200,
          message: "Call already answered — timeout skipped",
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

      // Tell both ends before the cache disappears — the notifier needs the
      // caller/callee ids, and clearing first would strand a caller staring at
      // a "Calling…" screen forever.
      if (_call_timeout_notifier) {
        try {
          await _call_timeout_notifier(parsedActiveCall);
        } catch (err) {
          console.error("[CALL] Error notifying call timeout:", err);
        }
      }

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
      console.log("calling accept call function...");
      const parsedActiveCall = (await this.get_active_call(call_id)).data;

      console.log(
        "parsedActiveCall:",
        JSON.stringify(parsedActiveCall, null, 2),
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

      console.log("accepting call with id:", call_id, "for user:", user_id);

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

      // The call is live now — the ring cap must not fire and mark it missed.
      const ring_timer = _pending_timeouts.get(call_id);
      if (ring_timer) {
        clearTimeout(ring_timer);
        _pending_timeouts.delete(call_id);
      }

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
      console.log("terminating call with id:", call_id, "by user:", user_id);

      // The cache may already be gone (timeout swept it, or the other party
      // hung up a moment earlier). Falling back to the row keeps a second
      // terminate from 404-ing, which would suppress the relay that tells the
      // OTHER end the call is over.
      const cached = await this.get_active_call(call_id);
      let parsed_call = cached.success
        ? (parse_call_cache_row(cached.data as Record<string, string>) ??
          undefined)
        : undefined;

      let already_ended = false;

      if (!parsed_call) {
        const [row] = await db
          .select()
          .from(livekit_call_model)
          .where(eq(livekit_call_model.id, call_id))
          .limit(1);

        if (!row) {
          return {
            success: false,
            code: 404,
            message: "Call not found",
          };
        }

        parsed_call = {
          call_id: row.id,
          caller_id: row.caller_id,
          callee_id: row.callee_id,
          started_at: row.started_at,
          answered_at: row.answered_at ?? undefined,
          ended_at: row.ended_at ?? undefined,
          status: row.status as CallStatusType,
          reason: (row.reason as CallEndReasonsType) ?? undefined,
        };
        already_ended = !!row.ended_at;
      }

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

      const was_answered =
        parsed_call.status === "answered" || !!parsed_call.answered_at;

      // Answered → 'ended' whoever hangs up. Unanswered → the caller giving up
      // is 'ended' (cancelled) and the callee refusing is 'declined' — EXCEPT
      // when the reason is a ring timeout, which is a missed call on both
      // sides. Without that carve-out a caller whose client gives up at 30s
      // recorded a normal 'ended' call and the callee got no missed-call entry.
      const status = was_answered
        ? "ended"
        : reason === "timeout"
          ? "missed"
          : parsed_call.caller_id === user_id
            ? "ended"
            : "declined";

      await this.clear_call_cache(call_id);

      // Tear the room down so neither side is left publishing into it. This is
      // BEST EFFORT on purpose: LiveKit 404s when the room or participant is
      // already gone (very common — the hanging-up client usually disconnects
      // first), and failing the whole termination on that used to swallow the
      // `call:terminate` relay and leave the other party ringing forever.
      const room_closed = await this.close_livekit_room(call_id);
      if (!room_closed.success) {
        console.warn(
          `[CALL] Room teardown for ${call_id} was not clean (continuing):`,
          room_closed.message,
        );
      }

      const ended_at = new Date();

      const duration_seconds = was_answered
        ? Math.max(
          0,
          Math.floor(
            (ended_at.getTime() -
              new Date(
                parsed_call.answered_at ?? parsed_call.started_at,
              ).getTime()) /
            1000,
          ),
        )
        : 0;

      // Don't rewrite a call that already has a terminal state — the first
      // hangup wins, so a late duplicate can't turn an 'ended' call 'declined'.
      if (!already_ended) {
        await db
          .update(livekit_call_model)
          .set({
            status: status,
            reason: reason,
            ended_at,
            duration_seconds,
          })
          .where(eq(livekit_call_model.id, call_id));
      }

      return {
        success: true,
        code: 200,
        message: "Call terminated",
        data: {
          status,
          reason,
          duration_seconds,
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
      // The row is a Redis HASH (written with `hset`). This used to read it
      // with `get` + `JSON.parse`, which raises WRONGTYPE on every call — so
      // the cache was NEVER cleared and both participants stayed pinned
      // "already in a call" for good after their first call.
      const raw = await redis.hgetall(getCallKey(call_id));
      const parsedActiveCall = parse_call_cache_row(
        raw as Record<string, string>,
      );

      // Cancel the ring timer if this process is the one holding it.
      const timer = _pending_timeouts.get(call_id);
      if (timer) {
        clearTimeout(timer);
        _pending_timeouts.delete(call_id);
      }

      // Always drop the call key. The per-user keys need the participant ids,
      // which only the cached row has; if it's already gone, fall back to the
      // database so a half-cleared call can't leave someone marked busy.
      const keys_to_delete: string[] = [getCallKey(call_id)];

      let caller_id = parsedActiveCall?.caller_id;
      let callee_id = parsedActiveCall?.callee_id;

      if (!caller_id || !callee_id) {
        const [row] = await db
          .select({
            caller_id: livekit_call_model.caller_id,
            callee_id: livekit_call_model.callee_id,
          })
          .from(livekit_call_model)
          .where(eq(livekit_call_model.id, call_id))
          .limit(1);
        caller_id = caller_id || row?.caller_id;
        callee_id = callee_id || row?.callee_id;
      }

      // Only release a user if they are still pointed at THIS call — a later
      // call of theirs must not be cancelled by a late cleanup of an old one.
      for (const user_id of [caller_id, callee_id]) {
        if (!user_id) continue;
        const user_key = getUserCallKey(user_id);
        const current = await redis.get(user_key);
        if (current === call_id) keys_to_delete.push(user_key);
      }

      await redis.del(...keys_to_delete);

      console.log(
        `[CALL] Cleared cache for call ID: ${call_id} (${keys_to_delete.length} keys)`,
      );

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
      console.log("received call id: ", call_id);
      const activeCall = await redis.hgetall(`calls:active_calls:${call_id}`);

      console.log("[CALL] Active call fetched from cache:", activeCall);

      // const parsedActiveCall = parse_call_cache_row(
      //   activeCall as Record<string, string>,
      // );

      // console.log("Parsed Active call fetched from cache:");
      // console.log(JSON.stringify(parsedActiveCall, null, 2));

      // if (!parsedActiveCall) {
      //   return {
      //     success: false,
      //     code: 404,
      //     message: "Active call not found",
      //   };
      // }

      // `hgetall` answers with {} for a missing key. Reporting that as a
      // success made every caller (`get_call_info`, `accept_call`,
      // `handle_call_termination`) treat a vanished call as a live one, and
      // stopped `get_call_info` from ever falling back to the database.
      if (!activeCall || Object.keys(activeCall).length === 0) {
        return {
          success: false,
          code: 404,
          message: "Active call not found in cache",
        };
      }

      return {
        success: true,
        code: 200,
        message: "Call fetched successfully from cache",
        data: activeCall,
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
      console.log("[CALL] Fetching active call for user ID:", user_id);
      const call_id = await redis.get(`calls:user:${user_id}`);
      if (!call_id) {
        return {
          success: false,
          code: 404,
          message: "No active call found for this user",
        };
      }
      console.log("[CALL] Found active call ID for user:", call_id);

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

  // <--------------------Get Acitve calls----------------------------->
  static async get_all_active_calls(): Promise<ResultType> {
    try {
      const activeCalls = await redis.hgetall(`calls:active_calls:*`);

      // console.log( `active calls fetched from cache : ${JSON.stringify(activeCalls)}`);

      return {
        success: true,
        code: 200,
        message: "Calls fetched successfully from cache",
        data: activeCalls,
      };

    } catch (error) {
      console.error("[CALL] Error fetching active calls:", error);
      return {
        success: false,
        code: 500,
        message: "Error fetching active calls",
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


  // -----------------------------------LIVEKIT SDK SERVICES--------------------------------
  // 1. Create a livekit room:
  static async create_livekit_room(
    room_id: string,
  ): Promise<ResultType> {
    try {
      const room = await livekit.room.createRoom({
        name: room_id,
        maxParticipants: 2, // keeping it peer to peer for now, can be changed later
      });

      return {
        success: true,
        code: 200,
        message: "Livekit room created successfully",
        data: room,
      };
    } catch (error) {
      console.error("[LIVEKIT] Error creating room:", error);
      return {
        success: false,
        code: 500,
        message: "Error creating livekit room",
        error,
      };
    }
  }

  // 2. Create token for a livekit room:
  static async create_livekit_token(
    room_id: string,
    user_id: string,
  ): Promise<ResultType> {
    try {
      const token = new AccessToken(
        process.env.LIVEKIT_API_KEY as string,
        process.env.LIVEKIT_API_SECRET as string,
        {
          identity: user_id,
        },
      );

      const videoGrant: VideoGrant = {
        room: room_id,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      };

      token.addGrant(videoGrant);

      const generatedToken = await token.toJwt();

      console.log(
        `generated token for user ${user_id} in room ${room_id}:`,
        generatedToken,
      );

      return {
        success: true,
        code: 200,
        message: "Livekit token created successfully",
        data: {
          token: generatedToken,
        },
      };
    } catch (error) {
      console.error("[LIVEKIT] Error creating token:", error);
      return {
        success: false,
        code: 500,
        message: "Error creating livekit token",
        error,
      };
    }
  }

  // 3. Remove participant from a livekit room:
  static async remove_participant_from_livekit_room(
    room_id: string,
    participant_identity: string,
  ): Promise<ResultType> {
    try {
      await livekit.room.removeParticipant(room_id, participant_identity);

      return {
        success: true,
        code: 200,
        message: "Participant removed from livekit room successfully",
      };
    } catch (error) {
      console.error("[LIVEKIT] Error removing participant from room:", error);
      return {
        success: false,
        code: 500,
        message: "Error removing participant from livekit room",
        error,
      };
    }

    // Joining the room is done from client side using the token generated above.
  }

  // 4. Close a livekit room, evicting whoever is still in it.
  //
  // Deleting the room is the right teardown for a 1:1 call — it drops both
  // participants in one request instead of two, and it succeeds even if one of
  // them already disconnected on their own. Treated as best effort: LiveKit
  // returns 404 for a room that never got created (nobody ever joined) and
  // that is a perfectly normal way for a cancelled call to end.
  static async close_livekit_room(room_id: string): Promise<ResultType> {
    try {
      await livekit.room.deleteRoom(room_id);
      return {
        success: true,
        code: 200,
        message: "Livekit room closed",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[LIVEKIT] Could not close room ${room_id}: ${message}`);
      return {
        success: false,
        code: 500,
        message,
        error,
      };
    }
  }
}
export { ActiveCall, register_call_timeout_notifier };
export type { CallTimeoutNotifier };
