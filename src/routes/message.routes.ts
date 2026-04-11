import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { delete_message_for_me, soft_delete_message } from "@/services/chat.services";
import { delete_messages, forward_messages, get_pinned_messages, get_starred_messages, mark_message_delivered, mark_messages_delivered_batch, react_to_message, reply_to_message, star_messages, verify_message_ids } from "@/services/message.services";

export const message_routes = new Elysia({ prefix: "/message" })
  .state({ id: "", role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  .post("/delivered", async ({ set, store, body }) => {
    // console.log("delivered ack through api -> ", body);
    const delivery_result = await mark_message_delivered(
      body.message_id,
      body.conversation_id,
      store.id
    );
    set.status = delivery_result.code;
    return delivery_result;
  }, {
    body: t.Object({
      message_id: t.String(),
      conversation_id: t.String()
    })
  })

  .post("/delivered/batch", async ({ set, store, body }) => {
    const delivery_result = await mark_messages_delivered_batch(body.messages, store.id);
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

  .post("/star", async ({ set, store, body }) => {
    const star_result = await star_messages(body, store.id);
    set.status = star_result.code;
    return star_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      conversation_id: t.String()
    })
  })

  .post("/reply", async ({ set, store, body }) => {
    const reply_result = await reply_to_message(body, store.id);
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

  .post("/forward", async ({ set, store, body }) => {
    const forward_result = await forward_messages(body, store.id);
    set.status = forward_result.code;
    return forward_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      source_conversation_id: t.String(),
      target_conversation_ids: t.Array(t.String())
    })
  })

  .delete("/delete", async ({ set, store, body }) => {
    const delete_result = await delete_messages(body, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      conversation_id: t.String(),
      delete_for_everyone: t.Optional(t.Boolean())
    })
  })

  .get("/pinned/:conversation_id", async ({ set, store, params }) => {
    const pinned_result = await get_pinned_messages(params.conversation_id, store.id);
    set.status = pinned_result.code;
    return pinned_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  .get("/starred", async ({ set, store, query }) => {
    const starred_result = await get_starred_messages(store.id, query.conversation_id);
    set.status = starred_result.code;
    return starred_result;
  }, {
    query: t.Object({
      conversation_id: t.Optional(t.String())
    })
  })

  .delete("/delete-for-me", async ({ set, store, body }) => {
    const delete_result = await delete_message_for_me(
      body.message_ids,
      store.id,
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


  .delete("/soft-delete", async ({ set, store, body }) => {
    const delete_result = await soft_delete_message(
      body.message_ids,
      store.id,
      body.is_admin_or_staff ?? false
    );
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      is_admin_or_staff: t.Optional(t.Boolean())
    })
  })

  .post("/react", async ({ set, store, body }) => {
    const react_result = await react_to_message(
      { message_id: body.message_id, conversation_id: body.conversation_id, emoji: body.emoji, action: body.action },
      store.id,
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

  .post("/verify-ids", async ({ set, store, body }) => {
    const result = await verify_message_ids(body.message_ids, body.conversation_id, store.id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.String()),
      conversation_id: t.String(),
    }),
  });

