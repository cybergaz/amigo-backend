import jwt from 'jsonwebtoken';
import db from '@/config/db';
import { call_model } from '@/models/call.model';
import { user_model } from '@/models/user.model';
import { eq, and, sql } from 'drizzle-orm';
import { CallEndReasonsType, CallStatusType } from '@/types/call.types';
import FCMService from '@/services/fcm.service';

/**
 * Stream Video integration.
 *
 * Coexists with the in-house WebRTC `CallService`. The frontend chooses which
 * provider to use; this module is invoked only when Stream is selected.
 *
 * Required env vars (see README/setup notes):
 *   - STREAM_API_KEY     Stream Video application key
 *   - STREAM_API_SECRET  Stream Video application secret (used to sign JWTs)
 *   - STREAM_WEBHOOK_SECRET  Optional shared secret to validate webhook calls
 *
 * Stream user tokens are HS256 JWTs signed with the API secret — no extra
 * dependency is needed beyond the `jsonwebtoken` package already in use.
 */

const STREAM_API_KEY = process.env.STREAM_API_KEY || '';
const STREAM_API_SECRET = process.env.STREAM_API_SECRET || '';
const STREAM_WEBHOOK_SECRET = process.env.STREAM_WEBHOOK_SECRET || '';

// 7-day token TTL (long-lived; the SDK refreshes on demand via tokenLoader).
const STREAM_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export class StreamCallService {

  static isConfigured(): boolean {
    return Boolean(STREAM_API_KEY && STREAM_API_SECRET);
  }

  static getApiKey(): string {
    return STREAM_API_KEY;
  }

  /**
   * Mint a Stream Video user token for the given user id.
   * Token is a standard HS256 JWT with `user_id` claim.
   */
  static createUserToken(userId: string, ttlSeconds: number = STREAM_TOKEN_TTL_SECONDS): string {
    if (!this.isConfigured()) {
      throw new Error('Stream Video is not configured (STREAM_API_KEY / STREAM_API_SECRET missing)');
    }
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        user_id: userId,
        iat: now,
        exp: now + ttlSeconds,
      },
      STREAM_API_SECRET,
      { algorithm: 'HS256' }
    );
  }

  /**
   * Validate the X-Webhook-Signature header (if STREAM_WEBHOOK_SECRET set).
   * Stream signs webhooks with HMAC-SHA256 of the raw body using the secret.
   */
  static verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!STREAM_WEBHOOK_SECRET) return true; // not enforced if no secret configured
    if (!signature) return false;
    try {
      const crypto = require('node:crypto');
      const expected = crypto
        .createHmac('sha256', STREAM_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  /**
   * Persist a Stream call into our `calls` table so it shows up in the
   * unified call history alongside WebRTC calls.
   *
   * Uses `provider_call_id` (the Stream `call.cid`) as an idempotency key —
   * repeated webhook deliveries update the existing row instead of inserting.
   */
  static async upsertCallFromWebhook(args: {
    cid: string;                       // e.g. "default:<uuid>"
    callerId: string;
    calleeId: string;
    status: CallStatusType;
    reason?: CallEndReasonsType;
    startedAt?: Date;
    answeredAt?: Date;
    endedAt?: Date;
    durationSeconds?: number;
  }) {
    const existing = await db
      .select({ id: call_model.id })
      .from(call_model)
      .where(eq(call_model.provider_call_id, args.cid))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(call_model).values({
        caller_id: args.callerId,
        callee_id: args.calleeId,
        provider: 'stream',
        provider_call_id: args.cid,
        status: args.status,
        reason: args.reason,
        started_at: args.startedAt ?? new Date(),
        answered_at: args.answeredAt,
        ended_at: args.endedAt,
        duration_seconds: args.durationSeconds ?? 0,
      });
    } else {
      await db
        .update(call_model)
        .set({
          status: args.status,
          reason: args.reason,
          answered_at: args.answeredAt,
          ended_at: args.endedAt,
          duration_seconds: args.durationSeconds ?? 0,
        })
        .where(eq(call_model.provider_call_id, args.cid));
    }
  }

  /**
   * Translate a Stream webhook event payload into our call-row update.
   * Returns true if the event was handled.
   *
   * Common Stream events we care about (see Stream Video webhook docs):
   *   - call.ring         outgoing ring started
   *   - call.accepted     callee answered
   *   - call.rejected     callee declined
   *   - call.ended        call finished (any side hung up / timed out)
   *   - call.session_ended  alias for call ended (newer SDKs emit this)
   *   - call.missed       ring timed out without answer
   */
  static async handleWebhookEvent(event: any): Promise<boolean> {
    try {
      const type: string = event?.type ?? '';
      const call = event?.call ?? {};
      const cid: string = call?.cid ?? '';
      if (!cid) return false;

      // Caller is the call creator; callee is the first non-creator member.
      const createdById: string | undefined =
        call?.created_by?.id ?? event?.user?.id;
      const memberIds: string[] = Array.isArray(call?.members)
        ? call.members.map((m: any) => m?.user_id ?? m?.user?.id).filter(Boolean)
        : [];
      const calleeId = memberIds.find(id => id && id !== createdById);

      if (!createdById || !calleeId) {
        // Cannot identify both sides — skip silently rather than fail.
        return false;
      }

      const startedAt = call?.created_at ? new Date(call.created_at) : new Date();

      switch (type) {
        case 'call.ring':
          await this.upsertCallFromWebhook({
            cid,
            callerId: createdById,
            calleeId,
            status: 'ringing',
            startedAt,
          });
          return true;

        case 'call.accepted':
          await this.upsertCallFromWebhook({
            cid,
            callerId: createdById,
            calleeId,
            status: 'answered',
            startedAt,
            answeredAt: new Date(event?.created_at ?? Date.now()),
          });
          return true;

        case 'call.rejected':
          await this.upsertCallFromWebhook({
            cid,
            callerId: createdById,
            calleeId,
            status: 'declined',
            reason: 'declined',
            startedAt,
            endedAt: new Date(event?.created_at ?? Date.now()),
          });
          // Dismiss the killed-state ringing notification on whichever side
          // didn't initiate the reject. We push to BOTH sides because the
          // event itself doesn't tell us which device was killed.
          await this.broadcastDismissCallFcm(cid, [createdById, calleeId]);
          return true;

        case 'call.missed':
          await this.upsertCallFromWebhook({
            cid,
            callerId: createdById,
            calleeId,
            status: 'missed',
            reason: 'timeout',
            startedAt,
            endedAt: new Date(event?.created_at ?? Date.now()),
          });
          // Tell the callee's killed-state device to drop the ringing
          // notification — Stream's own ring timeout (~30s) doesn't fire a
          // dismiss FCM on its own.
          await this.broadcastDismissCallFcm(cid, [calleeId]);
          return true;

        case 'call.ended':
        case 'call.session_ended': {
          const sessionStart = call?.session?.started_at
            ? new Date(call.session.started_at)
            : undefined;
          const sessionEnd = call?.session?.ended_at
            ? new Date(call.session.ended_at)
            : new Date(event?.created_at ?? Date.now());
          const duration = sessionStart
            ? Math.max(0, Math.floor((sessionEnd.getTime() - sessionStart.getTime()) / 1000))
            : 0;

          await this.upsertCallFromWebhook({
            cid,
            callerId: createdById,
            calleeId,
            status: 'ended',
            reason: createdById === event?.user?.id ? 'caller_hungup' : 'callee_hungup',
            startedAt,
            answeredAt: sessionStart,
            endedAt: sessionEnd,
            durationSeconds: duration,
          });
          // The "caller cancels before callee picks up" case lands here as
          // call.ended. Without this push the callee's killed device keeps
          // the ringing notification alive until Stream's own ring timeout
          // fires call.missed (~20-30 s) — exactly the symptom users
          // reported. We push to both ends so whichever side was killed
          // gets the dismiss too.
          await this.broadcastDismissCallFcm(cid, [createdById, calleeId]);
          return true;
        }

        default:
          return false;
      }
    } catch (err) {
      console.error('[STREAM] Error handling webhook event:', err);
      return false;
    }
  }

  /**
   * Reject a Stream call on behalf of [userId]. Used by the cold-state
   * decline path: the killed-app native BroadcastReceiver hits our
   * `/call/stream/decline-cold` endpoint when the user taps Decline, and
   * we re-sign a short-lived JWT for them and call Stream's reject API.
   * Without this, the caller's "ringing…" UI stays up until Stream's own
   * ring timeout (~20-30s) fires call.missed.
   *
   * The cid is the full Stream call CID (e.g. "default:<uuid>"). API base
   * is the standard hosted endpoint; if you self-host, change it here.
   */
  static async rejectCallAsUser(cid: string, userId: string): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('Stream Video is not configured');
    }
    const [callType, callId] = cid.includes(':') ? cid.split(':') : ['default', cid];
    const userToken = this.createUserToken(userId, 60 * 5); // 5-minute token, single use
    const url = `https://video.stream-io-api.com/api/v2/video/call/${encodeURIComponent(callType)}/${encodeURIComponent(callId)}/reject?api_key=${encodeURIComponent(STREAM_API_KEY)}&user_id=${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': userToken,
        'stream-auth-type': 'jwt',
      },
      body: '{}',
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[STREAM] rejectCallAsUser failed: ${res.status} ${txt}`);
      throw new Error(`Stream reject API ${res.status}`);
    }
    console.log(`[STREAM] ✓ rejectCallAsUser cid=${cid} user=${userId}`);
  }

  /**
   * Push a Stream-flavoured `call.ended` FCM to the given users. Our Flutter
   * background handler (`handleStreamVideoBackgroundPush`) recognises
   * `sender: 'stream.video'` + `type: 'call.ended'` and calls
   * `pushNotificationManager.endCallByCid` to dismiss any stuck ringing
   * notification.
   *
   * Stream itself only sends FCM for `call.ring` and `call.missed`; the
   * cancel/decline cases are coordinator-side WS events that never reach a
   * killed device. This method is the bridge.
   */
  private static async broadcastDismissCallFcm(cid: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await FCMService.send_notification({
        type: 'call',
        fcm_mode: 'data-only',
        user_ids: userIds,
        // The `data` map is spread AFTER `type: payload.type` in the FCM
        // builder, so our `type: 'call.ended'` here overrides the outer
        // 'call' on the wire — which is what the Flutter handler matches
        // on. Same trick for `sender`, which gates `isStreamVideoPush`.
        data: {
          sender: 'stream.video',
          type: 'call.ended',
          call_cid: cid,
        },
      });
    } catch (err) {
      console.error('[STREAM] broadcastDismissCallFcm failed:', err);
    }
  }

  /**
   * Pre-flight check used by `/call/stream/credentials`: same gating as the
   * WebRTC initiator — caller cannot dial a callee without `call_access`.
   */
  static async assertCalleeReachable(calleeId: string): Promise<{ ok: true } | { ok: false; code: number; message: string }> {
    const [callee] = await db
      .select({ call_access: user_model.call_access })
      .from(user_model)
      .where(eq(user_model.id, calleeId))
      .limit(1);

    if (!callee) return { ok: false, code: 404, message: 'Callee not found' };
    if (!callee.call_access) return { ok: false, code: 401, message: 'Callee does not have call access enabled' };
    return { ok: true };
  }
}

export default StreamCallService;
