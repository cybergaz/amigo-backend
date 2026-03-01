import { Elysia, t } from "elysia";
import { app_middleware } from "@/middleware";
import { get_chat_list, get_conversation_history, get_message_statuses, soft_delete_chat, soft_delete_message } from "@/services/chat.services";
import { dm_delete_status } from "@/services/chat-dm.service";

const chat_routes = new Elysia({ prefix: "/chat" })
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
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

  .get("/get-conversation-history/:conversation_id", async ({ set, store, params, query }) => {
    console.log("get conv history -> ", params);
    console.log("query -> ", query);
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
      limit: t.Optional(t.Number({ minimum: 1, maximum: 500, default: 20 }))
    })
  })

  .get("/get-message-statuses/:conversation_id", async ({ set, store, params, query }) => {
    const statuses_result = await get_message_statuses(
      params.conversation_id,
      store.id,
      query.page,
      query.limit
    );
    set.status = statuses_result.code;
    return statuses_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    }),
    query: t.Object({
      page: t.Optional(t.Number({ minimum: 1, default: 1 })),
      limit: t.Optional(t.Number({ minimum: 1, maximum: 10000, default: 1000 }))
    })
  })

  .delete("/soft-delete-chat/:conversation_id", async ({ set, store, params }) => {
    const delete_result = await soft_delete_chat(params.conversation_id, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  })

  .post("/revive-chat/:conversation_id", async ({ set, store, params }) => {
    const delete_result = await dm_delete_status(params.conversation_id, store.id, false);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  });

export default chat_routes;
