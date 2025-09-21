import { authenticate_jwt } from '@/middleware';
import { Elysia, t } from 'elysia';
import db from '@/config/db';
import { message_model, conversation_model, conversation_member_model } from '@/models/chat.model';
import { eq, and, or, sql } from 'drizzle-orm';
import { ElysiaWS } from 'elysia/dist/ws';
import { WebSocketData, TypedElysiaWS } from '@/types/elysia.types';
import { user_model } from '@/models/user.model';
import { forward_messages, pin_message, reply_to_message, star_messages, store_media } from '@/services/message-operations.services';

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
  type: 'message' | 'typing' | 'read_receipt' | 'join_conversation' | 'leave_conversation' | 'error' | 'ping' | 'pong' | 'message_pin' | 'message_star' | 'message_reply' | 'message_forward' | 'message_delete' | 'media';
  data?: any;
  conversation_id?: number;
  message_ids?: number[];
  timestamp?: string;
}

interface ChatMessage {
  id: number;
  optimistic_id?: string;
  conversation_id: number;
  sender_id: number;
  type: string;
  body?: string;
  attachments?: any[];
  metadata?: any;
  created_at: string;
  sender_name?: string;
}

// Type-safe WebSocket data access helpers
const setUserId = (ws: ElysiaWS, user_id: number): void => {
  (ws.data as WebSocketData).user_id = user_id;
};

const getUserId = (ws: ElysiaWS): number | undefined => {
  return (ws.data as WebSocketData).user_id;
};

const hasUserId = (ws: ElysiaWS): boolean => {
  return (ws.data as WebSocketData).user_id !== undefined;
};

// More convenient helper that throws if user_id is not set
const requireUserId = (ws: ElysiaWS): number => {
  const user_id = getUserId(ws);
  if (!user_id) {
    throw new Error('User ID not found in WebSocket data');
  }
  return user_id;
};

// Safe user_id access with fallback
const getUserIdOr = (ws: ElysiaWS, fallback: number): number => {
  return getUserId(ws) ?? fallback;
};

