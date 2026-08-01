import { Elysia, t } from "elysia";
import { app_middleware } from "@/middleware";
import { clear_chat_for_user, get_chat_list, get_chat_members, get_conversation_history, get_message_statuses, get_messages_around, soft_delete_chat, soft_delete_message } from "@/services/chat.services";
import { set_chat_disappearing } from "@/services/disappearing.service";
import { set_user_chat_mute, clear_user_chat_mute } from "@/services/mute.service";

const chat_routes = new Elysia({ prefix: "/chat" })
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

  .get("/get-chat-list/:type", async ({ set, store, params }) => {
    const chats_result = await get_chat_list(store.id, params.type ? params.type : "all");
    // console.log("chats_result -> ", chats_result);
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
    // console.log("get conv history -> ", params);
    // console.log("query -> ", query);
    const history_result = await get_conversation_history(
      params.conversation_id,
      store.id,
      query.limit,
      query.before_message_id,
      query.after_message_id,
    );

    set.status = history_result.code;
    return history_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    }),
    query: t.Object({
      limit: t.Optional(t.Number({ minimum: 1, maximum: 500, default: 20 })),
      before_message_id: t.Optional(t.String()),
      after_message_id: t.Optional(t.String()),
    })
  })

  .get("/get-messages-around/:conversation_id/:message_id", async ({ set, store, params, query }) => {
    const result = await get_messages_around(
      params.conversation_id,
      params.message_id,
      store.id,
      query.before,
      query.after
    );
    set.status = result.code;
    return result;
  }, {
    params: t.Object({
      conversation_id: t.String(),
      message_id: t.String()
    }),
    query: t.Object({
      before: t.Optional(t.Number({ minimum: 0, maximum: 100, default: 32 })),
      after: t.Optional(t.Number({ minimum: 0, maximum: 100, default: 32 })),
    })
  })

  .get("/get-chat-members/:conversation_id", async ({ set, store, params }) => {
    const result = await get_chat_members(params.conversation_id, store.id);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({
      conversation_id: t.String()
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
      conversation_id: t.String()
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
      conversation_id: t.String()
    })
  })

  // "Clear chat" — drops the caller's own view of the conversation's history
  // while keeping their membership. Delete-for-me at chat scope; every other
  // member is untouched. Contrast /soft-delete-chat (deletes the chat for
  // EVERYONE, owner/master only) and /chat/dm/soft-delete-dm (removes the DM
  // from the caller's list entirely).
  .delete("/clear-chat/:conversation_id", async ({ set, store, params }) => {
    const clear_result = await clear_chat_for_user(params.conversation_id, store.id);
    set.status = clear_result.code;
    return clear_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  // Set/clear disappearing-messages duration for a chat. duration_sec=null
  // turns the feature off. See disappearing.service.ts:ALLOWED_DURATIONS for
  // accepted values (currently 24h / 7d / 90d, matching WhatsApp).
  .post("/disappearing/:conversation_id", async ({ set, store, params, body }) => {
    const result = await set_chat_disappearing(
      params.conversation_id,
      store.id,
      body.duration_sec,
    );
    set.status = result.code;
    return result;
  }, {
    params: t.Object({ conversation_id: t.String() }),
    body: t.Object({ duration_sec: t.Union([t.Number(), t.Null()]) }),
  })

  // Mute a chat for the calling user. `until` is an ISO timestamp; null
  // means "forever" (stored as a far-future epoch in muted_until). Notifications
  // (the local-notification painting in the app) get suppressed for muted
  // recipients via a `silent` flag on the FCM data payload — messages still
  // arrive and still land in the local DB.
  .post("/mute/:conversation_id", async ({ set, store, params, body }) => {
    const until = body.until ? new Date(body.until) : null;
    if (body.until && isNaN(until!.getTime())) {
      set.status = 400;
      return { success: false, code: 400, message: "Invalid until timestamp" };
    }
    const result = await set_user_chat_mute(params.conversation_id, store.id, until);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({ conversation_id: t.String() }),
    body: t.Object({ until: t.Union([t.String(), t.Null()]) }),
  })

  .post("/unmute/:conversation_id", async ({ set, store, params }) => {
    const result = await clear_user_chat_mute(params.conversation_id, store.id);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({ conversation_id: t.String() }),
  });

export default chat_routes;
