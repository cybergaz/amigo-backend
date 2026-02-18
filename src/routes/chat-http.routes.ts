import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { delete_message_for_me, sync_missed_messages } from "@/services/chat.services";
import { delete_messages, forward_messages, get_pinned_messages, get_starred_messages, mark_message_delivered, reply_to_message, star_messages } from "@/services/message.services";
import { fetch_pending_messages } from "@/sockets/polling.cache";

export const chat_http_routes = new Elysia({ prefix: "/chat/http" })
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  .delete("/delete-message-for-me", async ({ set, store, body }) => {
    const delete_result = await delete_message_for_me(
      body.message_ids,
      store.id,
      body.conversation_id
    );
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.BigInt()),
      conversation_id: t.Number()
    })
  })

  // // Message operations routes
  // .post("/messages/pin", async ({ set, store, body }) => {
  //   const pin_result = await toggle_pin_message({
  //   conv_id: body.conversation_id,
  //   message_id: body.message_id,
  //
  // });
  //   set.status = pin_result.code;
  //   return pin_result;
  // }, {
  //   body: t.Object({
  //     message_id: t.Number(),
  //     conversation_id: t.Number()
  //   })
  // })

  .post("/messages/star", async ({ set, store, body }) => {
    const star_result = await star_messages(body, store.id);
    set.status = star_result.code;
    return star_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.BigInt()),
      conversation_id: t.Number()
    })
  })

  .post("/messages/reply", async ({ set, store, body }) => {
    const reply_result = await reply_to_message(body, store.id);
    set.status = reply_result.code;
    return reply_result;
  }, {
    body: t.Object({
      message_id: t.BigInt(),
      reply_to_message_id: t.BigInt(),
      conversation_id: t.Number(),
      body: t.String(),
      attachments: t.Optional(t.Array(t.Any()))
    })
  })

  .post("/messages/forward", async ({ set, store, body }) => {
    const forward_result = await forward_messages(body, store.id);
    set.status = forward_result.code;
    return forward_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.BigInt()),
      source_conversation_id: t.Number(),
      target_conversation_ids: t.Array(t.Number())
    })
  })

  .delete("/messages/delete", async ({ set, store, body }) => {
    const delete_result = await delete_messages(body, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.BigInt()),
      conversation_id: t.Number(),
      delete_for_everyone: t.Optional(t.Boolean())
    })
  })

  .get("/messages/pinned/:conversation_id", async ({ set, store, params }) => {
    const pinned_result = await get_pinned_messages(params.conversation_id, store.id);
    set.status = pinned_result.code;
    return pinned_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  })

  .get("/messages/starred", async ({ set, store, query }) => {
    const starred_result = await get_starred_messages(store.id, query.conversation_id);
    set.status = starred_result.code;
    return starred_result;
  }, {
    query: t.Object({
      conversation_id: t.Optional(t.Number())
    })
  })

  .post("/messages/delivered", async ({ set, store, body }) => {
    const delivery_result = await mark_message_delivered(
      body.message_id,
      body.conversation_id,
      store.id
    );
    set.status = delivery_result.code;
    return delivery_result;
  }, {
    body: t.Object({
      message_id: t.BigInt(),
      conversation_id: t.Number()
    })
  })

  .get("/sync-messages-via-polling", async ({ set, store, params, query }) => {
    const sync_result = await sync_missed_messages(store.id)

    set.status = sync_result.code;
    return sync_result;
  })

  // ============================================================================
  // HTTP Long Polling Endpoints - Fallback transport for WebSocket/SSE
  // ============================================================================

  // POST endpoint to send messages via polling
  // .post('/chat/poll', async ({ body, set, store }) => {
  //
  //   // Get user details for message handling
  //   const user_name = (await db
  //     .select({ name: user_model.name })
  //     .from(user_model)
  //     .where(eq(user_model.id, user_id))
  //     .limit(1))[0]?.name;
  //
  //   // Process the message similar to WebSocket message handling
  //   const message = body as any;
  //
  //   // For now, support basic message types that don't require WebSocket-specific handling
  //   switch (message.type) {
  //     case 'ping':
  //       return { type: 'pong', timestamp: new Date().toISOString() };
  //
  //     case 'message:new':
  //       if (message.payload) {
  //         const payload = message.payload as ChatMessagePayload;
  //
  //         // Store the message in DB
  //         const stored_message = await store_message(payload);
  //         if (!stored_message?.success) {
  //           set.status = 500;
  //           return { error: 'Failed to store message' };
  //         }
  //
  //         const new_message_payload: ChatMessagePayload = {
  //           ...payload,
  //           canonical_id: stored_message?.data?.id,
  //           sender_name: payload.sender_name || user_name || undefined,
  //         };
  //
  //         // Broadcast to conversation members
  //         const sent_result = await broadcast_message({
  //           to: "conversation",
  //           conv_id: payload.conv_id,
  //           message: {
  //             type: "message:new",
  //             payload: new_message_payload,
  //             ws_timestamp: new Date()
  //           },
  //           exclude_user_ids: [payload.sender_id]
  //         });
  //
  //         console.log("sent_result -> ", sent_result)
  //
  //         if (stored_message.data) {
  //           const conv_members = await get_conversation_members(payload.conv_id);
  //           const message_statuses: Array<{ user_id: number; message_id: number; conv_id: number; delivered_at: Date | null; read_at: Date | null }> = [];
  //
  //           for (const member_id of conv_members) {
  //             if (member_id !== payload.sender_id) {
  //
  //               // const is_member_online = socket_connections.has(member_id);
  //               // const is_member_in_conv = socket_connections.get(member_id)?.active_conv_id === member_id;
  //
  //               message_statuses.push({
  //                 user_id: member_id,
  //                 message_id: stored_message.data.id,
  //                 conv_id: payload.conv_id,
  //                 delivered_at: sent_result.online.includes(member_id) ? new Date() : null,
  //                 read_at: sent_result.active_in_conv.includes(member_id) ? new Date() : null,
  //               });
  //             }
  //           }
  //
  //           // Batch insert message statuses for all recipients
  //           if (message_statuses.length > 0) {
  //             await batch_insert_message_status(message_statuses);
  //           }
  //
  //           // Special handling for DMs: update message status in messages table
  //           if (conv_members.size === 2) {
  //             const copy_conv_member = [...conv_members];
  //
  //             const reciepient_id = Array.from(copy_conv_member)[0] == payload.sender_id
  //               ? Array.from(copy_conv_member)[1]   // for DMs only
  //               : Array.from(copy_conv_member)[0]
  //             if (reciepient_id) {
  //               // update message status in messages table (for DMs)
  //               await db.update(message_model).set({
  //                 status: sent_result.active_in_conv.includes(reciepient_id)
  //                   ? "read"
  //                   : sent_result.online.includes(reciepient_id)
  //                     ? "delivered"
  //                     : "sent"
  //               }).where(
  //                 and(
  //                   eq(message_model.id, stored_message.data.id),
  //                   eq(message_model.conversation_id, payload.conv_id)
  //                 )
  //               )
  //             }
  //           }
  //
  //           const offline_and_inactive_users = new Set([...sent_result.offline, ...sent_result.online]);
  //           for (const user_id of offline_and_inactive_users) {
  //             // insert into missed_messages table
  //             await db.update(conversation_member_model)
  //               .set({
  //                 unread_count: sql`${conversation_member_model.unread_count} + 1`,
  //                 last_delivered_message_id: sent_result.online.includes(user_id) || sent_result.active_in_conv.includes(user_id)
  //                   ? stored_message.data.id
  //                   : sql`${conversation_member_model.last_delivered_message_id}`,
  //                 last_read_message_id: sent_result.active_in_conv.includes(user_id)
  //                   ? stored_message.data.id
  //                   : sql`${conversation_member_model.last_read_message_id}`,
  //               })
  //               .where(
  //                 and(
  //                   eq(conversation_member_model.conversation_id, payload.conv_id),
  //                   eq(conversation_member_model.user_id, user_id)
  //                 )
  //               )
  //           }
  //         }
  //
  //         // update conversaion's last_message metadata and last_updated_at
  //         await update_conversation({
  //           id: payload.conv_id,
  //           metadata: { last_message: stored_message?.data },
  //           last_message_at: new Date()
  //         })
  //
  //         // send fcm notification to offline users
  //         await FCMService.sendBulkMessageNotifications(
  //           sent_result.offline,
  //           new_message_payload
  //         );
  //
  //         // Return acknowledgment
  //         return {
  //           type: "message:ack",
  //           payload: {
  //             optimistic_id: payload.optimistic_id,
  //             canonical_id: stored_message?.data?.id,
  //             conv_id: payload.conv_id,
  //             sender_id: payload.sender_id,
  //             delivered_at: new Date(),
  //             delivered_to: sent_result.online,
  //             offline_users: sent_result.offline,
  //           }
  //         };
  //       }
  //       break;
  //
  //     case 'conversation:typing':
  //       if (message.payload) {
  //         const payload = message.payload as TypingPayload;
  //         await broadcast_message({
  //           to: "conversation",
  //           conv_id: payload.conv_id,
  //           message: {
  //             type: "conversation:typing",
  //             payload: payload,
  //             ws_timestamp: new Date()
  //           },
  //           exclude_user_ids: [payload.sender_id],
  //         });
  //         return { success: true };
  //       }
  //       break;
  //
  //     default:
  //       return { error: `Unsupported message type for polling: ${message.type}` };
  //   }
  //
  //   return { success: true };
  // }, {
  //   query: t.Object({ token: t.String() }),
  //   body: t.Any()
  // })

  .get("/poll-pending-messages", async ({ set, store, query }) => {
    try {
      const messages = await fetch_pending_messages(store.id, query.after_message_id);

      return {
        success: true,
        code: 200,
        message: messages.length > 0
          ? `Fetched ${messages.length} pending message(s)`
          : "No pending messages",
        data: {
          messages: messages.map(m => ({
            message_id: m.message_id,
            event_type: m.event_type,
            payload: m.ws_message,
            created_at: m.created_at,
          })),
          count: messages.length,
          last_message_id: messages.length > 0
            ? messages[messages.length - 1].message_id
            : query.after_message_id ?? null,
        },
      };
    } catch (error) {
      console.error("[POLL] Error fetching pending messages:", error);
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Failed to fetch pending messages",
      };
    }
  }, {
    query: t.Object({
      after_message_id: t.Optional(t.String()),
    })
  })
