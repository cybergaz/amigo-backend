import { send_to_user } from '@/sockets/web-socket';
import { CallService } from './call.service';

// WebSocket notification service for call events
export class WebSocketNotificationService {
  
  // Send call decline notifications via WebSocket
  static async sendCallDeclineNotification(callId: number, userId: number, reason?: string) {
    try {
      const active_call = CallService.get_user_active_call(userId);
      
      if (active_call) {
        // Notify caller
        const other_user = active_call.caller_id === userId ? active_call.callee_id : active_call.caller_id;
        
        await send_to_user(active_call.caller_id, {
          type: 'call:decline',
          callId: callId,
          from: userId,
          to: other_user,
          payload: { reason },
          timestamp: new Date().toISOString()
        });
        
        await send_to_user(userId, {
          type: 'call:decline',
          callId: callId,
          data: { success: true, reason },
          timestamp: new Date().toISOString()
        });
        
        return { success: true };
      }
      
      return { success: false, error: 'No active call found' };
    } catch (error) {
      console.error('[WS_NOTIFICATION] Error sending call decline notification:', error);
      return { success: false, error: 'Failed to send notification' };
    }
  }

  // Send call accept notifications via WebSocket
  static async sendCallAcceptNotification(callId: number, userId: number) {
    try {
      const active_call = CallService.get_user_active_call(userId);
      
      if (active_call) {
        // Notify caller
        await send_to_user(active_call.caller_id, {
          type: 'call:accept',
          callId: callId,
          from: userId,
          to: active_call.caller_id,
          timestamp: new Date().toISOString()
        });

        // Acknowledge to callee
        await send_to_user(userId, {
          type: 'call:accept',
          callId: callId,
          from: userId,
          to: active_call.caller_id,
          data: { success: true },
          timestamp: new Date().toISOString()
        });
        
        return { success: true };
      }
      
      return { success: false, error: 'No active call found' };
    } catch (error) {
      console.error('[WS_NOTIFICATION] Error sending call accept notification:', error);
      return { success: false, error: 'Failed to send notification' };
    }
  }

  // Send call end notifications via WebSocket
  static async sendCallEndNotification(callId: number, userId: number, reason?: string, duration?: number) {
    try {
      const active_call = CallService.get_user_active_call(userId);
      
      if (active_call) {
        const other_user = active_call.caller_id === userId ? active_call.callee_id : active_call.caller_id;

        await send_to_user(other_user, {
          type: 'call:end',
          callId: callId,
          from: userId,
          to: other_user,
          payload: {
            reason,
            duration
          },
          timestamp: new Date().toISOString()
        });

        await send_to_user(userId, {
          type: 'call:end',
          callId: callId,
          data: { success: true, duration },
          timestamp: new Date().toISOString()
        });
        
        return { success: true };
      }
      
      return { success: false, error: 'No active call found' };
    } catch (error) {
      console.error('[WS_NOTIFICATION] Error sending call end notification:', error);
      return { success: false, error: 'Failed to send notification' };
    }
  }
}
