import admin from 'firebase-admin';
import { EventEmitter } from 'events';
import { and, asc, gt, isNotNull } from 'drizzle-orm';
import { ChatMessagePayload, WSMessage, } from '@/types/socket.types';
import { ResultType } from '@/types/core.types';
import { store_fcm_token, fetch_fcm_tokens, remove_fcm_token } from '@/cache-management/fcm-token.cache';
import db from '@/config/db';
import { user_model } from '@/models/user.model';
import { count } from '@/utils/counters';
import { redis_lease } from '@/cluster/lease';
import { run_leased_waves, type WaveResult } from './fcm-broadcast-waves';
import { count_message_new, note_fcm_sent } from './fcm-health';

// D3: one broadcast-to-all at a time across every process (lease-core.ts).
// The TTL only has to outlive one wave (≤ concurrency sends + delay); every
// wave renews it.
const FCM_BROADCAST_LEASE = 'fcm_broadcast';
const FCM_BROADCAST_LEASE_TTL_MS = 120_000;

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    // credential: admin.credential.applicationDefault(),
    // You can also use a service account key file:
    credential: admin.credential.cert({
      projectId: "amigo-ec5be",
      clientEmail: "firebase-adminsdk-fbsvc@amigo-ec5be.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDO4FzE7apKLm3X\naZHmmxvVDq3Yz1CJ/ESCvTv7CCtGMmnA0Z1c2qB4Bh+M2yEBo6A+7Mvnd4mlkeey\nT/fF6D+BtkMaKXSb3gg8hjtG38HLBX4deUYAX26rTACECr57RhEMt+TEv5IMP3Os\n7vBngtK43HiCcacxEWyWKcVmUXZwVPyz5Ewtlq9ive5fnPIwi423RFddft0nW3m1\n/Ugz7lKUA8XByijKX0MENmjfKVJ+ZX9SzOSWHadiRshaKRei11EkHz5C7rlImXHK\n34M8iNbM6gJvdMFlg6UvnxO0v+GOz2mhFEBHkRrVhx1E0YnTyW25ppIzk1nEehd3\n33VB5BXLAgMBAAECggEAD6x6sDDm21fz2oOVGkkGLXjp6FNMttJLc9xX1F0kv4dy\nRmRF7T24irTBZIVLADogGfm249fwBdYCx++8cLIinaFBfunv0R9cCw81zoOFcJb/\nRxxjwVjO+bYjE938heUjxY2T4j7hbIF3h31S7toVPQxMf8A8pUBnXw6AdjrAeSIp\nlffhc7K01PCz3nVi1jDoeTgybnUpjhuosrp19IQIwjEledyS16AwM0m2kCvQ9Xep\nuTb+DbWZG9HlJQnUW6LXT7Dl5eenhRsYCI9IIXbTPvllfrMi2k8ugigwdsI4UBiK\n5kMN4yrg/VpAcpWWb9OiTPW5HwQJLa51grdRvLuBAQKBgQD7j8OeVK3PihMFb7eR\nh1F/aw1aNhaNT5VW6DYHLWJnPaOYuHPVQA6Mn48d5lJ75w//QchRv5RgisJct6bA\ndVz+XQ+2OVwibWFE89tg6x59RFpGfMvBRRuDLe0p9nCMSrpEFOiulOdK5sOEwheX\nGn/5lNgN/KQFCG4Nz1k+nASlSQKBgQDShsR0mxnuBpPobi50Ix8tZcCzHjeA5PqU\nc2ydeCU4SKqSwknY9fLRb7D1fudHQ5KWBOHTw6ZY6r99bPE4X7OkCgF+nM83VSw5\nTOCgfgPRH2t7djPIKe0KSjewmmzNlbSdOPV14TtVa5J9LSxr+5YPv3pWDLxQPxcl\npRzxsh0mcwKBgQCwUejLnhChaebBJbelohIGXBNkyopuC3ziCCpuR2o0cKitD4Po\n0VghSmj2jQv9WkwFHqd4XO5z6G4orHSNavV+N94eW//vBXlq6f025jVdmb4or6nk\n0jphbJxRkDD8tBfwRjN8wlOHVU1vTNdaCrHuTlxNGWohOPJibZXg41wCOQKBgCcm\n4Qo+fggCOSeUthbrITU0Iy4shG34J5HMFXsDiQh6mx5H+6vZsZq5htNhEmnyayRz\nK/xR+nG21n3g8MtnIOV05upBB1hnAp51aaDvTo5ppXeEeATVpzuuqcSyM2HYYYqL\nuTp+9KXiJ5AYApbiZvnuxjWSkMLruMZLeqKIWVt5AoGAXPs2xIs5EiL7T7fmDGpp\n0A3qFsGX2L3hczSP0Af+tlp+qU9TBG7gEX443rxYuzOiybB9VWoQRoHV4tJVOIJv\nCDLadqt53zKMIlvZesjP/yBQMyBbFm3lfSGgm0x/O3ROt/nGF4nKik6qO6DnsQlz\n+hrf+JpBajK85Wjmva9gBeU=\n-----END PRIVATE KEY-----\n"

    }),
  });
}

