import { authenticate_jwt } from '@/middleware';
import { Elysia, t } from 'elysia';
import db from '@/config/db';
import { message_model, conversation_model, conversation_member_model } from '@/models/chat.model';
import { eq, and, or, sql, desc } from 'drizzle-orm';
import { ElysiaWS } from 'elysia/dist/ws';
import { WebSocketData, TypedElysiaWS } from '@/types/elysia.types';
import { user_model } from '@/models/user.model';
import { forward_messages, pin_message, reply_to_message, star_messages, store_media } from '@/services/message-operations.services';
import { update_user_details } from '@/services/user.services';
import { CallService } from '@/services/call.service';
import { CallSignalingMessage } from '@/types/call.types';
import FCMService from '@/services/fcm.service';
import { call_model } from '@/models/call.model';

// Connection management
interface UserConnection {
  ws: ElysiaWS; // Elysia WebSocket
  user_id: number;
  last_seen: Date;
  conversations: Set<number>; // All conversation IDs
  active_conversation_id?: number; // Active conversation ID, that user is currently viewing
}

const connections = new Map<number, UserConnection>(); // user_id -> UserConnection
const conversation_connections = new Map<number, Set<number>>(); // conversation_id -> Set<user_id>
// const active_conversation_connections = new Map<number, Set<number>>(); // conversation_id -> Set<user_id>

// Message types for WebSocket communication
interface WSMessage {
  type: 'message' | 'typing' | 'user_online' | 'user_offline' | 'read_receipt' | 'create_new_chat' | 'join_conversation' | 'leave_conversation' | 'error' | 'ping' | 'pong' | 'message_pin' | 'message_star' | 'message_reply' | 'message_forward' | 'message_delete' | 'media' | 'message_delivery_receipt' | 'online_status' | 'active_in_conversation' | 'inactive_in_conversation' | 'call:init' | 'call:offer' | 'call:answer' | 'call:ice' | 'call:accept' | 'call:decline' | 'call:end' | 'call:ringing' | 'call:missed' | 'call:merge' | 'call:merge_accepted' | 'call:merge_declined' | 'call:participant_joined' | 'call:participant_left' | 'call:participant_removed' | 'call:remove_participant';
  data?: any;
  conversation_id?: number;
  message_ids?: number[];
  timestamp?: string;
  // Call-specific fields
  callId?: number;
  from?: number;
  to?: number;
  payload?: any;
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

  console.log("memberships ->", memberships)
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

