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
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { call_model, livekit_call_model } from "@/models/call.model";
import {
  setActiveCallsCache,
  setUserCallCache,
  getCallKey,
  getUserCallKey,
  CALL_CACHE_TTL_SECONDS,
} from "@/cache-management/calls.cache";
import { CALL_TIMEOUT_MS } from "@/constants/calls.constants";
// import { _missedCallNotifier } from "./call.service";
import { ResultType } from "@/types/core.types";
import { livekit } from "@/config/livekit.config";
import { AccessToken, VideoGrant } from "livekit-server-sdk";
import { ConvJoinPayloadSchema } from "@/types/socket.elysia-schema";
import { k } from "@/cluster/keys";
import { deadline, rfast } from "@/cluster/redis-fast";
import { run_pg_singleton } from "@/cluster/jobs";
import { is_draining, track } from "@/cluster/lifecycle";
import { has_live_sibling } from "@/cluster/beat";
import { count } from "@/utils/counters";

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

/**
 * Does THIS worker hold a live WS for the user? Registered from
 * `socket.service.ts` (same cycle reason as above). The ring tick uses it to
 * leave a deadline to the sibling that can notify the caller over WS. Until
 * registered, every user counts as local (fire at once, as before).
 */
type CallPartyLocal = (user_id: string) => boolean;

let _call_party_is_local: CallPartyLocal = () => true;

function register_call_party_locality(fn: CallPartyLocal) {
  _call_party_is_local = fn;
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
  /// Unused since RC-1 (ring deadlines live in Redis); kept so the cache
  /// parser's shape does not change.
  timeout_timer?: NodeJS.Timeout;
}

// =============================================================================
// Ring deadlines (SYNC_V2 §13.7 F10, §13.8)
// =============================================================================
// The ring cap used to be a setTimeout in the process that started the call.
// A restart (every deploy) silently dropped every pending timer, so a call
// ringing at that moment left the DB row 'initiated' and BOTH users pinned
// "already in a call" until the 4 h cache TTL; and at N>1 only the starting
// process could ever fire or cancel it. Now:
//   - initiate_call ZADDs call_id → deadline into a Redis ZSET. If that fails
//     the call fails (and is compensated): a call nobody can time out is
//     worse than "call failed, try again";
//   - accept / terminate / timeout ZREM it;
//   - every worker ticks every 1 s, and the worker whose ZREM returns 1 runs
//     timeout_call (which re-reads the call and no-ops if it was answered or
//     already ended), so exactly one worker fires each deadline;
//   - while a ready sibling exists (deploy overlap: the new slot is ready
//     with few sockets while the old one still holds most), a worker that
//     holds neither party's WS leaves a fresh deadline alone for up to
//     RING_DEFER_MS, so the worker holding the caller's socket fires it and
//     call:terminate goes out over WS instead of FCM (which this user base
//     often never receives). Past that anyone fires it, so nothing strands;
//     with no sibling (N=1) nothing is deferred at all;
//   - a 30 s DB backstop (one worker, advisory lock) times out rows still
//     'initiated' well past the cap — it catches a lost ZSET entry (Redis
//     failover, a ZREM that won but whose worker died before timing out).
// Same cap (CALL_TIMEOUT_MS) and the same timeout_call as before, so the
// user-visible behaviour (missed call, call:terminate / call:missed) is
// unchanged; only who fires it changed.
const RING_TICK_MS = 1_000;
const RING_TICK_BATCH = 20;
const RING_REDIS_DEADLINE_MS = 500;
const RING_BACKSTOP_MS = 30_000;
// Slack past the cap before the backstop steps in, so it never races the
// 1 s tick for a call that is merely due.
const RING_BACKSTOP_GRACE_S = 10;
const RING_BACKSTOP_BATCH = 50;
// How long past its deadline a call may wait for the worker that holds one
// of its parties' WS before any worker fires it.
const RING_DEFER_MS = 5_000;
// The sibling check reads the beat keys; one beat interval of staleness is
// fine and keeps it off the 1 s tick.
const RING_SIBLING_CACHE_MS = 5_000;

