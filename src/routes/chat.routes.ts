import { Elysia, t } from "elysia";
import { app_middleware } from "@/middleware";
import {
  create_chat,
  get_chat_list,
  create_group,
  add_new_member,
  remove_member,
  update_group_title,
  delete_conversation,
  get_conversation_history,
  mark_as_delete_message,
  mark_as_delete_conversation,
  get_group_info
} from "@/services/chat.services";
import {
  pin_message,
  star_messages,
  reply_to_message,
  forward_messages,
  delete_messages,
  get_pinned_messages,
  get_starred_messages
} from "@/services/message-operations.services";

const chat_routes = new Elysia({ prefix: "/chat" })
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

  .post("/create-chat/:reciver_id", async ({ set, store, params }) => {
    const chat_result = await create_chat(store.id, params.reciver_id);
    set.status = chat_result.code;
    return chat_result;
  }, {
    params: t.Object({
      reciver_id: t.Number()
    })
  })

  .get("/get-chat-list/:type", async ({ set, store, params }) => {
    const chats_result = await get_chat_list(store.id, params.type ? params.type : "all");
    set.status = chats_result.code;
    return chats_result;
  },
    {
      params: t.Optional(
        t.Object({ type: t.String() })
      )
    }
  )

  .get("/get-group-info/:conversation_id", async ({ set, store, params }) => {
    const chats_result = await get_group_info(params.conversation_id);
    set.status = chats_result.code;
    return chats_result;
  },
    {
      params: t.Object({ conversation_id: t.Number() })
    }
  )

  .post("/create-group", async ({ set, store, body }) => {
    const group_result = await create_group(store.id, body.title, body.member_ids);
    set.status = group_result.code;
    return group_result;
  }, {
    body: t.Object({
      title: t.String(),
      member_ids: t.Optional(t.Array(t.Number()))
    })
  })

  .post("/add-members", async ({ set, store, body }) => {
    const member_result = await add_new_member(body.conversation_id, body.user_ids, body.role);
    set.status = member_result.code;
    return member_result;
  }, {
    body: t.Object({
      conversation_id: t.Number(),
      user_ids: t.Array(t.Number()),
      role: t.Optional(t.Union([t.Literal("admin"), t.Literal("member")]))
    })
  })

  .delete("/remove-member", async ({ set, store, body }) => {
    const member_result = await remove_member(body.conversation_id, body.user_id);
    set.status = member_result.code;
    return member_result;
  }, {
    body: t.Object({
      conversation_id: t.Number(),
      user_id: t.Number()
    })
  })

  .put("/update-group-title", async ({ set, store, body }) => {
    const title_result = await update_group_title(body.conversation_id, body.title);
    set.status = title_result.code;
    return title_result;
  }, {
    body: t.Object({
      conversation_id: t.Number(),
      title: t.String()
    })
  })

  .get("/get-conversation-history/:conversation_id", async ({ set, store, params, query }) => {
    const history_result = await get_conversation_history(
      params.conversation_id,
      store.id,
      query.page,
      query.limit
    );
    set.status = history_result.code;
    return history_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    }),
    query: t.Object({
      page: t.Optional(t.Number({ minimum: 1, default: 1 })),
      limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 }))
    })
  })

  .delete("/delete-conversation/:conversation_id", async ({ set, store, params }) => {
    const delete_result = await delete_conversation(params.conversation_id, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  })

  .delete("/mark-as-delete-conversation/:conversation_id", async ({ set, store, params }) => {
    const delete_result = await mark_as_delete_conversation(params.conversation_id, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  })

  .delete("/mark-as-delete-message", async ({ set, store, body }) => {
    console.log("body ->", body)
    const delete_result = await mark_as_delete_message(body.message_ids, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.Number())
    })
  })

  // Message operations routes
  .post("/messages/pin", async ({ set, store, body }) => {
    const pin_result = await pin_message(body, store.id);
    set.status = pin_result.code;
    return pin_result;
  }, {
    body: t.Object({
      message_id: t.Number(),
      conversation_id: t.Number()
    })
  })

  .post("/messages/star", async ({ set, store, body }) => {
    const star_result = await star_messages(body, store.id);
    set.status = star_result.code;
    return star_result;
  }, {
    body: t.Object({
      message_ids: t.Array(t.Number()),
      conversation_id: t.Number()
    })
  })

  .post("/messages/reply", async ({ set, store, body }) => {
    const reply_result = await reply_to_message(body, store.id);
    set.status = reply_result.code;
    return reply_result;
  }, {
    body: t.Object({
      reply_to_message_id: t.Number(),
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
      message_ids: t.Array(t.Number()),
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
      message_ids: t.Array(t.Number()),
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

export default chat_routes;
