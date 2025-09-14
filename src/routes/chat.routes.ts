import { Elysia, t } from "elysia";
import { app_middleware } from "@/middleware";
import { create_chat, get_chat_list } from "@/services/chat.services";

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
  },{
    params: t.Object({
      reciver_id: t.Number()
    })
  })

  .get("/get-chat-list", async ({ set, store }) => {
    const chats_result = await get_chat_list(store.id);
    set.status = chats_result.code;
    return chats_result;
  })


export default chat_routes;
