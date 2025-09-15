import { authenticate_jwt } from '@/middleware';
import { Elysia, t } from 'elysia';
import db from '@/config/db';
import { message_model, conversation_model, conversation_member_model } from '@/models/chat.model';
import { eq, and, or, sql } from 'drizzle-orm';
import { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS } from '@/types/chat.types';
import { ElysiaWS } from 'elysia/dist/ws';
import { WebSocket } from 'bun';

// Connection management
interface UserConnection {
  ws: ElysiaWS; // Elysia WebSocket
  user_id: number;
  last_seen: Date;
  conversations: Set<number>; // Active conversation IDs
}

const connections = new Map<number, UserConnection>();
const conversation_connections = new Map<number, Set<number>>(); // conversation_id -> Set<user_id>

// Message types for WebSocket communication
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

// Helper functions
const add_connection = (user_id: number, ws: ElysiaWS) => {
  // Close existing connection if any
  if (connections.has(user_id)) {
    const existing = connections.get(user_id);
    existing?.ws.close(4000, "New Connection Established");
  }

  const connection: UserConnection = {
    ws,
    user_id,
    last_seen: new Date(),
    conversations: new Set()
  };

  connections.set(user_id, connection);
  console.log(`[WS] User ${user_id} connected. Total connections: ${connections.size}`);
};

const remove_connection = (user_id: number) => {
  const connection = connections.get(user_id);
  if (connection) {
    // Remove from all conversations
    connection.conversations.forEach(conv_id => {
      const conv_connections = conversation_connections.get(conv_id);
      if (conv_connections) {
        conv_connections.delete(user_id);
        if (conv_connections.size === 0) {
          conversation_connections.delete(conv_id);
        }
      }
    });

    connections.delete(user_id);
    console.log(`[WS] User ${user_id} disconnected. Total connections: ${connections.size}`);
  }
};

const join_conversation = (user_id: number, conversation_id: number) => {
  const connection = connections.get(user_id);
  if (connection) {
    connection.conversations.add(conversation_id);

    if (!conversation_connections.has(conversation_id)) {
      conversation_connections.set(conversation_id, new Set());
    }
    conversation_connections.get(conversation_id)?.add(user_id);

    console.log(`[WS] User ${user_id} joined conversation ${conversation_id}`);
  }
};

const leave_conversation = (user_id: number, conversation_id: number) => {
  const connection = connections.get(user_id);
  if (connection) {
    connection.conversations.delete(conversation_id);

    const conv_connections = conversation_connections.get(conversation_id);
    if (conv_connections) {
      conv_connections.delete(user_id);
      if (conv_connections.size === 0) {
        conversation_connections.delete(conversation_id);
      }
    }

    console.log(`[WS] User ${user_id} left conversation ${conversation_id}`);
  }
};

const broadcast_to_conversation = (conversation_id: number, message: WSMessage, exclude_user?: number) => {
  const conv_connections = conversation_connections.get(conversation_id);
  if (!conv_connections) return;

  const message_str = JSON.stringify(message);
  let sent_count = 0;

  conv_connections.forEach(user_id => {
    if (exclude_user && user_id === exclude_user) return;

    const connection = connections.get(user_id);
    if (connection && connection.ws.readyState === 1) { // WebSocket.OPEN
      try {
        connection.ws.send(message_str);
        sent_count++;
      } catch (error) {
        console.error(`[WS] Error sending to user ${user_id}:`, error);
        remove_connection(user_id);
      }
    }
  });

  console.log(`[WS] Broadcasted to ${sent_count} users in conversation ${conversation_id}`);
};

const send_to_user = (user_id: number, message: WSMessage) => {
  const connection = connections.get(user_id);
  if (connection && connection.ws.readyState === 1) {
    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`[WS] Error sending to user ${user_id}:`, error);
      remove_connection(user_id);
      return false;
    }
  }
  return false;
};

