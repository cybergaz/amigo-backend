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
      privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCKP53aMlRVZ6bS\nlKEriCwHsDr9EPh57M0tMjWpz0velAAMR+isL38RfM9X1PsszR7EbxFsPyvoouRB\nrdxk3nSjI30M9OJ3Xnx8Wc6Y7BEcoA9B0iO9Oeamh9wuqSV6RWYkxXfYYtUFhVia\nOyfRKI+AVgsSctUzUiiZTfM9/f8g7AQ0qoPWwgYzhTuikrt8UgLe7NFrsSOJcu+S\nUlkD1aTvgyzgneoRPUknYbE/kiUXcJI/0MVjQakxr6GjdhgJKPz3uzAq+GPLGqpT\n4Mms8ukNlmQV2Eg7qsYrcROE3Z7BgsaWk8b+Mm5FGz7CrEz+Xay/nny2z2X9+bm7\nKU44QRdRAgMBAAECggEAApBvIYg+ElK0qFqdgerB2s9m67FWM4A79sDz9/smYomr\nFc86YoGzxRe0GpJiqYRBNCZle8UQ79zgGBQFBsmtvwYiLFSpM+q4qz+I7oMP5vCU\n0d0ngKuvkpKJ5+NnJJ0/iZJwUG8WWYatc9hhqt5qSXiHFmuy9sOJCV1l0+Y3doVF\nLME9WFFJfs+l/kqcMpWPMdjOfdp86n4CAPcfptE6GB0oFXXu3CbFvfzHNOSFpTXF\nnNg4C6ZJSDnYH3CNerU0iyzl3tzT7MZObZ+8duvWixvQ4tlFOTThDsQ/cEMNQhNY\nkjQugoCSI4lAAQg9EHeOU6BOwPoz7FyNkeIFehbjIQKBgQC+dMVKL3k6cQB6Xglc\nD6k+4ZHTtpiJ5IpeEjRHKeN6JXhyUEva7F+5Q0XDJrl3jvaIo2n1p1M9EuTOuaz8\ncoEvHJxEPLbwX81WvCuScgG/9Sw8t7bOcwftKpcmb2Dze9GyazhyY7S1N2JKkWU4\nADlmgX8vvzsqLXDFWXC0EzRW4QKBgQC501dqlH/ygMsp3uLayH5Su1g1T+f1zMft\nBqA5OFWdxaHcJKxJir4gND0qEcu0ZQVV4+JCtgfJt5jTFyIkyXa/Ju/KKpPkx8zA\nL5Hr102R1Bc69WA7rJP/Sf9bXx7rqc+jShCI8FjdNxOYsThRzN/9mWc1APXAC8WV\nPhjS++R+cQKBgQCv/5R5U5mBaf95FQEtM8PAug5aSLh5ZNqAx+3LfWga7hl5+b2/\nVwO2XfZPuq9VTqV/6xL10WRYYedTKb4zo1TBxnyZikm7o6xLZKQXNodrbhMtINAr\nw50li2AWQoKjPl6vs+l7u6u4cq/AHNAeigaBNVXlN6Bi/47gsCA4KC8LwQKBgGTn\niQlb19pT634yBJdu1YGRL4XLfRaw+0MPHQPVPlBs18aVt2Q7zZ/pHelxPl8Xl/0a\nwGsfMz1qz7aYUjcNmsiTmRP7aNGLWPhnHGKnR/zO4Upnobjlrnuqr9nq3fxz+kcd\n2bqyYF7HIIICgaWRjXPE0BEtE0UUX1b6IDq5A0tRAoGBAJXIJitEQ9LD6HfortIH\nxtNU+P9Sud/D9k5GeHRX8EQHfMPZeMy60JIkz5EdnLuuDBIt8J3b0sFdRJvl9uyo\noLgqe3slVe/qDkrb2SduAdt0dYvg6dCjyi1H/Z32PVt7MJKIO31VmAVco0ZtK0vz\nAdZjDI+rxq0YK8Bixcso1ygS\n-----END PRIVATE KEY-----\n"

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
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: {
          type: payload.type,
          ...payload.data,
        },
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
        data: {
          type: 'call',
          callId: data.callId,
          callerId: data.callerId,
          callerName: data.callerName,
          callType: data.callType,
          callerProfilePic: data.callerProfilePic || '',
          title: `Incoming ${data.callType} call`,
          body: `${data.callerName} is calling you`,
          // Add action data for Flutter to handle
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        android: {
          priority: 'high',
          ttl: 30000, // 30 seconds for call notifications
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