interface FCMPayload {
  type: 'message' | 'call' | 'ws-message';
  fcm_mode: "notification" | "data-only";
  user_ids: string[];
  title?: string;
  body?: string;
  ws_message?: WSMessage;   // single — used for calls
  ws_messages?: WSMessage[]; // batched — used for chat messages
  data?: Record<string, any>;
  // When true, the FCM data payload carries `silent: '1'` so the app
  // processes the message but suppresses local-notification painting — the
  // muted-chat path. Implies fcm_mode='data-only' (chat-message FCMs already
  // are; this is only meaningful for them).
  silent?: boolean;
  // Force android priority 'normal' for a data-only push (the ack fallback,
  // services/fcm-ack-fallback.ts). Never applies to calls.
  priority?: 'normal';
}

export class FCMService {
  private static instance: FCMService;

  public static getInstance(): FCMService {
    if (!FCMService.instance) {
      FCMService.instance = new FCMService();
    }
    return FCMService.instance;
  }

  // Send push notification to multiple users
  async send_notification(payload: FCMPayload) {
    try {
      // Fetch FCM tokens for all users using the 3-tier cache
      const token_map = await fetch_fcm_tokens(payload.user_ids);

      const with_tokens = Array.from(token_map.entries()).filter(([_, t]) => t !== null).length;
      // const without_tokens = payload.user_ids.length - with_tokens;
      // console.log(`[FCM] send_notification: ${with_tokens} with token, ${without_tokens} without token (type=${payload.type})`);

      // Filter out users without tokens and send notifications
      const send_promises = Array.from(token_map.entries())
        .filter(([_, token]) => token !== null)
        .map(async ([user_id, fcm_token]) => {

          if (!fcm_token) return false;

          // SYNC_V2 §14.13: android priority 'normal' ONLY for pushes that
          // will not post a notification — the muted-chat path (silent:'1',
          // data-only). High priority is a Doze-exempt wake-up budget that
          // Android shrinks for apps whose high-priority pushes don't show a
          // notification; spending it on muted chats makes the pushes that DO
          // notify arrive late. Everything that notifies stays 'high', calls
          // included (their 30 s TTL is unchanged).
          const normal_priority =
            payload.fcm_mode === 'data-only' &&
            payload.type !== 'call' &&
            (payload.silent === true || payload.priority === 'normal');
          if (normal_priority) count('FCM', 'priority_normal');

          try {
            const message: admin.messaging.Message = {
              token: fcm_token,
              notification: payload.fcm_mode === 'notification'
                ? {
                  title: payload.title,
                  body: payload.body,
                }
                : undefined,

              data: {
                type: payload.type,
                ...payload.data,
                // Recipient assertion — the id of the user whose token we are
                // sending to (NOT payload.user_ids[0]; this map is iterated per
                // recipient). A handset that changed hands, or a token that is
                // briefly stale in some cache tier, can still receive a push
                // addressed to the PREVIOUS owner; the app drops any push whose
                // to_user_id isn't the signed-in user. FCM data values must be
                // strings.
                to_user_id: String(user_id),
                ...(payload.ws_message
                  ? { ws_message: JSON.stringify(payload.ws_message) }
                  : {}),
                ...(payload.ws_messages
                  ? { ws_messages: JSON.stringify(payload.ws_messages) }
                  : {}),
                // Muted-chat marker. App-side FCM handler reads this and
                // skips local-notification painting while still processing
                // the ws_messages into the local DB.
                ...(payload.silent ? { silent: '1' } : {}),
              },
              android: {
                priority: normal_priority ? 'normal' : 'high',
                ttl: payload.type === 'call' ? 30000 : 2419200000,
                // Only include android.notification when fcm_mode is 'notification'
                // This prevents Firebase from auto-displaying notifications for data-only messages
                ...(payload.fcm_mode === 'notification'
                  ? {
                    notification: {
                      channelId: payload.type === 'call' ? 'calls' : 'messages',
                      priority: payload.type === 'call' ? 'max' : 'high',
                      sticky: payload.type === 'call' ? true : false,
                      sound: 'default',
                      vibrateTimingsMillis: [0, 250, 250, 250],
                      // ...(payload.type === 'ws-message' && payload.ws_message?.type === "message:new" ? {
                      //   tag: `conversation_${(payload.ws_message?.payload as any).conv_id || "group"}`,
                      // } : {}),
                    },
                  }
                  : {}),
              },
              apns: {
                payload: {
                  aps: {
                    sound: 'default',
                    badge: 1,
                    contentAvailable: true,
                  },
                },
              },
            };

            const msg_id = await admin.messaging().send(message);
            // §14.13 FCM health: count the message:new this push carried
            // (the denominator of fast/sent). No-op unless net telemetry is on.
            if (payload.ws_messages) note_fcm_sent(user_id, count_message_new(payload.ws_messages));
            // console.log(`[FCM] ✅ Sent to user ${user_id}: ${msg_id}`);
            // console.log(`[FCM] with FCM token ${fcm_token}`);
            return true;
          } catch (error: any) {
            // Handle invalid token errors
            if (error.code === 'messaging/registration-token-not-registered' ||
              error.code === 'messaging/invalid-registration-token') {
              // Remove invalid token from cache
              await remove_fcm_token(user_id);
              console.error(`[FCM] Invalid token for user ${user_id}, removed from cache`);
            } else {
              console.error(`[FCM] Error sending notification to user ${user_id}:`, error);
            }
            return false;
          }
        });

      const results = await Promise.allSettled(send_promises);
      const success_count = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

      return success_count > 0;
    } catch (error: any) {
      console.error(`[FCM] Error sending notifications:`, error);
      return false;
    }
  }

