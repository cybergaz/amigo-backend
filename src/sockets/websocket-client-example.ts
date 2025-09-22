/**
 * WebSocket Client Example for Chat App
 * This file demonstrates how to connect to and use the WebSocket chat server
 */

interface WSMessage {
  type: 'message' | 'typing' | 'read_receipt' | 'join_conversation' | 'leave_conversation' | 'error' | 'ping' | 'pong';
  data: any;
  conversation_id?: number;
  message_id?: number;
  timestamp?: string;
}

interface ChatMessage {
  id: number;
  conversation_id: number;
  sender_id: number;
  type: string;
  body?: string;
  attachments?: any[];
  metadata?: any;
  created_at: string;
  sender_name?: string;
}

class ChatWebSocketClient {
  private ws: WebSocket | null = null;
  private token: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor(token: string) {
    this.token = token;
  }

  connect(serverUrl: string = 'ws://localhost:3000') {
    try {
      const wsUrl = `${serverUrl}/chat?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startPingInterval();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };

      this.ws.onclose = (event) => {
        this.isConnected = false;
        this.stopPingInterval();

        // Attempt to reconnect if not a normal closure
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error connecting to WebSocket:', error);
    }
  }

  private scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startPingInterval() {
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.send({ type: 'ping', data: {} });
      }
    }, 30000); // Ping every 30 seconds
  }

  private stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleMessage(message: WSMessage) {
    switch (message.type) {
      case 'pong':
        console.log('Received pong');
        break;

      case 'message':
        this.onMessage?.(message.data as ChatMessage);
        break;

      case 'typing':
        this.onTyping?.(message.data.user_id, message.data.is_typing);
        break;

      case 'read_receipt':
        this.onReadReceipt?.(message.data.user_id, message.data.message_id);
        break;

      case 'join_conversation':
        this.onJoinConversation?.(message.data.conversation_id, message.data.success);
        break;

      case 'leave_conversation':
        this.onLeaveConversation?.(message.data.conversation_id, message.data.success);
        break;

      case 'error':
        console.error('Server error:', message.data.message);
        this.onError?.(message.data.message);
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  // Public methods for sending messages
  send(message: WSMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
    }
  }

  joinConversation(conversationId: number) {
    this.send({
      type: 'join_conversation',
      data: {},
      conversation_id: conversationId
    });
  }

  leaveConversation(conversationId: number) {
    this.send({
      type: 'leave_conversation',
      data: {},
      conversation_id: conversationId
    });
  }

  sendMessage(conversationId: number, message: {
    type?: 'text' | 'system' | 'attachment' | 'reaction';
    body?: string;
    attachments?: any[];
    metadata?: any;
  }) {
    this.send({
      type: 'message',
      data: {
        type: message.type || 'text',
        body: message.body,
        attachments: message.attachments,
        metadata: message.metadata
      },
      conversation_id: conversationId
    });
  }

  sendTyping(conversationId: number, isTyping: boolean) {
    this.send({
      type: 'typing',
      data: { is_typing: isTyping },
      conversation_id: conversationId
    });
  }

  sendReadReceipt(conversationId: number, messageId: number) {
    this.send({
      type: 'read_receipt',
      data: {},
      conversation_id: conversationId,
      message_id: messageId
    });
  }

  disconnect() {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.isConnected = false;
  }

  // Event handlers (to be set by the application)
  onMessage?: (message: ChatMessage) => void;
  onTyping?: (userId: number, isTyping: boolean) => void;
  onReadReceipt?: (userId: number, messageId: number) => void;
  onJoinConversation?: (conversationId: number, success: boolean) => void;
  onLeaveConversation?: (conversationId: number, success: boolean) => void;
  onError?: (error: string) => void;
}

// Usage example:
/*
const client = new ChatWebSocketClient('your-jwt-token');

// Set up event handlers
client.onMessage = (message) => {
  console.log('New message:', message);
  // Update UI with new message
};

client.onTyping = (userId, isTyping) => {
  console.log(`User ${userId} is ${isTyping ? 'typing' : 'not typing'}`);
  // Update UI to show typing indicator
};

client.onReadReceipt = (userId, messageId) => {
  console.log(`User ${userId} read message ${messageId}`);
  // Update UI to show read status
};

// Connect to server
client.connect('ws://localhost:3000');

// Join a conversation
client.joinConversation(123);

// Send a text message
client.sendMessage(123, {
  type: 'text',
  body: 'Hello, world!'
});

// Send typing indicator
client.sendTyping(123, true);

// Send read receipt
client.sendReadReceipt(123, 456);

// Leave conversation
client.leaveConversation(123);

// Disconnect
client.disconnect();
*/

export { ChatWebSocketClient, WSMessage, ChatMessage };
