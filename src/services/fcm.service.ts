import admin from 'firebase-admin';
import { eq } from 'drizzle-orm';
import db from '@/config/db';
import { user_model } from '@/models/user.model';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    // credential: admin.credential.applicationDefault(),
    // You can also use a service account key file:
    credential: admin.credential.cert({
      projectId: "hehe-fd133",
      clientEmail: "firebase-adminsdk-fbsvc@hehe-fd133.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDXE16rYEaPyazz\nwu5I692Goqt+ywgmHqIrg94AyViaRK7fA7Y/OwcNcLZsG4+CGd6H405cW7ZjiP+D\nyU9j1qjKQZSk2hd9W4CjyriTAztIuj2UfkpsAA+cOHbPfASYENlxVbQeDlFvFU+f\nVb/LJeN/gZFNChziDSQ/aZY4q2EpfCmN4mEjcMwFdNLdUHmzKFyMsAHARL4jI8Hb\nTtJw7P7SGJ0KPmQIuVd4aYVPvmn9kjR25ABF3dD/yMGyhbboCiRkyDit5kso2GN3\nYTQV6+AK7vsyB90M9lhNHPehMcidHRUXwkl5XY9k1aCOsYKXKKKBLS8mvKereEQ2\nVmCLMycNAgMBAAECggEATx6cC/Vt38V0L3Q9TmweYUIETq+H/uX0CIgJKkbnplCv\n9/CYoagoTwRwx1JYN6cmmty+3fELJpCmVqe+4d5813LKqN5mF8KKjzarMcHVlEqX\nDsJqxFI9a93Fr0xTMFG6fBvoF8pyoKe5U8cquCPnDefvOOUIfQwSkpVYIt7A7o5G\nQfVJGn92XuoaaCvktBlVekouiqG+qyRTlPImJkda2afwde6oKzptTCqYclzZ5K7c\nI5od90CasUd/RvQBJzQd+692QeCSYChn1IqP8WW7otzfbhUx79t3F1nS4F/4BkuM\nen7uKKpUoqj9FB958AISZzPheB6qkgtPUBkfOKLQLQKBgQD/jCqmIqpHd8nDCxpt\nxdQlF4riN3KLez5ANpC+k+uY+cmOPpEzyXC/IeUckalIXBHarXzAPOBrDesu5fmE\nAOLsLJ/pjd4vreaQl4mq2Y6pLl9hSEp8R5PK+W2qBiUg3sjuu496FGrxwBCy5jiE\nILa/7DxsczYEdCvg+vQr5NF4QwKBgQDXdNu58YgwXcuVKiOlaq3k1DG9W7ttwmED\nL4SLva+yu6Qp0icLbHVuYNF4pj2w68plH1B9ITRWr/RwjL0K4/RFNTNn7RuBKlI1\nGyxyVQ4xBpVVAq0DyOfxA8grS51RD/UK+YcPfdUHlXuRfSS8a+PZM+qwtrBUL59d\n8I0EDUjWbwKBgEVxQHGu/9i164Tt8nucA58ku5/nc2AF2I+4hDLVnXMPhb76r5iE\nB/hYbJsL1hWMt2lWNY1DvbQ5rwwqgFhnqUKGidn8rEEGn53xH/7macb9i/uymlMV\nXEsO5scKLnK1N6LwIvgIrlsNVzxWJUt6XE7hEjZiRG6HZxkW+N0oq+djAoGACzXn\nYOtyXKHkv+QraqX8WlW4KNQnEnT0u0ezq9m41KHyzsJCidOg4JdlDtQHjbcXFt/k\nPj6GDKSnIVwRUgm+YgN8o0GxFq1vDZhWXbSTQnXHO18iRXokp2O8/JO4ockkxOdq\n4aF4fiaHAXDzgmJSvrB2268FybuYnTiw/a77RT0CgYASK7Yufh6Ap57K1wGFaxaI\nNlN5Urm4TqUS3y5K0DsarCDFMkVCaTUilh8yWcMS+783FD0b48L6uki13cI2rhmB\nstWXM2YMPfdA12DkFRxzlAo5s4LCzznjazaBukb9S82Lo4xfbTdmgcI9onodTD3+\n28fzt3aw5lxM42gQ4UFDhA==\n-----END PRIVATE KEY-----\n"

    }),
  });
}

interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  type: 'message' | 'call';
}

interface MessageNotificationData {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  messageBody?: string;
  messageType: string;
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
    userId: number,
    payload: NotificationPayload
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

      const message: admin.messaging.Message = {
        token: fcmToken,
        // notification: {
        //   title: payload.title,
        //   body: payload.body,
        // },
        // data: {
        //   type: payload.type,
        //   ...payload.data,
        // },
        android: {
          priority: 'high',
          notification: {
            channelId: payload.type === 'call' ? 'calls' : 'messages',
            priority: payload.type === 'call' ? 'high' : 'default',
            sound: 'default',
            vibrateTimingsMillis: [0, 250, 250, 250],
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
      console.log(`[FCM] Successfully sent notification to user ${userId}: ${response}`);
      return true;
    } catch (error) {
      console.error(`[FCM] Error sending notification to user ${userId}:`, error);
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
      title: `New message from ${data.senderName}`,
      body: this._formatMessageBody(data.messageBody, data.messageType),
      type: 'message',
      data: {
        conversationId: data.conversationId,
        messageId: data.messageId,
        senderId: data.senderId,
        senderName: data.senderName,
        messageType: data.messageType,
      },
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
        //   title: `Incoming ${data.callType} call`,
        //   body: `${data.callerName} is calling you`
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
        android: {
          priority: 'high',
          ttl: 30000, // 30 seconds for call notifications
          notification: {
            channelId: 'calls',
            priority: 'high',
            sound: 'default',
            vibrateTimingsMillis: [0, 250, 250, 250],
            visibility: "public"
            // Add action buttons (handled in Flutter)
          },
          data: {
            type: 'call',
            callId: data.callId,
            callerId: data.callerId,
            callerName: data.callerName,
            callType: data.callType,
            callerProfilePic: data.callerProfilePic || '',
            title: `Incoming ${data.callType} call`,
            body: `${data.callerName} is calling you`,
          },
        },
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

  /**
   * Send notification to multiple users
   */
  async sendNotificationToUsers(
    userIds: number[],
    payload: NotificationPayload
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    const promises = userIds.map(async (userId) => {
      const result = await this.sendNotificationToUser(userId, payload);
      if (result) {
        success++;
      } else {
        failed++;
      }
    });

    await Promise.all(promises);

    console.log(`[FCM] Sent notifications: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  /**
   * Update user's FCM token
   */
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
  private _formatMessageBody(messageBody?: string, messageType?: string): string {
    if (!messageBody) {
      switch (messageType) {
        case 'image':
          return '📷 Photo';
        case 'video':
          return '🎥 Video';
        case 'audio':
          return '🎵 Voice message';
        case 'file':
          return '📎 File';
        case 'location':
          return '📍 Location';
        case 'media':
          return '📎 Media';
        case 'reply':
          return '↩️ Reply';
        case 'forward':
          return '↪️ Forwarded message';
        default:
          return 'New message';
      }
    }

    // Add prefix for special message types
    switch (messageType) {
      case 'reply':
        return `↩️ ${messageBody.length > 90 ? messageBody.substring(0, 90) + '...' : messageBody}`;
      case 'forward':
        return '↪️ Forwarded message';
      default:
        // Truncate long messages
        if (messageBody.length > 100) {
          return messageBody.substring(0, 100) + '...';
        }
        return messageBody;
    }
  }

  /**
   * Send bulk notifications for group messages
   */
  async sendBulkMessageNotifications(
    userIds: number[],
    conversationId: string,
    senderId: string,
    senderName: string,
    messageBody?: string,
    messageType: string = 'text'
  ): Promise<{ success: number; failed: number }> {
    const messageId = Date.now().toString(); // Use timestamp as message ID for notifications

    const promises = userIds.map(async (userId) => {
      if (userId.toString() === senderId) {
        return; // Don't send notification to sender
      }

      const data: MessageNotificationData = {
        conversationId,
        messageId,
        senderId,
        senderName,
        messageBody,
        messageType,
      };

      return await this.sendMessageNotification(userId, data);
    });

    const results = await Promise.allSettled(promises);

    const success = results.filter(result => result.status === 'fulfilled' && result.value === true).length;
    const failed = results.length - success;

    return { success, failed };
  }
}

export default FCMService.getInstance();
