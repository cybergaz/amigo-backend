import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { request_auth } from "@/middleware/request-auth";
import { create_dm, dm_delete_status } from "@/services/chat-dm.service";

export const chat_dm_routes = new Elysia({ prefix: "/chat/dm" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide store.
  .resolve(({ cookie, set, headers }) => request_auth(set, app_middleware({ cookie, headers })))

  .post("/create-dm/:reciver_id", async ({ set, auth, params }) => {
    const chat_result = await create_dm(auth.id, params.reciver_id);
    set.status = chat_result.code;
    return chat_result;
  }, {
    params: t.Object({
      reciver_id: t.String()
    })
  })

  .delete("/soft-delete-dm/:conversation_id", async ({ set, auth, params }) => {
    const delete_result = await dm_delete_status(params.conversation_id, auth.id, true);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  });
