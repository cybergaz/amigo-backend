import db from '@/config/db';
import { call_model } from '@/models/call.model';
import { user_model } from '@/models/user.model';
import { CallSignalingMessage, CallInitPayload, CallEndPayload } from '@/types/call.types';
import { eq, and, desc, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

// Active calls management
interface ActiveCall {
  id: number;
  caller_id: number;
  callee_id: number;
  status: 'initiated' | 'ringing' | 'answered';
  started_at: Date;
  timeout_timer?: NodeJS.Timeout;
}

const active_calls = new Map<number, ActiveCall>();
const user_calls = new Map<number, number>(); // user_id -> call_id

export class CallService {

  // Initialize a new call
  static async initiate_call(caller_id: number, callee_id: number, payload: CallInitPayload) {
    try {
      // Check if either user is already in a call
      if (user_calls.has(caller_id) || user_calls.has(callee_id)) {
        return {
          success: false,
          error: 'User is already in a call',
          code: 'USER_BUSY'
        };
      }

      // Check if callee has call access enabled
      const [callee] = await db
        .select({ call_access: user_model.call_access, name: user_model.name })
        .from(user_model)
        .where(eq(user_model.id, callee_id))
        .limit(1);

      // console.log(`[CALL] Callee ${callee_id} found: ${!!callee}, call_access: ${callee?.call_access}`);

      if (!callee) {
        return {
          success: false,
          error: 'User not found',
          code: 'USER_NOT_FOUND'
        };
      }

      if (!callee.call_access) {
        return {
          success: false,
          error: 'User does not have call access enabled',
          code: 'CALL_ACCESS_DISABLED'
        };
      }

      // Create call record in database
      const [new_call] = await db
        .insert(call_model)
        .values({
          caller_id,
          callee_id,
          status: 'initiated',
          started_at: new Date()
        })
        .returning();

      // Add to active calls
      const active_call: ActiveCall = {
        id: new_call.id,
        caller_id,
        callee_id,
        status: 'initiated',
        started_at: new Date()
      };

      active_calls.set(new_call.id, active_call);
      user_calls.set(caller_id, new_call.id);
      user_calls.set(callee_id, new_call.id);

      // Set 30 second timeout for missed call
      active_call.timeout_timer = setTimeout(async () => {
        await this.timeout_call(new_call.id);
      }, 30000);

      // console.log(`[CALL] Call initiated: ${new_call.id} from ${caller_id} to ${callee_id}`);

      return {
        success: true,
        data: {
          callId: new_call.id,
          calleeName: callee.name
        }
      };
    } catch (error) {
      console.error('[CALL] Error initiating call:', error);
      return {
        success: false,
        error: 'Failed to initiate call'
      };
    }
  }

  // Accept a call
  static async accept_call(call_id: number, user_id: number) {
    try {
      const active_call = active_calls.get(call_id);
      if (!active_call) {
        return { success: false, error: 'Call not found' };
      }

      // Only callee can accept
      if (active_call.callee_id !== user_id) {
        return { success: false, error: 'Unauthorized to accept this call' };
      }

      // Clear timeout
      if (active_call.timeout_timer) {
        clearTimeout(active_call.timeout_timer);
      }

      // Update call status
      active_call.status = 'answered';

      // Update database
      await db
        .update(call_model)
        .set({
          status: 'answered',
          answered_at: new Date()
        })
        .where(eq(call_model.id, call_id));

      // console.log(`[CALL] Call accepted: ${call_id}`);

      return { success: true, code: 200 };
    } catch (error) {
      console.error('[CALL] Error accepting call:', error);
      return { success: false, code: 500, error: 'Failed to accept call' };
    }
  }

  // Decline a call
  static async decline_call(call_id: number, user_id: number, reason?: string) {
    try {
      const active_call = active_calls.get(call_id);
      if (!active_call) {
        return { success: false, error: 'Call not found' };
      }

      // Only callee can decline
      if (active_call.callee_id !== user_id) {
        return { success: false, error: 'Unauthorized to decline this call' };
      }

      // Clear timeout
      if (active_call.timeout_timer) {
        clearTimeout(active_call.timeout_timer);
      }

      // Update database
      await db
        .update(call_model)
        .set({
          status: 'declined',
          ended_at: new Date(),
          reason
        })
        .where(eq(call_model.id, call_id));

      // Remove from active calls
      this.cleanup_call(call_id);

      // console.log(`[CALL] Call declined: ${call_id}`);

      return { success: true };
    } catch (error) {
      console.error('[CALL] Error declining call:', error);
      return { success: false, error: 'Failed to decline call' };
    }
  }

  // End a call
  static async end_call(call_id: number, user_id: number, reason?: string) {
    try {
      const active_call = active_calls.get(call_id);
      if (!active_call) {
        return { success: false, error: 'Call not found' };
      }

      // Either caller or callee can end
      if (active_call.caller_id !== user_id && active_call.callee_id !== user_id) {
        return { success: false, error: 'Unauthorized to end this call' };
      }

      // Clear timeout
      if (active_call.timeout_timer) {
        clearTimeout(active_call.timeout_timer);
      }

      // Calculate duration if call was answered
      let duration_seconds = 0;
      if (active_call.status === 'answered') {
        const [call_data] = await db
          .select({ answered_at: call_model.answered_at })
          .from(call_model)
          .where(eq(call_model.id, call_id))
          .limit(1);

        if (call_data?.answered_at) {
          duration_seconds = Math.floor((new Date().getTime() - call_data.answered_at.getTime()) / 1000);
        }
      }

      // Update database
      await db
        .update(call_model)
        .set({
          status: 'ended',
          ended_at: new Date(),
          duration_seconds,
          reason
        })
        .where(eq(call_model.id, call_id));

      // Remove from active calls
      this.cleanup_call(call_id);

      // console.log(`[CALL] Call ended: ${call_id}, duration: ${duration_seconds}s`);

      return {
        success: true,
        data: { duration_seconds }
      };
    } catch (error) {
      console.error('[CALL] Error ending call:', error);
      return { success: false, error: 'Failed to end call' };
    }
  }

  // Handle call timeout (missed call)
  static async timeout_call(call_id: number) {
    try {
      const active_call = active_calls.get(call_id);
      if (!active_call) return;

      // Update database
      await db
        .update(call_model)
        .set({
          status: 'missed',
          ended_at: new Date(),
          reason: 'timeout'
        })
        .where(eq(call_model.id, call_id));

      // Remove from active calls
      this.cleanup_call(call_id);

      // console.log(`[CALL] Call timed out: ${call_id}`);

      return { success: true };
    } catch (error) {
      console.error('[CALL] Error timing out call:', error);
    }
  }

  // Clean up call data
  static cleanup_call(call_id: number) {
    const active_call = active_calls.get(call_id);
    if (active_call) {
      user_calls.delete(active_call.caller_id);
      user_calls.delete(active_call.callee_id);
      active_calls.delete(call_id);

      if (active_call.timeout_timer) {
        clearTimeout(active_call.timeout_timer);
      }
    }
  }

  // Get active call for user
  static get_user_active_call(user_id: number): ActiveCall | null {
    const call_id = user_calls.get(user_id);
    return call_id ? active_calls.get(call_id) || null : null;
  }

  // Get call history for user
  static async get_call_history(user_id: number, limit: number = 50) {
    try {
      const caller = alias(user_model, 'caller');
      const callee = alias(user_model, 'callee');

      const calls = await db
        .select({
          id: call_model.id,
          caller_id: call_model.caller_id,
          callee_id: call_model.callee_id,
          status: call_model.status,
          duration_seconds: call_model.duration_seconds,
          started_at: call_model.started_at,
          answered_at: call_model.answered_at,
          ended_at: call_model.ended_at,
          reason: call_model.reason,
          // Contact info (the other person in the call)
          contact_id: sql`CASE 
            WHEN ${call_model.caller_id} = ${user_id} THEN ${call_model.callee_id}
            ELSE ${call_model.caller_id}
          END`.as('contact_id'),
          contact_name: sql`CASE 
            WHEN ${call_model.caller_id} = ${user_id} THEN ${callee.name}
            ELSE ${caller.name}
          END`.as('contact_name'),
          contact_profile_pic: sql`CASE 
            WHEN ${call_model.caller_id} = ${user_id} THEN ${callee.profile_pic}
            ELSE ${caller.profile_pic}
          END`.as('contact_profile_pic'),
          // Call direction
          call_type: sql`CASE 
            WHEN ${call_model.caller_id} = ${user_id} THEN 'outgoing'
            ELSE 'incoming'
          END`.as('call_type')
        })
        .from(call_model)
        .leftJoin(caller, eq(call_model.caller_id, caller.id))
        .leftJoin(callee, eq(call_model.callee_id, callee.id))
        .where(
          or(
            eq(call_model.caller_id, user_id),
            eq(call_model.callee_id, user_id)
          )
        )
        .orderBy(desc(call_model.created_at))
        .limit(limit);

      return { success: true, data: calls };
    } catch (error) {
      console.error('[CALL] Error getting call history:', error);
      return { success: false, error: 'Failed to get call history' };
    }
  }
}

// Export active calls for WebSocket handlers
export { active_calls, user_calls };
