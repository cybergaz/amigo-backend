import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { add_new_member, create_group, demote_to_member, get_group_info, promote_to_admin, remove_member, update_group_profile_pic, update_group_title } from "@/services/chat-group.service";

export const chat_group_routes = new Elysia({ prefix: "/chat/group" })
  .state({ id: "", role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  .post("/create-group", async ({ set, store, body }) => {
    const group_result = await create_group(store.id, body.title, body.member_ids);
    set.status = group_result.code;
    return group_result;
  }, {
    body: t.Object({
      title: t.String(),
      member_ids: t.Optional(t.Array(t.String()))
    })
  })

  .get("/get-group-info/:conversation_id", async ({ set, store, params }) => {
    const chats_result = await get_group_info(params.conversation_id);
    set.status = chats_result.code;
    return chats_result;
  },
    {
      params: t.Object({ conversation_id: t.String() })
    }
  )

  .post("/add-members", async ({ set, store, body }) => {
    const member_result = await add_new_member(
      body.conversation_id,
      body.user_ids,
      body.role,
      store.id,
    );
    set.status = member_result.code;
    return member_result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      user_ids: t.Array(t.String()),
      role: t.Optional(t.Union([t.Literal("admin"), t.Literal("member")]))
    })
  })

  .delete("/remove-member", async ({ set, store, body }) => {
    const member_result = await remove_member(
      body.conversation_id,
      body.user_id,
      store.id,
    );
    set.status = member_result.code;
    return member_result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      user_id: t.String()
    })
  })

  .post("/promote-to-admin", async ({ set, store, body }) => {
    const promotion_result = await promote_to_admin(
      body.conversation_id,
      body.user_id,
      store.id,
    );
    set.status = promotion_result.code;
    return promotion_result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      user_id: t.String(),
    })
  })

  .post("/demote-to-member", async ({ set, store, body }) => {
    const promotion_result = await demote_to_member(
      body.conversation_id,
      body.user_id,
      store.id,
    );
    set.status = promotion_result.code;
    return promotion_result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      user_id: t.String(),
    })
  })

  .put("/update-group-title", async ({ set, store, body }) => {
    const title_result = await update_group_title(body.conversation_id, body.title, store.id);
    set.status = title_result.code;
    return title_result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      title: t.String()
    })
  })

  .post("/update-group-profile-image", async ({ set, store, body }) => {
    if (!body.image) {
      set.status = 400;
      return { success: false, message: "No image file provided" };
    }
    const result = await update_group_profile_pic(body.conversation_id, store.id, body.image);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      image: t.File({
        type: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
        maxSize: 5 * 1024 * 1024, // 5MB
      }),
    })
  })