// Helper functions
const add_connection = async (user_id: number, ws: ElysiaWS) => {
  // fetch all conversation IDs for this user from the database
  const memberships = await db
    .select({ conversation_id: conversation_member_model.conversation_id })
    .from(conversation_member_model)
    .where(eq(conversation_member_model.user_id, user_id));

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
  memberships.forEach(row => {
    join_conversation(user_id, row.conversation_id);
  })
  // console.log('ws connection : ')
  // console.log("connections ->", connections)
  // console.log("conversation_connections ->", conversation_connections)
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
    // send message to online users, else increase the unread count in the database
    if (connection && connection.ws.readyState === 1) {
      try {
        connection.ws.send(message_str);
        sent_count++;
      } catch (error) {
        console.error(`[WS] Error sending to user ${user_id}:`, error);
        remove_connection(user_id);
      }
    }
    else {
      // increase unread count in the database
      db.update(conversation_member_model)
        .set({ unread_count: sql`${conversation_member_model.unread_count} + 1` })
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            eq(conversation_member_model.user_id, user_id)
          )
        )
        .then(() => {
          console.log(`[WS] Increased unread count for inactive user ${user_id} in conversation ${conversation_id}`);
        })
        .catch((error) => {
          console.error(`[WS] Error increasing unread count for user ${user_id}:`, error);
        });
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
      type: t.String(),
      data: t.Optional(t.Any()),
      conversation_id: t.Optional(t.Number()),
      message_ids: t.Optional(t.Array(t.Number())),
      user_id: t.Optional(t.Number()), // for certain actions like reply where user_id may differ
      timestamp: t.Optional(t.String())
    }),

    query: t.Object({
      token: t.Optional(t.String())
    }),

    open: async (ws) => {
      try {
        console.log('[WS] New connection attempt');

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

        // Store user_id in WebSocket data using type-safe helper
        setUserId(ws, user_id);

        // -----------------------------------------------------------------------
        // you just have to fetch all conversation IDs for this user,
        // and store them in either connections.conversations or a new Map,
        // and then send the message to all the conversation IDs (idk how will you find sockets for them)
        // -----------------------------------------------------------------------
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

    message: async (ws, message) => {
      try {
        const user_id = getUserId(ws);
        if (!user_id) {
          ws.send(JSON.stringify({
            code: 4001,
            message: "Missing User ID in the socket, try reconnecting..."
          }));
          return
        }

        // Update last seen timestamp
        const connection = connections.get(user_id);
        if (connection) {
          connection.last_seen = new Date();
        }

        switch (message.type) {
          case 'ping':
            send_to_user(user_id, { type: 'pong', data: message.data || {}, timestamp: new Date().toISOString() });
            break;

          case 'join_conversation':
            if (message.conversation_id) {
              // -----------------------------------------------------------
              // TEMPORARY BYPASS AUTHORIZATION CHECK (FOR TESTING ONLY)
              // -----------------------------------------------------------
              // Verify user is member of conversation
              // const membership = await db
              //   .select()
              //   .from(conversation_member_model)
              //   .where(
              //     and(
              //       eq(conversation_member_model.conversation_id, message.conversation_id),
              //       eq(conversation_member_model.user_id, user_id)
              //     )
              //   )
              //   .limit(1);

              // if (membership.length > 0) {
              join_conversation(user_id, message.conversation_id);
              send_to_user(user_id, {
                type: 'join_conversation',
                data: { success: true },
                conversation_id: message.conversation_id,
                timestamp: new Date().toISOString()
              });
              // } else {
              //   send_to_user(user_id, {
              //     type: 'error',
              //     data: { message: 'Not authorized to join this conversation' },
              //     timestamp: new Date().toISOString()
              //   });
              // }
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
                // const sender = await db
                //   .select({ name: user_model.name })
                //   .from(user_model)
                //   .where(eq(user_model.id, user_id))
                //   .limit(1);

                const chat_message: ChatMessage = {
                  id: saved_message.id,
                  optimistic_id: message.data.optimistic_id || undefined, // echo back optimistic_id if provided
                  conversation_id: saved_message.conversation_id!,
                  sender_id: saved_message.sender_id,
                  type: saved_message.type,
                  body: saved_message.body || undefined,
                  attachments: saved_message.attachments as any[] || undefined,
                  metadata: saved_message.metadata as any || undefined,
                  created_at: saved_message.created_at.toISOString(),
                  // sender_name: sender[0]?.name
                };

                // Broadcast to conversation members
                broadcast_to_conversation(message.conversation_id, {
                  type: 'message',
                  data: chat_message,
                  conversation_id: message.conversation_id,
                  message_ids: [saved_message.id],
                  timestamp: new Date().toISOString()
                });

                // Update conversation last_message_at
                await db
                  .update(conversation_model)
                  .set({ metadata: { last_message: chat_message }, last_message_at: new Date() })
                  .where(eq(conversation_model.id, message.conversation_id));
              }
            }
            break;

          case 'typing':
            if (message.conversation_id) {
              broadcast_to_conversation(message.conversation_id, {
                type: 'typing',
                data: {
                  user_id,
                  is_typing: message.data.is_typing
                },
                conversation_id: message.conversation_id,
                timestamp: new Date().toISOString()
              }, user_id);
            }
            break;

          case 'read_receipt':
            if (message.conversation_id && message.message_ids) {
              // Update read receipt in database
              await db
                .update(conversation_member_model)
                .set({ last_read_message_id: message.message_ids[0] })
                .where(
                  and(
                    eq(conversation_member_model.conversation_id, message.conversation_id),
                    eq(conversation_member_model.user_id, user_id)
                  )
                );

              broadcast_to_conversation(message.conversation_id, {
                type: 'read_receipt',
                data: { user_id, message_id: message.message_ids[0] },
                conversation_id: message.conversation_id,
                timestamp: new Date().toISOString()
              }, user_id);
            }
            break;

          case 'message_pin':
            if (message.conversation_id && message.message_ids) {
              // Broadcast pin action to conversation members
              broadcast_to_conversation(message.conversation_id, {
                type: 'message_pin',
                data: {
                  user_id,
                  action: message.data?.action || 'toggle' // 'pin' or 'unpin'
                },
                conversation_id: message.conversation_id,
                message_ids: message.message_ids,
                timestamp: new Date().toISOString(),
              }, user_id);

              await pin_message({
                message_id: message.message_ids[0],
                conversation_id: message.conversation_id
              }, user_id)
            }
            break;

          case 'message_star':
            if (message.conversation_id && message.message_ids) {
              // Broadcast star action to conversation members (only to sender if private)
              broadcast_to_conversation(message.conversation_id, {
                type: 'message_star',
                data: {
                  user_id,
                  action: message.data?.action || 'toggle' // 'star' or 'unstar' or 'toggle'
                },
                conversation_id: message.conversation_id,
                message_ids: message.message_ids,
                timestamp: new Date().toISOString()
              }, user_id);

              await star_messages({
                message_ids: message.message_ids,
                conversation_id: message.conversation_id
              }, user_id)
            }
            break;

          case 'message_reply':
            if (message.conversation_id && message.message_ids && message.data) {
              // Reply is handled like a regular message with reply metadata
              // The actual reply creation should be done via REST API
              // This WebSocket event is for broadcasting the reply notification

              const reply_msg_res = await reply_to_message(
                {
                  reply_to_message_id: message.message_ids[0],
                  conversation_id: message.conversation_id,
                  body: message.data?.new_message,
                  attachments: message.data.new_message.attachments
                },
                message.data?.user_id
              )

              if (reply_msg_res.success) {
                broadcast_to_conversation(message.conversation_id, {
                  type: 'message_reply',
                  data: {
                    user_id,
                    new_message: message.data.new_message,
                    new_message_id: reply_msg_res.data?.id
                  },
                  conversation_id: message.conversation_id,
                  message_ids: message.message_ids,
                  timestamp: new Date().toISOString()
                }, user_id);
              }
            }
            break;

          case 'message_forward':
            if (message.message_ids && message.data) {
              console.log("data ->", message.data)

              const forward_res = await forward_messages({
                message_ids: message.message_ids,
                source_conversation_id: message.data.source_conversation_id,
                target_conversation_ids: message.data.target_conversation_ids
              }, user_id)


              if (forward_res.success && message.data.target_conversation_ids) {
                for (const target_conversation_id of message.data.target_conversation_ids) {
                  console.log("forwarding to  ->", target_conversation_id)
                  broadcast_to_conversation(target_conversation_id, {
                    type: 'message_forward',
                    data: {
                      user_id,
                      source_conversation_id: message.data.source_conversation_id,
                      forwarded_message_ids: message.data.forwarded_message_ids
                    },
                    conversation_id: message.data.target_conversation_id,
                    message_ids: message.data.forwarded_message_ids,
                    timestamp: new Date().toISOString()
                  }, user_id);
                }
              }
            }
            break;

          // case 'message_delete':
          //   if (message.conversation_id && message.message_ids && message.data) {
          //
          //     // ------------------------------------------------------------------
          //     // store deleted_by in the metadata so that other person can see
          //     // ------------------------------------------------------------------
          //     broadcast_to_conversation(message.conversation_id, {
          //       type: 'message_delete',
          //       data: { user_id },
          //       conversation_id: message.conversation_id,
          //       message_ids: message.message_ids,
          //       timestamp: new Date().toISOString()
          //     }, user_id);
          //   }
          //   break;

          case 'media':
            if (message.conversation_id && message.data) {
              // console.log("conversation_id ->", message.conversation_id, "data ->", message.data)

              const media_res = await store_media({
                conversation_id: message.conversation_id,
                url: message.data.url,
                key: message.data.key,
                mime_type: message.data.mime_type,
                file_name: message.data.file_name,
                file_size: message.data.file_size,
                category: message.data.category
              }, user_id);

              if (media_res.success) {
                broadcast_to_conversation(message.conversation_id, {
                  type: 'media',
                  data: {
                    user_id,
                    ...message.data,
                    media_message_id: media_res.data?.id
                  },
                  conversation_id: message.conversation_id,
                  timestamp: new Date().toISOString()
                }, user_id);
              }
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
        const user_id = getUserId(ws);
        if (user_id) {
          send_to_user(user_id, {
            type: 'error',
            data: { message: 'Invalid message format' },
            timestamp: new Date().toISOString()
          });
        }
      }
    },

    close: (ws) => {
      const user_id = getUserId(ws);
      if (user_id) {
        remove_connection(user_id);
      }
    }

  })
  .listen(5002)

console.log('[WS] WebSocket server running on ws://localhost:5002/chat');

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
// startConnectionMonitor();

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