// WebSocket server
const web_socket = new Elysia()
  .ws('/chat', {

    body: t.Object({
      message: t.Object(
        {
          type: t.String(),
          data: t.Any(),
          conversation_id: t.Optional(t.Number()),
          message_id: t.Optional(t.Number()),
          timestamp: t.Optional(t.String())
        }
      )
    }),

    query: t.Object({
      id: t.Number(),
    }),

    open: async (ws) => {
      try {

        // const user_id = new URL(ws.data.request.url).searchParams.get('user_id')
        // if (!user_id {
        //   ws.close(4001, "Missing User ID");
        //   return;
        // }

        // Extract and validate JWT token
        const url = new URL(ws.data.request.url);
        const token = url.searchParams.get('token');

        if (!token) {
          ws.close(4001, "Missing authentication token");
          return;
        }

        // Verify JWT token
        const auth_result = authenticate_jwt(token);
        if (!auth_result.success || !auth_result.data) {
          ws.close(4001, "Invalid authentication token");
          return;
        }

        const user_id = auth_result.data.id;

        // Store user_id in WebSocket data
        (ws.data as any).user_id = user_id;

        add_connection(user_id, ws);

        // Send welcome message
        send_to_user(user_id, {
          type: 'message',
          data: { message: 'Connected to chat server' },
          timestamp: new Date().toISOString()
        });

        console.log(`[WS] User ${user_id} authenticated and connected`);
      } catch (error) {
        console.error('[WS] Error in connection:', error);
        ws.close(4000, "Connection error");
      }
    },

    message: async (ws, { message }) => {
      try {
        const user_id = ws.data.query.id

        // Update last seen timestamp
        const connection = connections.get(user_id);
        if (connection) {
          connection.last_seen = new Date();
        }

        switch (message.type) {
          case 'ping':
            send_to_user(user_id, { type: 'pong', data: {}, timestamp: new Date().toISOString() });
            break;

          case 'join_conversation':
            if (message.conversation_id) {
              // Verify user is member of conversation
              const membership = await db
                .select()
                .from(conversation_member_model)
                .where(
                  and(
                    eq(conversation_member_model.conversation_id, message.conversation_id),
                    eq(conversation_member_model.user_id, user_id)
                  )
                )
                .limit(1);

              if (membership.length > 0) {
                join_conversation(user_id, message.conversation_id);
                send_to_user(user_id, {
                  type: 'join_conversation',
                  data: { conversation_id: message.conversation_id, success: true },
                  conversation_id: message.conversation_id,
                  timestamp: new Date().toISOString()
                });
              } else {
                send_to_user(user_id, {
                  type: 'error',
                  data: { message: 'Not authorized to join this conversation' },
                  timestamp: new Date().toISOString()
                });
              }
            }
            break;

          case 'leave_conversation':
            if (message.conversation_id) {
              leave_conversation(user_id, message.conversation_id);
              send_to_user(user_id, {
                type: 'leave_conversation',
                data: { conversation_id: message.conversation_id, success: true },
                conversation_id: message.conversation_id,
                timestamp: new Date().toISOString()
              });
            }
            break;

          case 'message':
            if (message.conversation_id && message.data) {
              // Save message to database
              const new_message = await db
                .insert(message_model)
                .values({
                  conversation_id: message.conversation_id,
                  sender_id: user_id,
                  type: message.data.type || 'text',
                  body: message.data.body,
                  attachments: message.data.attachments,
                  metadata: message.data.metadata
                })
                .returning();

              if (new_message.length > 0) {
                const saved_message = new_message[0];

                // Get sender name
                const sender = await db
                  .select({ name: sql<string>`users.name` })
                  .from(sql`users`)
                  .where(eq(sql`users.id`, user_id))
                  .limit(1);

                const chat_message: ChatMessage = {
                  id: saved_message.id,
                  conversation_id: saved_message.conversation_id,
                  sender_id: saved_message.sender_id,
                  type: saved_message.type,
                  body: saved_message.body || undefined,
                  attachments: saved_message.attachments as any[] || undefined,
                  metadata: saved_message.metadata as any || undefined,
                  created_at: saved_message.created_at.toISOString(),
                  sender_name: sender[0]?.name
                };

                // Broadcast to conversation members
                broadcast_to_conversation(message.conversation_id, {
                  type: 'message',
                  data: chat_message,
                  conversation_id: message.conversation_id,
                  message_id: saved_message.id,
                  timestamp: new Date().toISOString()
                }, user_id);

                // Update conversation last_message_at
                await db
                  .update(conversation_model)
                  .set({ last_message_at: new Date() })
                  .where(eq(conversation_model.id, message.conversation_id));
              }
            }
            break;

          case 'typing':
            if (message.conversation_id) {
              broadcast_to_conversation(message.conversation_id, {
                type: 'typing',
                data: { user_id, is_typing: message.data.is_typing },
                conversation_id: message.conversation_id,
                timestamp: new Date().toISOString()
              }, user_id);
            }
            break;

          case 'read_receipt':
            if (message.conversation_id && message.message_id) {
              // Update read receipt in database
              await db
                .update(conversation_member_model)
                .set({ last_read_message_id: message.message_id })
                .where(
                  and(
                    eq(conversation_member_model.conversation_id, message.conversation_id),
                    eq(conversation_member_model.user_id, user_id)
                  )
                );

              broadcast_to_conversation(message.conversation_id, {
                type: 'read_receipt',
                data: { user_id, message_id: message.message_id },
                conversation_id: message.conversation_id,
                timestamp: new Date().toISOString()
              }, user_id);
            }
            break;

          default:
            send_to_user(user_id, {
              type: 'error',
              data: { message: 'Unknown message type' },
              timestamp: new Date().toISOString()
            });
        }
      } catch (error) {
        console.error('[WS] Error processing message:', error);
        send_to_user((ws.data as any).user_id, {
          type: 'error',
          data: { message: 'Invalid message format' },
          timestamp: new Date().toISOString()
        });
      }
    },

    close: (ws) => {
      if (ws.data.query.id) {
        remove_connection(ws.data.query.id);
      }
    }

  });

// Connection monitoring and cleanup
const startConnectionMonitor = () => {
  setInterval(() => {
    const now = new Date();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    connections.forEach((connection, user_id) => {
      const timeSinceLastSeen = now.getTime() - connection.last_seen.getTime();

      if (timeSinceLastSeen > staleThreshold) {
        console.log(`[WS] Removing stale connection for user ${user_id}`);
        remove_connection(user_id);
      }
    });
  }, 60000); // Check every minute
};

// Start monitoring
startConnectionMonitor();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[WS] Shutting down WebSocket server...');

  // Notify all connected users
  connections.forEach((connection) => {
    try {
      connection.ws.send(JSON.stringify({
        type: 'message',
        data: { message: 'Server is shutting down' },
        timestamp: new Date().toISOString()
      }));
      connection.ws.close(1001, 'Server shutdown');
    } catch (error) {
      console.error('[WS] Error closing connection:', error);
    }
  });

  connections.clear();
  conversation_connections.clear();
  process.exit(0);
});

// Export connection management functions for use in other parts of the app
export {
  connections,
  conversation_connections,
  broadcast_to_conversation,
  send_to_user,
  add_connection,
  remove_connection,
  join_conversation,
  leave_conversation
};
export default web_socket;