    // console.log(`[WS] User ${user_id} joined conversation ${conversation_id}`);
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

const broadcast_to_conversation = async (conversation_id: number, message: WSMessage, exclude_user?: number, message_id?: number, included_user?: number) => {

  console.log(`broadcasting to conversation ID || ${conversation_id} ->`, message)
  // console.log("message ->", message)
  // console.log("connnections :", connections)
  // console.log("conversation_connections :", conversation_connections)
  const conv_connections = conversation_connections.get(conversation_id);
  // console.log("connections ->", connections)
  // console.log("conversation_connections ->", conversation_connections)
  if (!conv_connections) return;

  const message_str = JSON.stringify(message);
  let sent_count = 0;
  let delivered_count = 0;
  let read_count = 0;
  const delivery_status = {
    delivered_to: [] as number[],
    read_by: [] as number[],
    unread_by: [] as number[]
  };

  // Track offline users for push notifications
  // const online_users: Set<number> = conv_connections
  // console.log("online_users ->", online_users)
  // online_users.add(included_user || -1);

  conv_connections.forEach(async user_id => {

    // console.log("online_users ->", online_users)
    if (exclude_user && user_id === exclude_user) return;

    const connection = connections.get(user_id);
    // send message to online users, else increase the unread count in the database
    if (connection && connection.ws.readyState === 1) {
      try {
        console.log(`sending to user ID || ${user_id} ->`, message)
        connection.ws.send(message_str);
        sent_count++;
        delivered_count++;
        delivery_status.delivered_to.push(user_id);

        // online_users.add(user_id);

        // Check if user is actively viewing this conversation
        if (connection.active_conversation_id === conversation_id) {
          // User is viewing the conversation - mark as read and update last_read_message_id
          read_count++;
          delivery_status.read_by.push(user_id);

          if (message_id) {
            // Update last_read_message_id and last_delivered_message_id for this user
            db.update(conversation_member_model)
              .set({
                last_read_message_id: message_id,
                last_delivered_message_id: message_id
              })
              .where(
                and(
                  eq(conversation_member_model.conversation_id, conversation_id),
                  eq(conversation_member_model.user_id, user_id)
                )
              )
              .then(() => {
                // console.log(`[WS] Updated read receipt for user ${user_id} in conversation ${conversation_id}, message ${message_id}`);
              })
              .catch((error) => {
                console.error(`[WS] Error updating read receipt for user ${user_id}:`, error);
              });
          }
        } else {

          // User is online but not viewing this conversation - increase unread count
          delivery_status.unread_by.push(user_id);

          if (message_id) {
            // Update unread count and last_delivered_message_id only
            db.update(conversation_member_model)
              .set({
                unread_count: sql`${conversation_member_model.unread_count} + 1`,
                last_delivered_message_id: message_id
              })
              .where(
                and(
                  eq(conversation_member_model.conversation_id, conversation_id),
                  eq(conversation_member_model.user_id, user_id)
                )
              )
              .then(() => {
                // console.log(`[WS] Increased unread count for online but inactive user ${user_id} in conversation ${conversation_id}`);
              })
              .catch((error) => {
                console.error(`[WS] Error increasing unread count for user ${user_id}:`, error);
              });
          }
        }
      } catch (error) {
        console.error(`[WS] Error sending to user ${user_id}:`, error);
        remove_connection(user_id);
        // online_users.add(user_id);
      }
    }
    else {
      // User is offline - increase unread count in the database
      delivery_status.unread_by.push(user_id);

      db.update(conversation_member_model)
        .set({ unread_count: sql`${conversation_member_model.unread_count} + 1` })
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            eq(conversation_member_model.user_id, user_id)
          )
        )
        .then(() => {
          // console.log(`[WS] Increased unread count for offline user ${user_id} in conversation ${conversation_id}`);
        })
        .catch((error) => {
          console.error(`[WS] Error increasing unread count for user ${user_id}:`, error);
        });


    }
  });


  // offline users from DB
  const offline_members = await db
    .select({ user_id: conversation_member_model.user_id })
    .from(conversation_member_model)
    .innerJoin(user_model, eq(conversation_member_model.user_id, user_model.id))
    .where(
      and(
        eq(conversation_member_model.conversation_id, conversation_id),
        eq(user_model.online_status, false)
      )
    )

  const offline_member_ids = offline_members.map(m => m.user_id);
  console.log("offline_member_ids ->", offline_member_ids)


  // Send push notifications to offline users for message notifications
  // Only send for actual message types, not call signaling
  if (offline_member_ids.length > 0 && (message.type === 'message' || message.type === 'media' || message.type === 'message_reply' || message.type === 'message_forward') && message.data) {
    try {
      const messageData = message.data as any;
      let senderId, senderName, messageBody, messageType;

      // Handle different message types
      if (message.type === 'message_reply') {
        senderId = messageData.user_id;
        messageBody = messageData.new_message;
        messageType = 'reply';
      } else if (message.type === 'message_forward') {
        senderId = messageData.user_id;
        messageBody = 'Forwarded message';
        messageType = 'forward';
      } else {
        // Regular message or media
        senderId = messageData.sender_id || messageData.user_id;
        messageBody = messageData.body;
        messageType = messageData.type || (message.type === 'media' ? 'media' : 'text');
      }

      senderName = messageData.sender_name || 'Someone';

      // Get sender details for notification
      const sender = await db
        .select({ name: user_model.name })
        .from(user_model)
        .where(eq(user_model.id, senderId))
        .limit(1);

      const senderNameForNotification = sender[0]?.name || senderName;

      // Filter out the sender from offline users to prevent self-notification
      const recipientIds = offline_member_ids.filter(id => id !== senderId);

      if (recipientIds.length > 0) {
        // Send push notifications to offline users
        await FCMService.sendBulkMessageNotifications(
          recipientIds,
          conversation_id.toString(),
          senderId.toString(),
          senderNameForNotification,
          messageBody,
          messageType
        );
      }
    } catch (error) {
      console.error(`[WS] Error sending push notifications:`, error);
    }
  }

  // console.log(`[WS] Broadcasted to ${sent_count} users in conversation ${conversation_id}. Delivered: ${delivered_count}, Read: ${read_count}`);

  // Send delivery/read receipt back to sender if message_id is provided
  if (included_user && message_id) {
    send_delivery_receipt(included_user, conversation_id, message_id, message.data.optimistic_id, delivery_status);
  }
};

