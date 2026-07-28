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

/** A short-lived ghost-call rejoin window held in memory. `waiter_id` is the
 * party still in the call (G); `dropped_id` is the party that vanished (L) and
 * may rejoin until `expires_at` (epoch ms). `peer_*` describe the waiter, for
 * L's UI. `timer` is the expiry handle. */
type RejoinWindow = {
  cid: string;
  waiter_id: string;
  dropped_id: string;
  peer_name?: string;
  peer_pfp?: string;
  expires_at: number;
  timer: ReturnType<typeof setTimeout>;
};

/** Value stored in the busy registry: the call the user is engaged on, when
 * that fact was last set/refreshed (`at`, epoch ms), and — for CONNECTED
 * entries only — since when the pairing has looked dead to the liveness
 * probe (`stale_since`), used for the two-strike auto-clear. */
type BusyEntry = {
  cid: string;
  at: number;
  stale_since?: number;
};

export class StreamCallService {
  /**
   * MASTER SWITCH for the ghost-call rejoin feature (2026-07-25: DISABLED).
   *
   * The rejoin machinery (30s windows, "Reconnecting…" banner, rejoin dot /
   * dialog) was causing more damage than it prevented: stale windows after
   * clean hangups produced rejoin popups on restart, and the window/busy
   * interplay left users stuck on "recipient is on another call". All entry
   * points check this flag — the code is kept intact so it can be revived
   * deliberately later. Type is annotated `boolean` (not literal `false`) so
   * TS doesn't narrow it and flag the guarded code as unreachable.
   *
   * Mirrored client-side by `kCallRejoinEnabled` in stream_call.service.dart.
   */
  static readonly REJOIN_ENABLED: boolean = false;

  /**
   * In-memory busy registry: `userId → cid` of the call the user is
   * currently engaged in (ringing / answered / connected). Populated from
   * the Stream webhook handler — `call.ring` marks both caller and callee
   * busy, terminal events clear them. Read by [assertCalleeReachable] /
   * [isUserBusy] to gate new outgoing calls.
   *
   * Trade-offs:
   *  - Process-local. If the backend has multiple instances behind a load
   *    balancer, the registry won't be consistent across them. For
   *    single-node deployments (current setup) this is fine; if that
   *    changes, promote to Redis with the same set/clear semantics.
   *  - Webhook-driven. There's a window between `getOrCreate({ringing:true})`
   *    on the client and the `call.ring` webhook arriving where a second
   *    call could slip through. Mitigated by the client-side auto-reject
   *    safety net (StreamCallService.dart subscribes to incoming calls and
   *    rejects with CallRejectReason.busy() if it already has an active
   *    call).
   *  - Historically STICKY: entries were only removed by terminal webhooks,
   *    `call:terminate`, or rejoin-window expiry. If every one of those was
   *    missed (webhooks unreachable + client died mid-ring), the user stayed
   *    "busy" until a backend restart — they could not place or receive any
   *    call. Now self-healing: see the staleness logic in [isUserBusy] and
   *    the client-idle self-heal in the precheck route.
   */
  private static busyByUser = new Map<string, BusyEntry>();

  /** Ring-phase leak TTL. The clients hard-cap ringing at 30s, so a busy
   * entry that has sat in ring phase (never upgraded to connected, never
   * cleared) for this long means every terminal signal was lost. */
  private static readonly RING_BUSY_TTL_MS = 90_000;

  /** Two-strike confirmation gap for clearing a CONNECTED entry that shows
   * no liveness (no socket on either side, no open rejoin window). Bridges
   * the instant between a socket close and the close-handler opening the
   * rejoin window, so a legitimate mid-call blip is never misread. */
  private static readonly CONNECTED_STALE_CONFIRM_MS = 10_000;

  /** Socket-liveness probe, injected by the socket layer at startup (avoids
   * an import cycle — this module must not import socket internals). Returns
   * true when the user has a live WS right now. */
  private static livenessProbe: ((userId: string) => boolean) | null = null;

  static setLivenessProbe(probe: (userId: string) => boolean): void {
    this.livenessProbe = probe;
  }

  /**
   * Tombstones of recently-TERMINATED cids.
   *
   * Guards against late busy re-marks — the observed failure: user hangs up
   * (the WS `call:terminate` clears busy for both), then a delayed or
   * out-of-order Stream `call.accepted` webhook re-marks BOTH parties busy
   * on the already-dead cid. Both users are online, so the liveness heal
   * (which only clears when nobody has a socket) never fires — every redial
   * then gets "Recipient is on another call", and the phantom CONNECTED
   * pairing makes the socket-close handler treat the next app kill as a
   * mid-call drop (spurious rejoin window → popup on restart).
   *
   * Every terminate path stamps the cid here (via [clearCall]); any
   * subsequent mark for a tombstoned cid is refused, and [isUserBusy] purges
   * entries whose cid turns out to be tombstoned (covers a terminate whose
   * participant list missed one side).
   */
  private static endedCids = new Map<string, number>();
  private static readonly ENDED_TOMBSTONE_MS = 10 * 60_000;

