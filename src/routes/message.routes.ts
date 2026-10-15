import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { request_auth } from "@/middleware/request-auth";
import { delete_message_for_me, soft_delete_message } from "@/services/chat.services";
import { delete_messages, forward_messages, get_pinned_messages, get_starred_messages, react_to_message, reply_to_message } from "@/services/message.services";
import { mark_message_delivered, mark_messages_delivered_batch, verify_message_ids } from "@/services/message-status.service";
import { MessageStatusAckPayloadSchema } from "@/types/socket.elysia-schema";
import { socket_message_handler } from "@/sockets/socket.handlers";
import { MessageType } from "@/types/chat.types";
import { MessageStatusAckPayload } from "@/types/socket.types";
import { handle_message_status_ack } from "@/sockets/socket.service";
import { sync_v2_flags } from "@/services/app-settings.service";
import { v2_on } from "@/services/sync/flags-core";
import { ack_seq_fields } from "@/services/sync/frame-fields";

export const message_routes = new Elysia({ prefix: "/message" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide store.
  .resolve(({ cookie, set, headers }) => request_auth(set, app_middleware({ cookie, headers })))

  .post("/delivered", async ({ set, auth, body }) => {
    // console.log("delivered ack through api -> ", body);
    const delivery_result = await mark_message_delivered(
      body.message_id,
      body.conversation_id,
      auth.id
    );
    set.status = delivery_result.code;
    return delivery_result;
  }, {
    body: t.Object({
      message_id: t.String(),
      conversation_id: t.String()
    })
  })

  .post("/delivered/batch", async ({ set, auth, body }) => {
    const delivery_result = await mark_messages_delivered_batch(body.messages, auth.id);
    set.status = delivery_result.code;
    return delivery_result;
  }, {
    body: t.Object({
      messages: t.Array(t.Object({
        message_id: t.String(),
        conversation_id: t.String()
      }))
    })
  })

  .post("/status-ack", async ({ set, auth, body }) => {
    const delivery_result = await handle_message_status_ack(body as MessageStatusAckPayload, auth.id, new Date());
    set.status = delivery_result.code;
    return delivery_result;
  }, {
    body: MessageStatusAckPayloadSchema
  })

  // // Message operations routes
  // .post("/messages/pin", async ({ set, auth, body }) => {
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

  // .post("/star", async ({ set, auth, body }) => {
  //   const star_result = await star_messages(body, auth.id);
  //   set.status = star_result.code;
  //   return star_result;
  // }, {
  //   body: t.Object({
  //     message_ids: t.Array(t.String()),
  //     conversation_id: t.String()
  //   })
  // })

  .post("/reply", async ({ set, auth, body }) => {
    const reply_result = await reply_to_message(body, auth.id);
    set.status = reply_result.code;
    return reply_result;
  }, {
    body: t.Object({
      message_id: t.String(),
      reply_to_message_id: t.String(),
      conversation_id: t.String(),
      body: t.String(),
      attachments: t.Optional(t.Array(t.Any()))
    })
  })

  .post("/forward", async ({ set, auth, body }) => {
    const forward_result = await forward_messages(body, auth.id);
    set.status = forward_result.code;
    // SYNC_V2 §3.3.7 (sync_v2 'on'): `data` is a Map, which JSON-serialises
    // to {} — so the result was never readable. In 'on' it is shipped as
    // {target_conv_id: [{id, seq, srv_ts, duplicate}]}, which is how a
    // client that sent `ids` learns the (original, for a replay) seqs.
    // Off / shadow: byte-identical.
    if (forward_result.success && forward_result.data && v2_on(sync_v2_flags())) {
      return {
        ...forward_result,
        data: Object.fromEntries(
          Array.from(forward_result.data.entries(), ([conv_id, rows]) => [
            conv_id,
            rows.map((r) => ({ id: r.id, ...ack_seq_fields(r), duplicate: r.duplicate === true })),
          ]),
        ),
      };
    }
    return forward_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      source_conversation_id: t.String(),
      target_conversation_ids: t.Array(t.String()),
      // SYNC_V2 §3.3.7 (optional, honoured in 'on'): client ids per target,
      // one per message_ids entry. Declared so normalisation never strips it.
      ids: t.Optional(t.Record(t.String(), t.Array(t.String()))),
    })
  })

  .delete("/delete", async ({ set, auth, body }) => {
    const delete_result = await delete_messages(body, auth.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      conversation_id: t.String(),
      delete_for_everyone: t.Optional(t.Boolean())
    })
  })

  .get("/pinned/:conversation_id", async ({ set, auth, params }) => {
    const pinned_result = await get_pinned_messages(params.conversation_id, auth.id);
    set.status = pinned_result.code;
    return pinned_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  .get("/starred", async ({ set, auth, query }) => {
    const starred_result = await get_starred_messages(auth.id, query.conversation_id);
    set.status = starred_result.code;
    return starred_result;
  }, {
    query: t.Object({
      conversation_id: t.Optional(t.String())
    })
  })

  .delete("/delete-for-me", async ({ set, auth, body }) => {
    const delete_result = await delete_message_for_me(
      body.message_ids,
      auth.id,
      body.conversation_id
    );
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      conversation_id: t.String()
    })
  })


  .delete("/soft-delete", async ({ set, auth, body }) => {
    // `is_admin_or_staff` is still accepted (old clients send it) but IGNORED:
    // delete authority is derived server-side from the authenticated user's
    // role + chat membership (soft_delete_message → resolve_delete_authority).
    const delete_result = await soft_delete_message(
      body.message_ids,
      auth.id,
    );
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      is_admin_or_staff: t.Optional(t.Boolean())
    })
  })

  .post("/react", async ({ set, auth, body }) => {
    const react_result = await react_to_message(
      { message_id: body.message_id, conversation_id: body.conversation_id, emoji: body.emoji, action: body.action },
      auth.id,
      body.sender_name
    );
    set.status = react_result.code;
    return react_result;
  }, {
    body: t.Object({
      message_id: t.String(),
      conversation_id: t.String(),
      emoji: t.String(),
      action: t.Union([t.Literal('add'), t.Literal('remove')]),
      sender_name: t.Optional(t.String()),
    })
  })

  .post("/verify-ids", async ({ set, auth, body }) => {
    const result = await verify_message_ids(body.message_ids, body.conversation_id, auth.id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      conversation_id: t.String(),
    }),
  });