  // Broadcast a single notification to EVERY user that currently has an FCM
  // token. Used for app-wide announcements (e.g. a new app version).
  //
  // IMPORTANT — why this sends one message at a time in bounded waves rather
  // than via `sendEachForMulticast`: that helper fires every message as a
  // concurrent HTTP/2 stream on a SINGLE connection to FCM. FCM caps concurrent
  // streams per connection (~100), and Bun's http2 client (unlike Node's) does
  // not queue streams beyond the server's limit — it opens them all, so FCM
  // resets the whole connection with `GOAWAY exceeded_max_concurrent_streams`
  // and the entire batch fails. So we cap in-flight sends to `concurrency`
  // (well under the stream limit) and pause `delay_ms` between waves to keep
  // load gentle.
  //
  // A `notification` block is included so the OS renders the tray entry itself
  // when the recipient app is backgrounded/terminated (this is what lets users
  // on OLDER builds, which don't know this push type, still see it). Tokens FCM
  // reports as dead are evicted from the 3-tier cache so the column self-heals.
  async broadcast_to_all(input: {
    title: string;
    body: string;
    data?: Record<string, string>;
    concurrency?: number;
    delay_ms?: number;
    // Resume key (default: a hash of the notification). An unfinished run with
    // the same id is continued after its cursor instead of starting over.
    run_id?: string;
  }): Promise<WaveResult> {
    const concurrency = Math.min(Math.max(input.concurrency ?? 20, 1), 100);
    const delay_ms = input.delay_ms ?? 200;

    // Bun adds a per-request timeout listener to the shared FCM socket; lift
    // the limit so bounded concurrency doesn't trip Node's (cosmetic)
    // MaxListenersExceededWarning.
    EventEmitter.defaultMaxListeners = Math.max(
      EventEmitter.defaultMaxListeners,
      concurrency + 20,
    );

    // D3 (§13.7): one run at a time across processes, resumable after a
    // kill, never re-pushing the users a crashed run already reached
    // (fcm-broadcast-waves.ts). Same message, same waves, same pacing.
    const run_id = input.run_id ?? `n${Bun.hash(JSON.stringify([input.title, input.body, input.data ?? {}])).toString(36)}`;
    const result = await run_leased_waves(
      {
        acquire: () => redis_lease(FCM_BROADCAST_LEASE, FCM_BROADCAST_LEASE_TTL_MS),
        fetch_page: (after, limit) =>
          db
            .select({ id: user_model.id, fcm_token: user_model.fcm_token })
            .from(user_model)
            .where(after ? and(isNotNull(user_model.fcm_token), gt(user_model.id, after)) : isNotNull(user_model.fcm_token))
            .orderBy(asc(user_model.id))
            .limit(limit) as Promise<{ id: string; fcm_token: string }[]>,
        send: async (row) => {
          const message: admin.messaging.Message = {
            token: row.fcm_token,
            notification: { title: input.title, body: input.body },
            // Same recipient assertion as send_notification, so a token that has
            // since moved to another handset can be dropped app-side.
            data: { ...(input.data ?? {}), to_user_id: String(row.id) },
            android: {
              priority: 'high',
              ttl: 2419200000,
              notification: {
                // Reuse the always-present 'messages' channel so the tray
                // entry still renders on already-installed (older) builds that
                // have no dedicated channel for app updates.
                channelId: 'messages',
                priority: 'high',
                sound: 'default',
              },
            },
            apns: {
              payload: { aps: { sound: 'default', badge: 1, contentAvailable: true } },
            },
          };

          try {
            await admin.messaging().send(message);
            return true;
          } catch (err: any) {
            const code = err?.code;
            if (
              code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token'
            ) {
              await remove_fcm_token(row.id);
            } else {
              console.error(
                `[FCM] broadcast send error for user ${row.id}:`,
                code ?? err,
              );
            }
            return false;
          }
        },
      },
      { run_id, concurrency, delay_ms },
    );

    console.log(
      `[FCM] broadcast ${result.skipped ? "skipped (busy)" : result.aborted ? `aborted (${result.aborted})` : "complete"}: ` +
      `run=${run_id} recipients=${result.recipients} sent=${result.sent} failed=${result.failed} waves=${result.waves}` +
      `${result.resumed ? " (resumed)" : ""}`,
    );
    return result;
  }