  static markCallEnded(cid: string): void {
    if (!cid) return;
    this.pruneEndedCids();
    this.endedCids.set(cid, Date.now());
  }

  static isRecentlyEnded(cid: string): boolean {
    if (!cid) return false;
    const t = this.endedCids.get(cid);
    if (t === undefined) return false;
    if (Date.now() - t > this.ENDED_TOMBSTONE_MS) {
      this.endedCids.delete(cid);
      return false;
    }
    return true;
  }

  private static pruneEndedCids(): void {
    if (this.endedCids.size < 200) return;
    const cutoff = Date.now() - this.ENDED_TOMBSTONE_MS;
    for (const [cid, t] of this.endedCids) {
      if (t < cutoff) this.endedCids.delete(cid);
    }
  }

  /**
   * Cids that have reached the CONNECTED (answered) state — set from the
   * `call.accepted` webhook, cleared on any terminal webhook. The backend uses
   * this to distinguish a mid-call drop (recoverable → open a rejoin window)
   * from a still-ringing drop (a cancel/miss, handled by Stream's own events).
   * Same single-node / in-memory trade-off as [busyByUser].
   */
  private static connectedCids = new Set<string>();

  static markUserBusy(userId: string, cid: string): void {
    if (!userId || !cid) return;
    if (this.isRecentlyEnded(cid)) {
      console.warn(`[STREAM] busy+ REFUSED (cid tombstoned — late webhook?) `
        + `user=${userId} cid=${cid}`);
      return;
    }
    this.busyByUser.set(userId, { cid, at: Date.now() });
    console.log(`[STREAM] busy+ user=${userId} cid=${cid}`);
  }

  /**
   * Record that [a] and [b] are now in a CONNECTED call [cid]. Driven by the
   * app's `call:connected` WS event (sent on first media connect) — NOT by
   * Stream webhooks — so the in-call pairing is known even when Stream's cloud
   * can't reach this backend (e.g. a private-IP / hotspot dev server, where
   * webhooks never arrive). This is what lets the socket-close handler
   * self-open a rejoin window: it needs to know the user was in a connected
   * call and who the peer is.
   */
  static markCallConnected(a: string, b: string, cid: string): void {
    if (!cid) return;
    if (this.isRecentlyEnded(cid)) {
      console.warn(`[STREAM] connect-mark REFUSED (cid tombstoned) cid=${cid} `
        + `parties=${a},${b}`);
      return;
    }
    const now = Date.now();
    // Fresh timestamps + wiped stale marks: a re-announce (WS reconnect
    // mid-call) is positive proof the call is alive.
    if (a) this.busyByUser.set(a, { cid, at: now });
    if (b) this.busyByUser.set(b, { cid, at: now });
    this.connectedCids.add(cid);
    console.log(`[STREAM] call CONNECTED cid=${cid} parties=${a},${b}`);
  }

  /** Drop a connected call's busy + connected state for the given parties.
   * Driven by `call:terminate` (clean hangup) and rejoin-window expiry. */
  static clearCall(cid: string, userIds: string[]): void {
    if (!cid) return;
    for (const u of userIds) this.clearUserBusy(u, cid);
    this.connectedCids.delete(cid);
    // Tombstone the cid so a straggler mark (late webhook, late re-announce)
    // can't resurrect the pairing after this call is over.
    this.markCallEnded(cid);
  }

  /** Only clears if the user is busy on THIS specific cid — avoids
   * races where a stale terminal event for an older call would otherwise
   * unmark a newer in-progress one. */
  static clearUserBusy(userId: string, cid: string): void {
    if (!userId || !cid) return;
    if (this.busyByUser.get(userId)?.cid === cid) {
      this.busyByUser.delete(userId);
      console.log(`[STREAM] busy- user=${userId} cid=${cid}`);
    }
  }

  /** The other user marked busy on [cid], or null. */
  private static peerOnCid(cid: string, userId: string): string | null {
    for (const [uid, entry] of this.busyByUser) {
      if (entry.cid === cid && uid !== userId) return uid;
    }
    return null;
  }

