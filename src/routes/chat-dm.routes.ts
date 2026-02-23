import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { create_dm, dm_delete_status } from "@/services/chat-dm.service";

export const chat_dm_routes = new Elysia({ prefix: "/chat/dm" })
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

  .post("/create-dm/:reciver_id", async ({ set, store, params }) => {
    const chat_result = await create_dm(store.id, params.reciver_id);
    set.status = chat_result.code;
    return chat_result;
  }, {
    params: t.Object({
      reciver_id: t.Number()
    })
  })

  .delete("/soft-delete-dm/:conversation_id", async ({ set, store, params }) => {
    const delete_result = await dm_delete_status(params.conversation_id, store.id, true);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  });
