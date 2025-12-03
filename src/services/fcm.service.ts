import admin from 'firebase-admin';
import { eq, and } from 'drizzle-orm';
import db from '@/config/db';
import { user_model } from '@/models/user.model';
import { conversation_member_model } from '@/models/chat.model';
import { ChatMessagePayload } from '@/types/socket.types';
import { MessageType } from '@/types/chat.types';

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

interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
  chat_message?: ChatMessagePayload;
  type: 'message' | 'call' | 'call_end';
}

interface MessageNotificationData {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  messageBody?: ChatMessagePayload;
  messageType: MessageType;
}

interface CallNotificationData {
  callId: string;
  callerId: string;
  callerName: string;
  callerProfilePic?: string;
  callType: 'audio' | 'video';
}

export class FCMService {
  private static instance: FCMService;

  public static getInstance(): FCMService {
    if (!FCMService.instance) {
      FCMService.instance = new FCMService();
    }
    return FCMService.instance;
  }

  /**
   * Send push notification to a specific user
   */
  async sendNotificationToUser(
    user_id: number,
    payload: NotificationPayload
  ): Promise<boolean> {
    try {
      // Get user's FCM token from database
      const user = await db
        .select({ fcm_token: user_model.fcm_token })
        .from(user_model)
        .leftJoin(
          conversation_member_model,
          eq(user_model.id, conversation_member_model.user_id)
        )
        .where(
          and(
            eq(user_model.id, user_id),
            eq(conversation_member_model.deleted, false),
            payload.data?.conversationId
              ? eq(conversation_member_model.conversation_id, Number(payload.data?.conversationId))
              : undefined
          ))
        .limit(1);

      if (user.length === 0) {
        console.log(`[FCM] ${user_id} is not a member of the conversation ${payload.data?.conversationId}`);
        return false;
      }

      if (!user[0].fcm_token) {
        console.log(`[FCM] No FCM token found for user ${user_id}`);
        return false;
      }

      const fcmToken = user[0].fcm_token;

      const message: admin.messaging.Message = {
        token: fcmToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: {
          type: payload.type,
          ...payload.data,
          ...(payload.chat_message ? { chat_message: JSON.stringify(payload.chat_message) } : {}),
        },
        android: {
          priority: 'high',
          ttl: payload.type === 'call' ? 30000 : 2419200000, // 30 seconds for calls, 28 days for messages
          notification: {
            channelId: payload.type === 'call' ? 'calls' : 'messages',
            priority: payload.type === 'call' ? 'max' : 'high',
            sticky: payload.type === 'call' ? true : false,
            sound: 'default',
            vibrateTimingsMillis: [0, 250, 250, 250],
            // Group notifications for WhatsApp-like behavior
            ...(payload.type === 'message' && payload.data?.conversationId ? {
              tag: `conversation_${payload.data.conversationId}`, // Group by conversation
              // group: 'messages_group', // All messages in same group
            } : {}),
          },
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

      const response = await admin.messaging().send(message);
      console.log(`[FCM] Successfully sent notification to user ${user_id}: ${response}`);
      return true;
    } catch (error: any) {
      if (error.code === 'messaging/registration-token-not-registered') {
        console.error(`[FCM] Error sending notification to user ${user_id}: Invalid FCM Token`);
      } else {
        console.error(`[FCM] Error sending notification to user ${user_id}: `, error);
      }
      return false;
    }
  }

  /**
   * Send message notification
   */
  async sendMessageNotification(
    userId: number,
    data: MessageNotificationData
  ): Promise<boolean> {

    const payload: NotificationPayload = {
      title: `${data.senderName}`,
      body: this._formatMessageBody(data.messageBody),
      type: 'message',
      data: {
        conversationId: data.conversationId,
        messageId: data.messageId,
        senderId: data.senderId,
        senderName: data.senderName,
        messageType: data.messageType,
        messagePayload: data.messageBody
      },
      // Include chat_message for local DB storage
      chat_message: data.messageBody,
    };

    return await this.sendNotificationToUser(userId, payload);
  }

  /**
   * Send call notification
   */
  async sendCallNotification(
    userId: number,
    data: CallNotificationData
  ): Promise<boolean> {
    try {
      // Get user's FCM token from database
      const user = await db
        .select({ fcm_token: user_model.fcm_token })
        .from(user_model)
        .where(eq(user_model.id, userId))
        .limit(1);

      if (user.length === 0 || !user[0].fcm_token) {
        console.log(`[FCM] No FCM token found for user ${userId}`);
        return false;
      }

      const fcmToken = user[0].fcm_token;

      // Special message structure for call notifications with action buttons
      const message: admin.messaging.Message = {
        token: fcmToken,
        // notification: {
        //     title: `Incoming ${data.callType} call`,
        //     body: `${data.callerName} is calling you`,
        // },
        data: {
          type: 'call',
          callId: data.callId,
          callerId: data.callerId,
          callerName: data.callerName,
          callType: data.callType,
          callerProfilePic: data.callerProfilePic || '',
          // title: `Incoming ${data.callType} call`,
          // body: `${data.callerName} is calling you`,
          // Add action data for Flutter to handle
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        // android: {
        //   priority: 'high',
        //   ttl: 30000, // 30 seconds for call notifications
        //   notification: {
        //     channelId: 'calls',
        //     priority: 'max',
        //     sticky: true,
        //     sound: 'default',
        //     vibrateTimingsMillis: [0, 250, 250, 250],
        //     visibility: "public",
        //     // tag: `call_${data.callId}`, // Group by call ID
        //     // actions are not directly supported in FCM for Android,
        //     // Add action buttons (handled in Flutter)
        //   },
        //   // data: {
        //   //   type: 'call',
        //   //   callId: data.callId,
        //   //   callerId: data.callerId,
        //   //   callerName: data.callerName,
        //   //   callType: data.callType,
        //   //   callerProfilePic: data.callerProfilePic || '',
        //   //   title: `Incoming ${data.callType} call`,
        //   //   body: `${data.callerName} is calling you`,
        //   // },
        // },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              contentAvailable: true,
              category: 'CALL_CATEGORY', // iOS action category
              mutableContent: true,
              alert: {
                title: `Incoming ${data.callType} call`,
                body: `${data.callerName} is calling you`,
              },
            },
          },
          headers: {
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': (Math.floor(Date.now() / 1000) + 30).toString(), // 30 seconds
          },
        },
      };

      const response = await admin.messaging().send(message);
      console.log(`[FCM] Successfully sent call notification to user ${userId}: ${response}`);
      return true;
    } catch (error) {
      console.error(`[FCM] Error sending call notification to user ${userId}:`, error);
      return false;
    }
  }