const send_to_user = async (user_id: number, message: WSMessage) => {
  const connection = connections.get(user_id);
  if (connection && connection.ws.readyState === 1) {
    try {
      connection.ws.send(JSON.stringify(message));
      // console.log(`[WS] Sent ${message.type} to user ${user_id}`);
      return true;
    } catch (error) {
      console.error(`[WS] Error sending to user ${user_id}:`, error);
      remove_connection(user_id);
      return false;
    }
  } else {

    // console.log(`user ${user_id} is offline, total offline users for this message ->`)
    // await FCMService.sendMessageNotification(user_id, {
    //   conversationId: message.conversation_id ? message.conversation_id.toString() : '',
    //   messageId: message.data?.id ? message.data.id.toString() : '',
    //   senderId: message.data?.sender_id ? message.data.sender_id.toString() : '',
    //   senderName: message.data?.sender_name || 'Someone',
    //   messageBody: message.data?.body || '',
    //   messageType: message.data?.type || 'text'
    // })
    //
    console.warn(`[WS] Cannot send ${message.type} to user ${user_id} - not connected or connection not ready`);
    console.warn(`[WS] Connection exists: ${!!connection}, ReadyState: ${connection?.ws.readyState}`);
  }
  return false;
};

const send_delivery_receipt = (
  sender_id: number,
  conversation_id: number,
  message_id: number,
  optimistic_id: number,
  delivery_status: { delivered_to: number[], read_by: number[], unread_by: number[] }) => {
  const receipt_message: WSMessage = {
    type: 'message_delivery_receipt',
    data: {
      message_id,
      optimistic_id,
      conversation_id,
      delivered_count: delivery_status.delivered_to.length,
      read_count: delivery_status.read_by.length,
      unread_count: delivery_status.unread_by.length,
      delivered_to: delivery_status.delivered_to,
      read_by: delivery_status.read_by,
      unread_by: delivery_status.unread_by
    },
    conversation_id,
    timestamp: new Date().toISOString()
  };

  send_to_user(sender_id, receipt_message);
  // console.log(`[WS] Sent delivery receipt to sender ${sender_id} for message ${message_id}`);
};

