import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import {
  create_broadcast_list,
  delete_broadcast_list,
  get_broadcast_copies,
  get_broadcast_list,
  update_broadcast_list,
} from "@/services/chat-broadcast.service";
import { BROADCAST_COPIES_MAX_IDS } from "@/utils/broadcast.utils";

// Broadcast lists (WhatsApp-style) — contract in BROADCAST_LISTS.md.
// Every endpoint is owner-only: the service resolves the list with
// owner_id = caller, so another user's list is indistinguishable from a
// missing one (404).
//
// Raw id arrays are capped generously here (a malformed client can't post a
// 100k-element body); the real limits — ≤ 250 recipients AFTER dedupe /
// self-removal / existence filtering — are enforced in the service.
const RAW_ID_ARRAY_MAX = 1000;

export const chat_broadcast_routes = new Elysia({ prefix: "/chat/broadcast" })
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

  .post("/create", async ({ set, store, body }) => {
    const result = await create_broadcast_list(store.id, body.title, body.recipient_ids);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      title: t.Optional(t.Union([t.String(), t.Null()])),
      recipient_ids: t.Array(t.String(), { maxItems: RAW_ID_ARRAY_MAX }),
    })
  })

  // Statuses of every copy of up to 100 broadcast messages (backfill after a
  // lost ack / reinstall, and the message-info sheet). Static path, so it is
  // matched before the "/:id" routes below (which are GET/PATCH/DELETE only).
  .post("/copies", async ({ set, store, body }) => {
    const result = await get_broadcast_copies(store.id, body.broadcast_msg_ids);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      broadcast_msg_ids: t.Array(t.String(), { maxItems: BROADCAST_COPIES_MAX_IDS }),
    })
  })

  .get("/:id", async ({ set, store, params }) => {
    const result = await get_broadcast_list(store.id, params.id);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({ id: t.String() })
  })

  .patch("/:id", async ({ set, store, params, body }) => {
    const result = await update_broadcast_list(store.id, params.id, {
      title: body.title,
      add_ids: body.add_ids,
      remove_ids: body.remove_ids,
    });
    set.status = result.code;
    return result;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      title: t.Optional(t.Union([t.String(), t.Null()])),
      add_ids: t.Optional(t.Array(t.String(), { maxItems: RAW_ID_ARRAY_MAX })),
      remove_ids: t.Optional(t.Array(t.String(), { maxItems: RAW_ID_ARRAY_MAX })),
    })
  })

  .delete("/:id", async ({ set, store, params }) => {
    const result = await delete_broadcast_list(store.id, params.id);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({ id: t.String() })
  });