  // Update user's FCM token
  async updateUserFCMToken(userId: number, fcmToken: string): Promise<boolean> {
    try {
      await db
        .update(user_model)
        .set({ fcm_token: fcmToken })
        .where(eq(user_model.id, userId));

      console.log(`[FCM] Updated FCM token for user ${userId}`);
      return true;
    } catch (error) {
      console.error(`[FCM] Error updating FCM token for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Remove user's FCM token (on logout)
   */
  async removeUserFCMToken(userId: number): Promise<boolean> {
    try {
      await db
        .update(user_model)
        .set({ fcm_token: null })
        .where(eq(user_model.id, userId));

      console.log(`[FCM] Removed FCM token for user ${userId}`);
      return true;
    } catch (error) {
      console.error(`[FCM] Error removing FCM token for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Format message body based on message type
   */
  private _formatMessageBody(message?: ChatMessagePayload): string {

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

  /**
   * Send bulk notifications for group messages
   */
  async sendBulkMessageNotifications(
    user_ids: number[],
    msg_payload?: ChatMessagePayload,
  ): Promise<{ success: number; failed: number }> {
    const messageId = Date.now().toString(); // Use timestamp as message ID for notifications

    const promises = user_ids.map(async (user_id) => {

      // Don't send notification to sender
      if (user_id === msg_payload?.sender_id) return;

      // return await this.sendMessageNotification(user_id, msg_payload);
      return await this.sendNotificationToUser(user_id, {
        title: `${msg_payload?.sender_name || 'New Message'}`,
        body: this._formatMessageBody(msg_payload),
        type: 'message',
        chat_message: msg_payload
      });
    });

    const results = await Promise.allSettled(promises);

    const success = results.filter(result => result.status === 'fulfilled' && result.value === true).length;
    const failed = results.length - success;

    return { success, failed };
  }
}

export default FCMService.getInstance();
