import Elysia, { t } from "elysia";
import { app_middleware } from "@/middleware";
import { add_new_member, create_group, demote_to_member, get_group_info, leave_group, list_join_requests, promote_to_admin, remove_member, request_join, respond_join_request, transfer_ownership, update_group_profile_pic, update_group_title } from "@/services/chat-group.service";
import { compute_group_caps, GroupCaps, load_group_actor_context } from "@/services/group-caps";

// Loads the actor's capabilities for a group so a route can gate before
// touching the service. Returns null when the group doesn't exist.
const actor_caps = async (conversation_id: string, actor_id: string): Promise<GroupCaps | null> => {
  const ctx = await load_group_actor_context(conversation_id, actor_id);
  if (!ctx.exists) return null;
  return compute_group_caps({
    ownerId: ctx.ownerId,
    myUserId: actor_id,
    myGroupRole: ctx.role,
    myStatus: ctx.status,
    globalRole: ctx.globalRole,
  });
};

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
    const caps = await actor_caps(body.conversation_id, store.id);
    if (!caps?.canManageMembers) {
      set.status = 403;
      return { success: false, code: 403, message: "You can't add members to this group" };
    }
    // Only owner/master may seed someone in as an admin — a group admin can add
    // members but can't mint other admins (that's the promote restriction).
    if (body.role === "admin" && !caps.canPromoteDemote) {
      set.status = 403;
      return { success: false, code: 403, message: "Only the owner can add members as admins" };
    }
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
    const caps = await actor_caps(body.conversation_id, store.id);
    if (!caps?.canManageMembers) {
      set.status = 403;
      return { success: false, code: 403, message: "You can't remove members from this group" };
    }
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
    const caps = await actor_caps(body.conversation_id, store.id);
    if (!caps?.canPromoteDemote) {
      set.status = 403;
      return { success: false, code: 403, message: "Only the owner can assign admins" };
    }
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
    const caps = await actor_caps(body.conversation_id, store.id);
    if (!caps?.canPromoteDemote) {
      set.status = 403;
      return { success: false, code: 403, message: "Only the owner can change admins" };
    }
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

  // Leave a group. Owner must supply new_owner_id (an active member) to hand
  // off ownership first; everyone else leaves freely. The service enforces this.
  .post("/leave-group", async ({ set, store, body }) => {
    const result = await leave_group(body.conversation_id, store.id, body.new_owner_id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      new_owner_id: t.Optional(t.String()),
    })
  })

  // Hand off ownership without leaving (owner / master only — service-gated).
  .post("/transfer-ownership", async ({ set, store, body }) => {
    const result = await transfer_ownership(body.conversation_id, store.id, body.new_owner_id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      new_owner_id: t.String(),
    })
  })

  // An ex-member (status 'left') requests to rejoin.
  .post("/request-join", async ({ set, store, body }) => {
    const result = await request_join(body.conversation_id, store.id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
    })
  })

  // Owner / master lists pending join requests (service-gated).
  .get("/join-requests/:conversation_id", async ({ set, store, params }) => {
    const result = await list_join_requests(params.conversation_id, store.id);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({ conversation_id: t.String() })
  })

  // Owner / master approves or rejects a pending request (service-gated).
  .post("/respond-join-request", async ({ set, store, body }) => {
    const result = await respond_join_request(
      body.conversation_id,
      store.id,
      body.user_id,
      body.action,
    );
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      conversation_id: t.String(),
      user_id: t.String(),
      action: t.Union([t.Literal("approve"), t.Literal("reject")]),
    })
  })
