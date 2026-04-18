import admin from 'firebase-admin';
import { ChatMessagePayload, VitalWSMessage, WSMessage, } from '@/types/socket.types';
import { MessageType } from '@/types/chat.types';
import { ResultType } from '@/types/core.types';
import { store_fcm_token, fetch_fcm_token, fetch_fcm_tokens, remove_fcm_token } from '@/cache-management/fcm-token.cache';

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
      const without_tokens = payload.user_ids.length - with_tokens;
      console.log(`[FCM] send_notification: ${with_tokens} with token, ${without_tokens} without token (type=${payload.type})`);

      // Filter out users without tokens and send notifications
      const send_promises = Array.from(token_map.entries())
        .filter(([_, token]) => token !== null)
        .map(async ([user_id, fcm_token]) => {

          if (!fcm_token) return false;

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
                ...(payload.ws_message
                  ? { ws_message: JSON.stringify(payload.ws_message) }
                  : {}),
                ...(payload.ws_messages
                  ? { ws_messages: JSON.stringify(payload.ws_messages) }
                  : {}),
              },
              android: {
                priority: 'high',
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
            console.log(`[FCM] ✅ Sent to user ${user_id}: ${msg_id}`);
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

  // Update user's FCM token (updates all 3 tiers)
  async update_user_fcm_token(userId: string, fcmToken: string): Promise<ResultType> {
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