// Main client on the request path: initiate already depends on it for the
// busy checks and cache writes, so this adds no new failure mode.
const schedule_ring_deadline = async (call_id: string): Promise<void> => {
  await redis.zadd(k.ring_deadline(), Date.now() + CALL_TIMEOUT_MS, call_id);
};

// Best effort: a ZREM that fails leaves the entry for the tick, whose
// timeout_call then sees an answered / ended call and does nothing.
const clear_ring_deadline = async (call_id: string): Promise<void> => {
  try {
    await redis.zrem(k.ring_deadline(), call_id);
  } catch (err: any) {
    console.error(`[CALL] ring deadline ZREM failed for ${call_id}: ${err?.message ?? err}`);
  }
};

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
          error: { reason: "self_call" },
        };
      }

      const isCallerInCall = await redis.get(getUserCallKey(caller_id));
      const isCalleeInCall = await redis.get(getUserCallKey(callee_id));

      // Split, because the caller's app has to say something different for
      // each: one is "you're already on a call", the other is "they are". The
      // old combined message could only be shown verbatim, so the app said
      // nothing at all and the call just vanished.
      if (isCallerInCall) {
        return {
          success: false,
          code: 400,
          message: "You are already in a call",
          error: { reason: "self_busy" },
        };
      }

      if (isCalleeInCall) {
        return {
          success: false,
          code: 400,
          message: "Recipient is on another call",
          error: { reason: "callee_busy" },
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
          error: { reason: "callee_not_found" },
        };
      }

      if (!callee.call_access) {
        return {
          success: false,
          code: 401,
          message: "Callee does not have call access enabled",
          error: { reason: "no_call_access" },
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
      try {
        await schedule_ring_deadline(new_call.id);
      } catch (err: any) {
        // Nothing could ever time this call out, so fail it now and release
        // both users (same compensation as a failed room creation). The
        // caller gets call:error from handle_call_init; the callee was not
        // rung yet.
        count("CALL", "ring_zadd_failed");
        console.error(
          `[CALL] ring deadline ZADD failed for ${new_call.id}, failing the call: ${err?.message ?? err}`,
        );
        await this.abandon_unscheduled_call(new_call.id);
        return {
          success: false,
          code: 500,
          message: "Error initiating call",
        };
      }

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

  // Compensation when the ring deadline could not be scheduled: release
  // both users and close the row exactly like a failed room creation does
  // (socket.service abandon_failed_call), so call history and "busy" stay
  // consistent. Best effort — the 4 h cache TTL is the last resort.
  static async abandon_unscheduled_call(call_id: string): Promise<void> {
    try {
      await this.clear_call_cache(call_id);
      await db
        .update(livekit_call_model)
        .set({ status: "ended", reason: "network_error", ended_at: new Date() })
        .where(eq(livekit_call_model.id, call_id));
    } catch (err) {
      console.error("[CALL] Failed to roll back unscheduled call", call_id, err);
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
      // console.log("calling accept call function...");
      const parsedActiveCall = (await this.get_active_call(call_id)).data;

      // console.log(
      //   "parsedActiveCall:",
      //   JSON.stringify(parsedActiveCall, null, 2),
      // );

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

      // console.log("accepting call with id:", call_id, "for user:", user_id);

      // The call is live now — the ring cap must not fire and mark it
      // missed. Removed BEFORE the writes below, so a tick that lands in
      // between finds nothing to fire.
      await clear_ring_deadline(call_id);

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
      // console.log("terminating call with id:", call_id, "by user:", user_id);

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
      // SCAN, not KEYS: KEYS walks the whole keyspace in one blocking
      // command (and the Redis is shared with dev and every cache), stalling
      // every other client for its duration.
      const stream = redis.scanStream({ match: "calls:active_calls:*", count: 500 });
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (keys.length > 0) await redis.del(...keys);
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

      // Terminate and timeout both end here: the ring deadline goes too.
      await clear_ring_deadline(call_id);

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

      // console.log(
      //   `[CALL] Cleared cache for call ID: ${call_id} (${keys_to_delete.length} keys)`,
      // );

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
      // console.log("received call id: ", call_id);
      const activeCall = await redis.hgetall(`calls:active_calls:${call_id}`);

      // console.log("[CALL] Active call fetched from cache:", activeCall);

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
      // console.log("[CALL] Fetching active call for user ID:", user_id);
      const call_id = await redis.get(`calls:user:${user_id}`);
      if (!call_id) {
        return {
          success: false,
          code: 404,
          message: "No active call found for this user",
        };
      }
      // console.log("[CALL] Found active call ID for user:", call_id);

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

  // get_all_active_calls() was removed in RC-1 (SYNC_V2 §13.7 F10): it ran
  // HGETALL on the literal key "calls:active_calls:*" (always empty) and its
  // only caller was a no-op "recovery" at boot. Ring recovery after a
  // restart is now the ZSET tick + DB backstop below.

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

      // console.log(
      //   `generated token for user ${user_id} in room ${room_id}:`,
      //   generatedToken,
      // );

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
// -----------------------------------------------------------------------------
// Ring tick (every worker) + DB backstop (one worker)
// -----------------------------------------------------------------------------
const fire_ring_timeout = async (call_id: string, source: "tick" | "backstop") => {
  const result = await LivekitService.timeout_call(call_id);
  // 404 = the call is already gone (ended by both ends, or its cache
  // expired): nothing to do, not an error.
  count("CALL", result.success ? `ring_timeout_${source}` : `ring_timeout_${source}_${result.code === 404 ? "gone" : "failed"}`);
  if (!result.success && result.code !== 404) {
    console.error(`[CALL] ring timeout (${source}) failed for ${call_id}: ${result.message}`);
  }
};

let ring_sibling_cache = { at: 0, live: false };

// Errors → false (has_live_sibling already logs): with no proof of a sibling
// we fire at once, exactly as at N=1.
const ring_has_sibling = async (now: number): Promise<boolean> => {
  if (now - ring_sibling_cache.at < RING_SIBLING_CACHE_MS) return ring_sibling_cache.live;
  const live = await has_live_sibling();
  ring_sibling_cache = { at: Date.now(), live };
  return live;
};

// Fresh deadlines whose caller and callee both have no WS here, while a
// sibling may hold them. Any failure defers nothing (fire as before).
const ring_deferred = async (
  fresh: string[],
  now: number,
): Promise<Set<string>> => {
  const out = new Set<string>();
  if (fresh.length === 0) return out;
  try {
    if (!(await ring_has_sibling(now))) return out;
    const pipe = rfast.pipeline();
    for (const call_id of fresh) pipe.hmget(getCallKey(call_id), "caller_id", "callee_id");
    const rows = (await deadline(pipe.exec(), RING_REDIS_DEADLINE_MS, "ring parties")) as
      | [Error | null, unknown][]
      | null;
    fresh.forEach((call_id, i) => {
      const [err, val] = rows?.[i] ?? [null, null];
      if (err || !Array.isArray(val)) return;
      const [caller_id, callee_id] = val as (string | null)[];
      // No cache → timeout_call would 404; let it fire and clean the entry.
      if (!caller_id && !callee_id) return;
      if (caller_id && _call_party_is_local(caller_id)) return;
      if (callee_id && _call_party_is_local(callee_id)) return;
      out.add(call_id);
    });
  } catch {
    count("CALL", "ring_defer_check_failed");
  }
  return out;
};

const ring_tick = async (): Promise<void> => {
  const key = k.ring_deadline();
  const now = Date.now();
  const raw = (await deadline(
    rfast.zrangebyscore(key, "-inf", now, "WITHSCORES", "LIMIT", 0, RING_TICK_BATCH),
    RING_REDIS_DEADLINE_MS,
    "ring tick",
  )) as string[];
  if (raw.length === 0) return;
  const due: string[] = [];
  const fresh: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    due.push(raw[i]);
    if (now - Number(raw[i + 1]) < RING_DEFER_MS) fresh.push(raw[i]);
  }
  const deferred = await ring_deferred(fresh, now);
  if (deferred.size > 0) count("CALL", "ring_deferred", deferred.size);
  await Promise.all(
    due.map(async (call_id) => {
      if (deferred.has(call_id)) return;
      // ZREM decides the owner: exactly one worker gets 1 back. A ZREM that
      // times out on our side but succeeded in Redis leaves the call to the
      // DB backstop.
      const won = await deadline(rfast.zrem(key, call_id), RING_REDIS_DEADLINE_MS, "ring zrem");
      if (won !== 1) return;
      await fire_ring_timeout(call_id, "tick");
    }),
  );
};

// Rows still 'initiated' past the cap + grace. The DB clock decides (both
// started_at and now() come from the same RDS-synced clocks on one box).
// Bounded below by the call-cache TTL: past it there is no cached call left
// for timeout_call to act on, and this keeps the scan off years of history.
// Newest first, so old orphans (a row whose cache vanished) cannot starve a
// fresh stuck call out of the batch.
const ring_backstop = async (): Promise<void> => {
  await run_pg_singleton("ring_backstop", async (tx) => {
    const overdue = await tx
      .select({ id: livekit_call_model.id })
      .from(livekit_call_model)
      .where(
        and(
          eq(livekit_call_model.status, "initiated"),
          isNull(livekit_call_model.ended_at),
          sql`${livekit_call_model.started_at} < now() - (${Math.ceil(CALL_TIMEOUT_MS / 1000) + RING_BACKSTOP_GRACE_S}::int * interval '1 second')`,
          sql`${livekit_call_model.started_at} > now() - (${CALL_CACHE_TTL_SECONDS}::int * interval '1 second')`,
        ),
      )
      .orderBy(desc(livekit_call_model.started_at))
      .limit(RING_BACKSTOP_BATCH);
    // Sequential, inside the lock: a second worker's backstop cannot fire
    // the same call's timeout (and its notifications) concurrently.
    for (const { id } of overdue) {
      await fire_ring_timeout(id, "backstop");
    }
    return overdue.length;
  });
};

/**
 * Started by server.ts boot() after the boot guard; the returned stop()
 * resolves once a tick / backstop already running has finished (the drain
 * awaits it before closing the pools).
 */
const start_ring_deadlines = (): (() => Promise<void>) => {
  let tick_running: Promise<void> | null = null;
  let backstop_running: Promise<void> | null = null;
  let last_tick_error_log_at = 0;

  const tick_timer = setInterval(() => {
    if (tick_running || is_draining()) return;
    tick_running = track(ring_tick())
      .catch((err: any) => {
        count("CALL", "ring_tick_failed");
        const now = Date.now();
        if (now - last_tick_error_log_at >= 60_000) {
          last_tick_error_log_at = now;
          console.error(`[CALL] ring tick failed: ${err?.message ?? err}`);
        }
      })
      .finally(() => {
        tick_running = null;
      });
  }, RING_TICK_MS);

  const backstop_timer = setInterval(() => {
    if (backstop_running || is_draining()) return;
    // run_pg_singleton already logs and counts failures.
    backstop_running = track(ring_backstop())
      .catch(() => { })
      .finally(() => {
        backstop_running = null;
      });
  }, RING_BACKSTOP_MS);

  return async () => {
    clearInterval(tick_timer);
    clearInterval(backstop_timer);
    await Promise.allSettled([tick_running, backstop_running]);
  };
};

export {
  ActiveCall,
  register_call_timeout_notifier,
  register_call_party_locality,
  start_ring_deadlines,
};
export type { CallTimeoutNotifier };
