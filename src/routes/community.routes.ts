import { Elysia, t } from "elysia";
import { app_middleware } from "@/middleware";
import { request_auth } from "@/middleware/request-auth";
import {
  create_community,
  get_communities,
  get_community_details,
  update_community,
  delete_community,
  add_community_groups,
  remove_community_groups,
  create_community_group,
  update_community_group,
  get_community_groups,
  delete_community_group,
  get_connected_communities,
  get_all_community_groups,
  create_standalone_comminity_group,
  add_group_to_multiple_communities
} from "@/services/community.services";

const community_routes = new Elysia({ prefix: "/community" })
  // Per-request identity (middleware/request-auth.ts), never the app-wide store.
  .resolve(({ cookie, set, headers }) => request_auth(set, app_middleware({ cookie, headers })))

  // Community CRUD operations
  .post("/create", async ({ set, auth, body }) => {
    const community_result = await create_community(auth.id, body);
    set.status = community_result.code;
    return community_result;
  }, {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 255 }),
      description: t.Optional(t.String({ maxLength: 1000 })),
      metadata: t.Optional(t.Any())
    })
  })

  .get("/list-all", async ({ set, auth }) => {
    const communities_result = await get_communities(auth.id);
    set.status = communities_result.code;
    return communities_result;
  })

  .get("/list-connected-communities", async ({ set, auth }) => {
    const communities_result = await get_connected_communities(auth.id);
    set.status = communities_result.code;
    return communities_result;
  })

  .get("/:community_id", async ({ set, auth, params }) => {
    const community_result = await get_community_details(params.community_id, auth.id);
    set.status = community_result.code;
    return community_result;
  }, {
    params: t.Object({
      community_id: t.String()
    })
  })

  .put("/:community_id", async ({ set, auth, params, body }) => {
    const update_result = await update_community(params.community_id, auth.id, body);
    set.status = update_result.code;
    return update_result;
  }, {
    params: t.Object({
      community_id: t.String()
    }),
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
      description: t.Optional(t.String({ maxLength: 1000 })),
      metadata: t.Optional(t.Any())
    })
  })

  .delete("/:community_id", async ({ set, auth, params }) => {
    const delete_result = await delete_community(params.community_id, auth.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      community_id: t.String()
    })
  })

  // Community group management
  .post("/:community_id/groups/add", async ({ set, auth, params, body }) => {
    const add_result = await add_community_groups(
      params.community_id,
      auth.id,
      { ...body, community_id: params.community_id }
    );
    set.status = add_result.code;
    return add_result;
  }, {
    params: t.Object({
      community_id: t.String()
    }),
    body: t.Object({
      group_ids: t.Array(t.String())
    })
  })

  .post("/:community_id/groups/remove", async ({ set, auth, params, body }) => {
    const remove_result = await remove_community_groups(
      params.community_id,
      auth.id,
      { ...body, community_id: params.community_id }
    );
    set.status = remove_result.code;
    return remove_result;
  }, {
    params: t.Object({
      community_id: t.String()
    }),
    body: t.Object({
      group_ids: t.Array(t.String())
    })
  })

  // Community group management
  .post("/:community_id/groups/create", async ({ set, auth, params, body }) => {
    const group_result = await create_community_group(auth.id, {
      ...body,
      community_id: params.community_id
    });
    set.status = group_result.code;
    return group_result;
  }, {
    params: t.Object({
      community_id: t.String()
    }),
    body: t.Object({
      title: t.String({ minLength: 1, maxLength: 255 }),
      active_time_slots: t.Array(t.Object({
        start_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" }), // HH:MM format
        end_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" })    // HH:MM format
      })),
      timezone: t.Optional(t.String()),
      active_days: t.Optional(t.Array(t.Number({ minimum: 0, maximum: 6 }))), // 0 = Sunday, 6 = Saturday
      member_ids: t.Optional(t.Array(t.String()))
    })
  })

  .put("/groups/:conversation_id", async ({ set, auth, params, body }) => {
    const update_result = await update_community_group(auth.id, {
      ...body,
      conversation_id: params.conversation_id
    });
    set.status = update_result.code;
    return update_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    }),
    body: t.Object({
      title: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
      active_time_slots: t.Optional(t.Array(t.Object({
        start_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" }),
        end_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" })
      }))),
      timezone: t.Optional(t.String()),
      active_days: t.Optional(t.Array(t.Number({ minimum: 0, maximum: 6 })))
    })
  })

  .get("/:community_id/groups", async ({ set, auth, params }) => {
    const groups_result = await get_community_groups(params.community_id, auth.id);
    set.status = groups_result.code;
    return groups_result;
  }, {
    params: t.Object({
      community_id: t.String()
    })
  })

  .delete("/groups/:conversation_id", async ({ set, auth, params }) => {
    const delete_result = await delete_community_group(params.conversation_id, auth.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  // Get all available groups (for adding to communities)
  .get("/all-groups", async ({ set }) => {
    const comm_group_res = await get_all_community_groups()
    set.status = comm_group_res.code;
    return comm_group_res;
  })

  .post("/create-standalone-group", async ({ set, auth, body }) => {
    const stand_group_res = await create_standalone_comminity_group(auth.id, body)
    set.status = stand_group_res.code;
    return stand_group_res;
  }, {
    body: t.Object({
      title: t.String({ minLength: 1, maxLength: 255 }),
      active_time_slots: t.Array(t.Object({
        start_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" }), // HH:MM format
        end_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" })    // HH:MM format
      })),
      timezone: t.Optional(t.String()),
    })
  })

  // Add group to multiple communities at once
  .post("/add-group-to-communities", async ({ set, auth, body }) => {
    const result = await add_group_to_multiple_communities(body.group_id, auth.id, body.community_ids);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      group_id: t.String(),
      community_ids: t.Array(t.String())
    })
  });

export default community_routes;