  /**
   * Returns the cid the user is currently engaged on, or null.
   *
   * Self-healing: this is the single read path for busy gating, so leaked
   * entries are detected and cleared lazily right here —
   *  - RING phase: entry older than [RING_BUSY_TTL_MS] with no upgrade to
   *    connected → every terminal signal was lost → clear.
   *  - CONNECTED phase: a live call implies at least one party's socket is
   *    up OR a rejoin window is open for the cid (both-sockets-down is
   *    exactly the state a window covers, and window expiry itself clears
   *    the call). If neither holds on two reads ≥ [CONNECTED_STALE_CONFIRM_MS]
   *    apart, the pairing is dead → clear both parties.
   */
  static isUserBusy(userId: string): string | null {
    if (!userId) return null;
    const e = this.busyByUser.get(userId);
    if (!e) return null;
    // Entry survived a terminate that missed this user (bad participant list
    // in the payload) or predates the tombstone — the call is over, purge.
    if (this.isRecentlyEnded(e.cid)) {
      console.warn(`[STREAM] busy purge (cid tombstoned) user=${userId} cid=${e.cid}`);
      this.busyByUser.delete(userId);
      return null;
    }
    const now = Date.now();
    const connected = this.connectedCids.has(e.cid);

    if (!connected) {
      if (now - e.at > this.RING_BUSY_TTL_MS) {
        console.warn(`[STREAM] busy LEAK (ring-phase, ${now - e.at}ms old) `
          + `user=${userId} cid=${e.cid} — auto-clearing`);
        this.busyByUser.delete(userId);
        return null;
      }
      return e.cid;
    }

    const probe = this.livenessProbe;
    if (probe) {
      const peer = this.peerOnCid(e.cid, userId);
      const alive = probe(userId)
        || (peer !== null && probe(peer))
        || this.hasAnyRejoinWindow(e.cid);
      if (alive) {
        if (e.stale_since) e.stale_since = undefined;
      } else if (!e.stale_since) {
        e.stale_since = now;
        console.warn(`[STREAM] busy SUSPECT (connected, no liveness) `
          + `user=${userId} cid=${e.cid} — will clear if still dead in `
          + `${this.CONNECTED_STALE_CONFIRM_MS}ms`);
      } else if (now - e.stale_since > this.CONNECTED_STALE_CONFIRM_MS) {
        console.warn(`[STREAM] busy LEAK (connected, no liveness twice) `
          + `cid=${e.cid} — auto-clearing`);
        this.clearCall(e.cid, peer ? [userId, peer] : [userId]);
        return null;
      }
    }
    return e.cid;
  }

  /**
   * Ghost-call recovery: short-lived "rejoin window" registry.
   *
   * When one party (the "waiter", G) is still in a call but the other (the
   * "dropped" user, L) vanished without a clean terminate, G's client opens a
   * 10s window via `call:rejoin:open`. We hold it here so that L — even if its
   * app was killed and reopened within the window — can discover the call is
   * still rejoinable (via WS push, FCM, or the GET /stream/rejoinable query)
   * and tap to rejoin. The window is keyed by cid; an `onExpire` callback fires
   * if neither side resolves it in time.
   *
   * Same single-node / in-memory trade-off as [busyByUser] above — promote to
   * Redis (with TTL) if the backend goes multi-node.
   */
  private static rejoinByCid = new Map<string, RejoinWindow>();

  /** Open (or replace) a rejoin window for `cid`. Arms an expiry timer that
   * deletes the entry and invokes `onExpire` if it isn't resolved first. */
  static openRejoinWindow(
    w: Omit<RejoinWindow, 'timer'>,
    onExpire: (expired: RejoinWindow) => void,
  ): void {
    if (!w.cid || !w.dropped_id) return;
    const prior = this.rejoinByCid.get(w.cid);
    if (prior) clearTimeout(prior.timer);
    const ms = Math.max(0, w.expires_at - Date.now());
    const timer = setTimeout(() => {
      const cur = this.rejoinByCid.get(w.cid);
      this.rejoinByCid.delete(w.cid);
      console.log(`[STREAM] rejoin window EXPIRED cid=${w.cid} dropped=${w.dropped_id}`);
      if (cur) onExpire(cur);
    }, ms);
    const full: RejoinWindow = { ...w, timer };
    this.rejoinByCid.set(w.cid, full);
    console.log(`[STREAM] rejoin window OPEN cid=${w.cid} waiter=${w.waiter_id} dropped=${w.dropped_id} ms=${ms}`);
  }

  /** Resolve a rejoin window ONLY if `userId` is its dropped party — i.e. the
   * dropped user came back (sent `call:connected` again on rejoin/reconnect).
   * Returns the closed window (so the caller can notify both parties it ended
   * with outcome 'rejoined'), or null if there was no such window. */
  static resolveRejoinWindowIfDropped(cid: string, userId: string): RejoinWindow | null {
    const w = this.rejoinByCid.get(cid);
    if (!w || w.dropped_id !== userId) return null;
    return this.resolveRejoinWindow(cid);
  }