  // Update user's FCM token (updates all 3 tiers)
  async update_user_fcm_token(userId: string, fcmToken: string): Promise<ResultType> {
    // console.log("update_user_fcm_token : ", { userId, fcmToken });
    try {
      await store_fcm_token(userId, fcmToken);

      return {
        success: true,
        code: 200,
        message: "FCM token updated successfully",
      };
    } catch (error) {
      console.error(`[FCM] Error updating FCM token for user ${userId}:`, error);
      return {
        success: false,
        code: 500,
        message: "Failed to update FCM token",
      };
    }
  }

  // Remove user's FCM token (on logout, removes from all 3 tiers)
  async remove_user_fcm_token(userId: string): Promise<ResultType> {
    try {
      await remove_fcm_token(userId);

      return {
        success: true,
        code: 200,
        message: "FCM token removed successfully",
      };
    } catch (error) {
      console.error(`[FCM] Error removing FCM token for user ${userId}:`, error);
      return {
        success: false,
        code: 500,
        message: "Failed to remove FCM token",
      };
    }
  }

  // Format message body based on message type
  formatMessageBody(message?: ChatMessagePayload): string {

    if (!message) {
      return 'New message';
    }

    // If no body, return based on message type
    if (!message.body) {
      switch (message.msg_type) {
        case 'image':
          return '📷 Photo';
        case 'video':
          return '🎥 Video';
        case 'sticker':
          return '💟 Sticker';
        case 'audio':
          return '🎵 Voice message';
        case 'attachment':
          return '📎 File';
        case 'media':
          return '📎 Media';
        case 'reply':
          return '↩️ Reply';
        case 'forwarded':
          return '↪️ Forwarded message';
        default:
          return 'New message';
      }
    }

    // Add prefix for special message types
    switch (message.msg_type) {
      case 'reply':
        return `↩️ ${message.body.length > 90 ? message.body.substring(0, 90) + '...' : message.body}`;
      case 'forwarded':
        return '↪️ Forwarded message';
      default:
        // Truncate long messages
        if (message.body.length > 100) {
          return message.body.substring(0, 100) + '...';
        }
        return message.body;
    }
  }
}

export default FCMService.getInstance();
