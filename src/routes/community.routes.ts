import { Elysia, t } from "elysia";
import { app_middleware } from "@/middleware";
import db from "@/config/db";
import { conversation_model } from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import { and, eq, desc } from "drizzle-orm";
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

  // Community CRUD operations
  .post("/create", async ({ set, store, body }) => {
    const community_result = await create_community(store.id, body);
    set.status = community_result.code;
    return community_result;
  }, {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 255 }),
      description: t.Optional(t.String({ maxLength: 1000 })),
      metadata: t.Optional(t.Any())
    })
  })

  .get("/list-all", async ({ set, store }) => {
    const communities_result = await get_communities(store.id);
    set.status = communities_result.code;
    return communities_result;
  })

  .get("/list-connected-communities", async ({ set, store }) => {
    const communities_result = await get_connected_communities(store.id);
    set.status = communities_result.code;
    return communities_result;
  })

  .get("/:community_id", async ({ set, store, params }) => {
    const community_result = await get_community_details(params.community_id, store.id);
    set.status = community_result.code;
    return community_result;
  }, {
    params: t.Object({
      community_id: t.Number()
    })
  })

  .put("/:community_id", async ({ set, store, params, body }) => {
    const update_result = await update_community(params.community_id, store.id, body);
    set.status = update_result.code;
    return update_result;
  }, {
    params: t.Object({
      community_id: t.Number()
    }),
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
      description: t.Optional(t.String({ maxLength: 1000 })),
      metadata: t.Optional(t.Any())
    })
  })

  .delete("/:community_id", async ({ set, store, params }) => {
    const delete_result = await delete_community(params.community_id, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      community_id: t.Number()
    })
  })

  // Community group management
  .post("/:community_id/groups/add", async ({ set, store, params, body }) => {
    const add_result = await add_community_groups(
      params.community_id,
      store.id,
      { ...body, community_id: params.community_id }
    );
    set.status = add_result.code;
    return add_result;
  }, {
    params: t.Object({
      community_id: t.Number()
    }),
    body: t.Object({
      group_ids: t.Array(t.Number())
    })
  })

  .post("/:community_id/groups/remove", async ({ set, store, params, body }) => {
    const remove_result = await remove_community_groups(
      params.community_id,
      store.id,
      { ...body, community_id: params.community_id }
    );
    set.status = remove_result.code;
    return remove_result;
  }, {
    params: t.Object({
      community_id: t.Number()
    }),
    body: t.Object({
      group_ids: t.Array(t.Number())
    })
  })

  // Community group management
  .post("/:community_id/groups/create", async ({ set, store, params, body }) => {
    const group_result = await create_community_group(store.id, {
      ...body,
      community_id: params.community_id
    });
    set.status = group_result.code;
    return group_result;
  }, {
    params: t.Object({
      community_id: t.Number()
    }),
    body: t.Object({
      title: t.String({ minLength: 1, maxLength: 255 }),
      active_time_slots: t.Array(t.Object({
        start_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" }), // HH:MM format
        end_time: t.String({ pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" })    // HH:MM format
      })),
      timezone: t.Optional(t.String()),
      active_days: t.Optional(t.Array(t.Number({ minimum: 0, maximum: 6 }))), // 0 = Sunday, 6 = Saturday
      member_ids: t.Optional(t.Array(t.Number()))
    })
  })

  .put("/groups/:conversation_id", async ({ set, store, params, body }) => {
    const update_result = await update_community_group(store.id, {
      ...body,
      conversation_id: params.conversation_id
    });
    set.status = update_result.code;
    return update_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
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

  .get("/:community_id/groups", async ({ set, store, params }) => {
    const groups_result = await get_community_groups(params.community_id, store.id);
    set.status = groups_result.code;
    return groups_result;
  }, {
    params: t.Object({
      community_id: t.Number()
    })
  })

  .delete("/groups/:conversation_id", async ({ set, store, params }) => {
    const delete_result = await delete_community_group(params.conversation_id, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  })

  // Get all available groups (for adding to communities)
  .get("/all-groups", async ({ set }) => {
    const comm_group_res = await get_all_community_groups()
    set.status = comm_group_res.code;
    return comm_group_res;
  })

  .post("/create-standalone-group", async ({ set, store, body }) => {
    const stand_group_res = await create_standalone_comminity_group(store.id, body)
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
  .post("/add-group-to-communities", async ({ set, store, body }) => {
    const result = await add_group_to_multiple_communities(body.group_id, store.id, body.community_ids);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      group_id: t.Number(),
      community_ids: t.Array(t.Number())
    })
  });

export default community_routes;