  /** Resolve (close) the rejoin window for `cid`, cancelling its expiry timer.
   * Returns the window that was closed, or null if none was open. */
  static resolveRejoinWindow(cid: string): RejoinWindow | null {
    if (!cid) return null;
    const w = this.rejoinByCid.get(cid);
    if (!w) return null;
    clearTimeout(w.timer);
    this.rejoinByCid.delete(cid);
    console.log(`[STREAM] rejoin window RESOLVED cid=${cid}`);
    return w;
  }

  /** True if a live rejoin window already exists for `cid` with this dropped
   * party — lets the disconnect self-open stand down if a client already
   * opened the window (avoids a duplicate open + duplicate fan-out). */
  static hasRejoinWindow(cid: string, droppedId: string): boolean {
    const w = this.rejoinByCid.get(cid);
    return !!w && w.dropped_id === droppedId && w.expires_at > Date.now();
  }

  /**
   * If `userId` is currently in a CONNECTED (answered) call, return that call's
   * cid and the peer's id. Used by the socket-close handler to self-open a
   * rejoin window WITHOUT depending on the dying client flushing a WS frame.
   * Returns null if the user is idle or the call is only ringing (not yet
   * answered) — a ringing drop is a cancel/miss, not a recoverable drop.
   *
   * The peer is derived from [busyByUser]: both parties are marked busy on the
   * same cid for the call's lifetime, so the other busy user on this cid is the
   * peer.
   */
  static getConnectedCallPeer(userId: string): { cid: string; peerId: string } | null {
    if (!userId) return null;
    const entry = this.busyByUser.get(userId);
    if (!entry) return null;
    const cid = entry.cid;
    if (!this.connectedCids.has(cid)) return null; // ringing, not connected
    const peerId = this.peerOnCid(cid, userId);
    return peerId ? { cid, peerId } : null;
  }

  /** True when a live (unexpired) rejoin window exists for [cid]. */
  static hasAnyRejoinWindow(cid: string): boolean {
    const w = this.rejoinByCid.get(cid);
    return !!w && w.expires_at > Date.now();
  }

  /** True when the user is the WAITER of a live rejoin window — i.e. still
   * in a connected call whose peer briefly dropped. Used by the precheck
   * self-heal to avoid trusting a bogus "I'm idle" claim in that state. */
  static isWaiterOfOpenWindow(userId: string): boolean {
    if (!userId) return false;
    const now = Date.now();
    for (const w of this.rejoinByCid.values()) {
      if (w.waiter_id === userId && w.expires_at > now) return true;
    }
    return false;
  }

  /**
   * Verify a Stream user token we minted earlier: signature must check out
   * against our API secret and the `user_id` claim must match. Expiry is
   * deliberately IGNORED — a genuine-but-expired token still proves the
   * device once held credentials for this user, which is all the
   * unauthenticated cold-decline endpoint needs (and >7-day-idle devices
   * would otherwise lose killed-state decline).
   */
  static verifyUserToken(token: string | undefined, userId: string): boolean {
    if (!token || !userId || !this.isConfigured()) return false;
    try {
      const payload = jwt.verify(token, STREAM_API_SECRET, {
        ignoreExpiration: true,
      }) as { user_id?: string };
      return payload?.user_id === userId;
    } catch {
      return false;
    }
  }

  /** Find the newest live rejoin window where `userId` is the dropped party —
   * used by GET /stream/rejoinable so a reopened app can hydrate its dot. */
  static getRejoinFor(userId: string): RejoinWindow | null {
    if (!userId) return null;
    const now = Date.now();
    let best: RejoinWindow | null = null;
    for (const w of this.rejoinByCid.values()) {
      if (w.dropped_id === userId && w.expires_at > now) {
        if (!best || w.expires_at > best.expires_at) best = w;
      }
    }
    return best;
  }

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
          // Mark BOTH sides busy from the moment the ring starts — even an
          // unanswered ring blocks a second call from the caller's side and
          // displays "busy" to any third party who tries to dial the callee.
          this.markUserBusy(createdById, cid);
          this.markUserBusy(calleeId, cid);
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
          // Refresh both — accept may arrive before ring if the caller and
          // callee come up out of order during a coordinator hiccup.
          // Tombstone-guarded: a DELAYED accepted webhook landing after the
          // call already terminated must NOT resurrect the busy pairing —
          // that was the "recipient is on another call" stuck state (both
          // users online → liveness heal can't fire).
          this.markUserBusy(createdById, cid);
          this.markUserBusy(calleeId, cid);
          // The call is now live — a subsequent disconnect of either party is a
          // recoverable mid-call drop, so a rejoin window may be opened.
          if (!this.isRecentlyEnded(cid)) this.connectedCids.add(cid);
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
          // clearCall (not bare clearUserBusy) so the cid is tombstoned too.
          this.clearCall(cid, [createdById, calleeId]);
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
          this.clearCall(cid, [createdById, calleeId]);
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
          this.clearCall(cid, [createdById, calleeId]);
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