const broadcast_to_all = (message: WSMessage) => {
  console.log("broadcasting to all ->", message)
  const message_str = JSON.stringify(message);
  connections.forEach((connection, user_id) => {
    if (connection.ws.readyState === 1) {
      try {
        connection.ws.send(message_str);
      } catch (error) {
        console.error(`[WS] Error sending to user ${user_id}:`, error);
        remove_connection(user_id);
      }
    }
  });
  // console.log(`[WS] Broadcasted to all users`);
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
      timestamp: t.Optional(t.String()),
      // Call-specific fields
      callId: t.Optional(t.Number()),
      from: t.Optional(t.Number()),
      to: t.Optional(t.Number()),
      payload: t.Optional(t.Any())
    }),

    query: t.Object({
      token: t.Optional(t.String())
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

        // send pending calls to the user
        const [last_pending_call] =
          await db
            .select()
            .from(call_model)
            .innerJoin(user_model, eq(call_model.caller_id, user_model.id))
            .where(
              and(
                eq(call_model.callee_id, user_id),
                eq(call_model.status, 'initiated')
              ))
            .orderBy(desc(call_model.id))
            .limit(1);

        if (last_pending_call) {
          send_to_user(user_id, {
            type: 'call:ringing',
            callId: last_pending_call.calls.id,
            from: last_pending_call.calls.caller_id,
            to: user_id,
            payload: {
              callerName: last_pending_call.users.name,
              callerProfilePic: last_pending_call.users.profile_pic,
            },
            timestamp: last_pending_call.calls.started_at?.toISOString()
          });
        }


        // Notify all users about the new online user
        broadcast_to_all(
          {
            type: 'user_online',
            data: { user_id },
            timestamp: new Date().toISOString()
          }
        )

        // update the online status of user in the DB
        await update_user_details(user_id, { online_status: true, last_seen: new Date() });

        // console.log(`[WS] User ${user_id} authenticated and connected`);
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
              console.log("join_conversation ->", message.conversation_id)
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

              // add_connection(user_id, ws);

              // if (membership.length > 0) {
              join_conversation(user_id, message.conversation_id);
              message.data.recipient_id.forEach((element: number) => {
                console.log("recipient_id ->", element)
                if (Number(element) !== user_id) {
                  join_conversation(Number(element), message.conversation_id!)
                }

              });
              // message.data.recipient_id.map((id: number) => Number(id) !== user_id ? join_conversation(Number(id), message.conversation_id!) : null)
              join_conversation(Number(message.data.recipient_id), message.conversation_id);

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

              // Clear active conversation if user is leaving it
              const connection = connections.get(user_id);
              if (connection && connection.active_conversation_id === message.conversation_id) {
                connection.active_conversation_id = undefined;
              }

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
                }, undefined, saved_message.id, user_id);

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

              const reply_msg_res = await reply_to_message(
                {
                  reply_to_message_id: message.message_ids[0],
                  conversation_id: message.conversation_id,
                  body: message.data?.new_message,
                  attachments: message.data.new_attachment
                },
                user_id
              )

              if (reply_msg_res.success) {
                broadcast_to_conversation(message.conversation_id, {
                  type: 'message_reply',
                  data: {
                    user_id,
                    new_message: message.data.new_message,
                    new_message_id: reply_msg_res.data?.id,
                    optimistic_id: message.data?.optimistic_id
                  },
                  conversation_id: message.conversation_id,
                  message_ids: message.message_ids,
                  timestamp: new Date().toISOString()
                }, undefined, reply_msg_res.data?.id, user_id);
              }
            }
            break;

          case 'message_forward':
            if (message.message_ids && message.data) {

              const forward_res = await forward_messages({
                message_ids: message.message_ids,
                source_conversation_id: message.data.source_conversation_id,
                target_conversation_ids: message.data.target_conversation_ids
              }, user_id)


              if (forward_res.success && message.data.target_conversation_ids && forward_res.data) {
                for (let i = 0; i < message.data.target_conversation_ids.length; i++) {
                  const target_conversation_id = message.data.target_conversation_ids[i];
                  const forwarded_message = forward_res.data[i];

                  broadcast_to_conversation(target_conversation_id, {
                    type: 'message_forward',
                    data: {
                      user_id,
                      source_conversation_id: message.data.source_conversation_id,
                      forwarded_message_ids: message.data.forwarded_message_ids,
                      new_message_id: forwarded_message?.id
                    },
                    conversation_id: target_conversation_id,
                    message_ids: message.data.forwarded_message_ids,
                    timestamp: new Date().toISOString()
                  }, user_id, forwarded_message?.id, user_id);
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
                    media_message_id: media_res.data?.id,
                    optimistic_id: message.data?.optimistic_id
                  },
                  conversation_id: message.conversation_id,
                  timestamp: new Date().toISOString()
                }, undefined, undefined, user_id);
              }
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

          // case 'add-me-to-conversation':
          //   if (message.conversation_id) {
          //     // This is a custom action to track active users in a conversation
          //     // Useful for features like "currently viewing" or "active now"
          //     if (!active_conversation_connections.has(message.conversation_id)) {
          //       active_conversation_connections.set(message.conversation_id, new Set());
          //     }
          //     active_conversation_connections.get(message.conversation_id)?.add(user_id);
          //
          //     console.log(`user ${user_id} added to active_conversation_connections ->`, active_conversation_connections)
          //   }
          //
          //   break;

          case 'online_status':
            if (message.conversation_id) {
              // check if user is in the conversation_connections

              const conv_connections = Array.from(conversation_connections.get(message.conversation_id) || []);
              const inside_the_selected_convesation = conv_connections.filter(id => {
                if (connections.get(id)?.active_conversation_id === message.conversation_id) {
                  return id
                }
              });
              console.log("sending online status ->", inside_the_selected_convesation)

              // Update online status in the database
              // await update_user_details(message.user_id, { online_status: message.data?.online_status, last_seen: new Date() });
              // Broadcast to conversation members
              broadcast_to_conversation(message.conversation_id, {
                type: 'online_status',
                data: {
                  online_in_conversation: inside_the_selected_convesation
                },
                conversation_id: message.conversation_id,
              });
            }

            break;

          case 'active_in_conversation':
            if (message.conversation_id) {
              const connection = connections.get(user_id);
              if (connection) {
                const wasActive = connection.active_conversation_id === message.conversation_id;
                connection.active_conversation_id = message.conversation_id;
                // console.log(user ${user_id} is currently viewing ${message.conversation_id});

                // Clear unread count when user becomes active in conversation
                await db
                  .update(conversation_member_model)
                  .set({ unread_count: 0 })
                  .where(
                    and(
                      eq(conversation_member_model.conversation_id, message.conversation_id),
                      eq(conversation_member_model.user_id, user_id)
                    )
                  );

                // Get the latest message in this conversation to update last_read_message_id
                const [latest_message] = await db
                  .select({ id: message_model.id })
                  .from(message_model)
                  .where(
                    and(
                      eq(message_model.conversation_id, message.conversation_id),
                      eq(message_model.deleted, false)
                    )
                  )
                  .orderBy(sql`${message_model.id} DESC`)
                  .limit(1);

                if (latest_message) {
                  // Only update last_read_message_id if user wasn't already active in this conversation
                  // This prevents resetting read receipts when user comes back to the same conversation
                  if (!wasActive) {
                    await db
                      .update(conversation_member_model)
                      .set({
                        last_read_message_id: latest_message.id,
                        last_delivered_message_id: latest_message.id
                      })
                      .where(
                        and(
                          eq(conversation_member_model.conversation_id, message.conversation_id),
                          eq(conversation_member_model.user_id, user_id)
                        )
                      );

                    // Only send read receipt if user wasn't already active
                    // Notify other users in the conversation about read receipt
                    broadcast_to_conversation(message.conversation_id, {
                      type: 'read_receipt',
                      data: {
                        user_id,
                        message_id: null,
                        read_all: true, // Indicates user read all messages up to this point
                        user_active: true // User is currently active in conversation
                      },
                      conversation_id: message.conversation_id,
                      timestamp: new Date().toISOString()
                    }, user_id);
                  }
                }

                // console.log([WS] Cleared unread count for user ${user_id} in conversation ${message.conversation_id});
              }
            }

            break;

          case 'inactive_in_conversation':
            if (message.conversation_id) {
              const connection = connections.get(user_id);
              if (connection && connection.active_conversation_id === message.conversation_id) {
                connection.active_conversation_id = undefined;

                const [latest_message] = await db
                  .select({ id: message_model.id })
                  .from(message_model)
                  .where(
                    and(
                      eq(message_model.conversation_id, message.conversation_id),
                      eq(message_model.deleted, false)
                    )
                  )
                  .orderBy(sql`${message_model.id} DESC`)
                  .limit(1);

                // Send read receipt indicating user is no longer active
                broadcast_to_conversation(message.conversation_id, {
                  type: 'read_receipt',
                  data: {
                    user_id,
                    message_id: latest_message.id,
                    read_all: false, // User is no longer reading messages
                    user_active: false // User is no longer active in conversation
                  },
                  conversation_id: message.conversation_id,
                  timestamp: new Date().toISOString()
                }, user_id);

                const conv_connections = Array.from(conversation_connections.get(message.conversation_id) || []);
                const inside_the_selected_convesation = conv_connections.filter(id => {
                  if (connections.get(id)?.active_conversation_id === message.conversation_id) {
                    return id
                  }
                });
                console.log("sending online status ->", inside_the_selected_convesation)

                broadcast_to_conversation(message.conversation_id, {
                  type: 'online_status',
                  data: {
                    online_in_conversation: inside_the_selected_convesation
                  },
                  conversation_id: message.conversation_id,
                });
              }
            }
            break;

          // Call signaling handlers
          case 'call:init':
            if (message.to && message.payload) {
              // console.log(`[WS] Processing call:init from ${user_id} to ${message.to}`);
              // console.log(`[WS] Current connections: ${Array.from(connections.keys())}`);
              // console.log(`[WS] Target user ${message.to} connected: ${connections.has(message.to)}`);

              const result = await CallService.initiate_call(user_id, message.to, message.payload);

              if (result.success) {
                const callId = result.data?.callId;
                // console.log(`[WS] Call initiation successful, callId: ${callId}`);

                // Send acknowledgment to caller
                await send_to_user(user_id, {
                  type: 'call:init',
                  callId,
                  from: user_id,
                  to: message.to,
                  data: { success: true, callId },
                  timestamp: new Date().toISOString()
                });
                // console.log(`[WS] Ack sent to caller ${user_id}: ${ackSent}`);

                // Send incoming call notification to callee
                const ringSent = await send_to_user(message.to, {
                  type: 'call:ringing',
                  callId,
                  from: user_id,
                  to: message.to,
                  payload: message.payload,
                  timestamp: new Date().toISOString()
                });

                // Send push notification if user is offline
                if (!ringSent) {
                  try {
                    // Get caller details for notification
                    const caller = await db
                      .select({ name: user_model.name, profile_pic: user_model.profile_pic })
                      .from(user_model)
                      .where(eq(user_model.id, user_id))
                      .limit(1);

                    const callerName = caller[0]?.name || 'Unknown';
                    const callerProfilePic = caller[0]?.profile_pic!;

                    await FCMService.sendBulkMessageNotifications(

                      [message.to],
                      message.conversation_id!.toString(),
                      user_id.toString(),
                      "testing user X",
                      "calling you",
                      "call"
                    );

                    await FCMService.sendCallNotification(message.to, {
                      callId: callId!.toString(),
                      callerId: user_id.toString(),
                      callerName,
                      callerProfilePic,
                      callType: message.payload?.callType || 'audio',
                    });
                  } catch (error) {
                    console.error(`[WS] Error sending call push notification:`, error);
                  }
                }
                // console.log(`[WS] Ring sent to callee ${message.to}: ${ringSent}`);
                //
                // console.log(`[WS] Call init complete: ${callId} from ${user_id} to ${message.to}`);
              } else {
                // console.log(`[WS] Call initiation failed: ${result.error} (${result.code})`);
                // Send error to caller
                send_to_user(user_id, {
                  type: 'error',
                  data: { message: result.error, code: result.code },
                  timestamp: new Date().toISOString()
                });
              }
            } else {
              console.log(`[WS] Invalid call:init message - missing to or payload`);
            }
            break;

          case 'call:offer':
          case 'call:answer':
          case 'call:ice':
            // Forward WebRTC signaling between caller and callee
            if (message.callId && message.to && message.payload) {
              send_to_user(message.to, {
                type: message.type,
                callId: message.callId,
                from: user_id,
                to: message.to,
                payload: message.payload,
                timestamp: new Date().toISOString()
              });

              // console.log(`[WS] Forwarded ${message.type} for call ${message.callId}`);
            }
            break;

          case 'call:accept':
            if (message.callId) {
              const result = await CallService.accept_call(message.callId, user_id);

              if (result.success) {
                // Notify both parties
                const active_call = CallService.get_user_active_call(user_id);
                if (active_call) {
                  // Notify caller
                  send_to_user(active_call.caller_id, {
                    type: 'call:accept',
                    callId: message.callId,
                    from: user_id,
                    to: active_call.caller_id,
                    timestamp: new Date().toISOString()
                  });

                  // Acknowledge to callee
                  send_to_user(user_id, {
                    type: 'call:accept',
                    callId: message.callId,
                    from: user_id,
                    to: active_call.caller_id,
                    data: { success: true },
                    timestamp: new Date().toISOString()
                  });
                }
              } else {
                send_to_user(user_id, {
                  type: 'error',
                  data: { message: result.error },
                  timestamp: new Date().toISOString()
                });
              }
            }
            break;

          case 'call:decline':
            if (message.callId) {
              const active_call = CallService.get_user_active_call(user_id);
              const result = await CallService.decline_call(message.callId, user_id, message.payload?.reason);

              if (result.success) {
                if (active_call) {
                  // Notify caller
                  const other_user = active_call.caller_id === user_id ? active_call.callee_id : active_call.caller_id;
                  send_to_user(active_call.caller_id, {
                    type: 'call:decline',
                    callId: message.callId,
                    from: user_id,
                    to: other_user,
                    payload: message.payload,
                    timestamp: new Date().toISOString()
                  });
                  send_to_user(user_id, {
                    type: 'call:decline',
                    callId: message.callId,
                    data: { success: true, reason: message.payload?.reason },
                    timestamp: new Date().toISOString()
                  });
                }
              }
            }
            break;

          case 'call:end':
            if (message.callId) {
              // Get active call first before ending it
              const active_call = CallService.get_user_active_call(user_id);

              const result = await CallService.end_call(message.callId, user_id, message.payload?.reason);

              if (result.success) {
                // Find the other party and notify them
                if (active_call) {
                  const other_user = active_call.caller_id === user_id ? active_call.callee_id : active_call.caller_id;

                  // console.log(`[WS] Call ended: ${message.callId}, notifying user ${other_user}`);

                  send_to_user(other_user, {
                    type: 'call:end',
                    callId: message.callId,
                    from: user_id,
                    to: other_user,
                    payload: {
                      reason: message.payload?.reason,
                      duration: result.data?.duration_seconds
                    },
                    timestamp: new Date().toISOString()
                  });

                  // Acknowledge to sender
                  send_to_user(user_id, {
                    type: 'call:end',
                    callId: message.callId,
                    data: { success: true, duration: result.data?.duration_seconds },
                    timestamp: new Date().toISOString()
                  });
                } else {
                  console.warn(`[WS] No active call found for user ${user_id} when ending call ${message.callId}`);
                }
              } else {
                console.error(`[WS] Failed to end call ${message.callId}: ${result.error}`);
              }
            }
            break;

          case 'call:merge':
            if (message.to && message.callId && message.payload) {
              console.log(`[WS] Processing call:merge from ${user_id} to ${message.to}`);

              // Check if target user is online
              if (!connections.has(message.to)) {
                send_to_user(user_id, {
                  type: 'error',
                  data: { message: 'User is not online', code: 'USER_OFFLINE' },
                  timestamp: new Date().toISOString()
                });
                break;
              }

              // Send merge call request to target user
              send_to_user(message.to, {
                type: 'call:merge',
                callId: message.callId,
                from: user_id,
                to: message.to,
                payload: message.payload,
                timestamp: new Date().toISOString()
              });

              // Acknowledge to sender
              send_to_user(user_id, {
                type: 'call:merge',
                callId: message.callId,
                data: { success: true },
                timestamp: new Date().toISOString()
              });
            }
            break;

          case 'call:merge_accept':
            if (message.callId) {
              console.log(`[WS] User ${user_id} accepted merge call ${message.callId}`);

              // Notify the original caller about merge acceptance
              const active_call = CallService.get_user_active_call(user_id);
              if (active_call) {
                send_to_user(active_call.caller_id, {
                  type: 'call:merge_accepted',
                  callId: message.callId,
                  from: user_id,
                  to: active_call.caller_id,
                  payload: {
                    userId: user_id,
                    userName: message.payload?.userName || 'Unknown',
                    userProfilePic: message.payload?.userProfilePic
                  },
                  timestamp: new Date().toISOString()
                });
              }
            }
            break;

          case 'call:merge_decline':
            if (message.callId) {
              console.log(`[WS] User ${user_id} declined merge call ${message.callId}`);

              // Notify the original caller about merge decline
              const active_call = CallService.get_user_active_call(user_id);
              if (active_call) {
                send_to_user(active_call.caller_id, {
                  type: 'call:merge_declined',
                  callId: message.callId,
                  from: user_id,
                  to: active_call.caller_id,
                  payload: {
                    userId: user_id,
                    reason: message.payload?.reason || 'User declined'
                  },
                  timestamp: new Date().toISOString()
                });
              }
            }
            break;

          case 'call:remove_participant':
            if (message.callId && message.to) {
              console.log(`[WS] Removing participant ${message.to} from call ${message.callId}`);

              // Notify the participant that they're being removed
              send_to_user(message.to, {
                type: 'call:participant_removed',
                callId: message.callId,
                from: user_id,
                to: message.to,
                payload: {
                  reason: message.payload?.reason || 'Removed from call'
                },
                timestamp: new Date().toISOString()
              });

              // Notify other participants
              const active_call = CallService.get_user_active_call(user_id);
              if (active_call) {
                const other_user = active_call.caller_id === user_id ? active_call.callee_id : active_call.caller_id;
                if (other_user !== message.to) {
                  send_to_user(other_user, {
                    type: 'call:participant_left',
                    callId: message.callId,
                    from: user_id,
                    to: other_user,
                    payload: {
                      userId: message.to,
                      userName: message.payload?.userName || 'Unknown'
                    },
                    timestamp: new Date().toISOString()
                  });
                }
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

    close: async (ws) => {
      const user_id = getUserId(ws);
      if (user_id) {
        remove_connection(user_id);

        // Notify all users about the offline user
        broadcast_to_all(
          {
            type: 'user_offline',
            data: { user_id },
            timestamp: new Date().toISOString()
          }
        )

        // update the online status of user in the DB
        await update_user_details(user_id, { online_status: false, last_seen: new Date() });
      }
    }

  })
  .listen(process.env.SOCKET_PORT || 5002);

console.log(`🔌 WebSocket is running at port ${process.env.SOCKET_PORT || 5002}`);

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
