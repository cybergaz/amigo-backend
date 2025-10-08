import { app_middleware } from "@/middleware";
import Elysia, { t } from "elysia";
import { get_all_users_paginated, update_user_role, update_user_call_access, get_dashboard_stats, create_admin_user, get_all_admins, update_admin_permissions, update_admin_status, get_user_permissions } from "@/services/user.services";
import { get_chat_list, get_group_info, add_new_member, remove_member, get_conversation_history, get_all_conversations_admin, get_conversation_members_admin, get_conversation_history_admin, permanently_delete_message_admin } from "@/services/chat.services";
import { get_communities, get_community_groups } from "@/services/community.services";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { create_unique_id } from "@/utils/general.utils";
import { RoleType } from "@/types/user.types";

const admin_routes = new Elysia({ prefix: "/admin" })
  // unauthorized route to create a super admin if none exists
  .get("/seed-admin", async ({ set }) => {
    const newAdmin = await db
      .insert(user_model)
      .values({
        id: create_unique_id(),
        name: "Super Admin",
        email: "admin@gmail.com",
        role: "admin" as RoleType,
        hashed_password: "$2b$10$F0.mx/.RuN.J3NDSxzvUBOyiFYdiktAPuMCJWUs.08uOmOmNGdXpG",
        refresh_token: "temp_token_to_be_changed",
      })

    if (!newAdmin) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Failed to create admin user",
      };
    }
    set.status = 200;
    return {
      success: true,
      code: 200,
      message: "If no admin existed, one has been created, (NOTE: only the developer know the email & password)",
    };
  })

  // Middleware to protect all routes below
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers, allowed: ["admin", "sub_admin"] });

      set.status = state_result.code;
      if (!state_result.data) return state_result

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  // Admin Management Routes
  .get("/admins", async ({ set, store }) => {
    try {
      // Only super admin can view all admins
      if (store.role !== "admin") {
        set.status = 403;
        return {
          success: false,
          code: 403,
          message: "Only super admin can access admin management",
          data: null,
        };
      }

      const result = await get_all_admins();

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .post("/create-admin", async ({ body, set, store }) => {
    try {
      // Only super admin can create sub-admins
      if (store.role !== "admin") {
        set.status = 403;
        return {
          success: false,
          code: 403,
          message: "Only super admin can create admin accounts",
          data: null,
        };
      }

      const { email, password, permissions } = body as {
        email: string;
        password: string;
        permissions: string[]
      };

      if (!email || !password || !permissions || !Array.isArray(permissions)) {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Missing required fields: email, password, and permissions",
          data: null,
        };
      }

      const result = await create_admin_user(email, password, permissions);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    body: t.Object({
      email: t.String(),
      password: t.String(),
      permissions: t.Array(t.String())
    })
  })

  .put("/update-admin-permissions", async ({ body, set, store }) => {
    try {
      // Only super admin can update permissions
      if (store.role !== "admin") {
        set.status = 403;
        return {
          success: false,
          code: 403,
          message: "Only super admin can update admin permissions",
          data: null,
        };
      }

      const { id, permissions } = body as { id: number; permissions: string[] };

      if (!id || !permissions || !Array.isArray(permissions)) {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Missing required fields: id and permissions",
          data: null,
        };
      }

      const result = await update_admin_permissions(id, permissions);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    body: t.Object({
      id: t.Number(),
      permissions: t.Array(t.String())
    })
  })

  .put("/update-admin-status", async ({ body, set, store }) => {
    try {
      // Only super admin can update admin status
      if (store.role !== "admin") {
        set.status = 403;
        return {
          success: false,
          code: 403,
          message: "Only super admin can update admin status",
          data: null,
        };
      }

      const { id, active } = body as { id: number; active: boolean };

      if (!id || typeof active !== 'boolean') {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Missing required fields: id and active status",
          data: null,
        };
      }

      // Prevent super admin from deactivating themselves
      if (id === store.id) {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Cannot change your own status",
          data: null,
        };
      }

      const result = await update_admin_status(id, active);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    body: t.Object({
      id: t.Number(),
      active: t.Boolean()
    })
  })

  .get("/user-permissions", async ({ set, store }) => {
    try {
      const result = await get_user_permissions(store.id);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .get("/fetch-all-users", async ({ query, set, store }) => {
    try {
      const page = Number(query.page) || 1;
      const limit = Number(query.limit) || 10;
      const search = query.search as string || '';

      const result = await get_all_users_paginated(page, limit, search);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .get("/dashboard-stats", async ({ set, store }) => {
    try {
      const result = await get_dashboard_stats();

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .put("/update-user-role", async ({ body, set, store }) => {
    try {
      const { id, role } = body as { id: number; role: string };

      if (!id || !role) {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Missing required fields: id and role",
          data: null,
        };
      }

      const result = await update_user_role(id, role as any);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .put("/update-user-call-access", async ({ body, set, store }) => {
    try {
      const { id, call_access } = body as { id: number; call_access: boolean };

      if (!id || typeof call_access !== 'boolean') {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Missing required fields: id and call_access",
          data: null,
        };
      }

      const result = await update_user_call_access(id, call_access);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  // Admin Chat Management Routes
  .get("/chat-management/stats", async ({ set, store }) => {
    try {
      // Get all conversations for admin overview
      const allGroups = await get_all_conversations_admin("group");
      const allDms = await get_all_conversations_admin("dm");
      const allCommunities = await get_communities(store.id);

      // Calculate stats
      let totalGroups = 0;
      let adminManagedGroups = 0;
      let userCreatedGroups = 0;
      let totalInnerGroups = 0;
      let totalDirectChats = 0;
      let totalMembers = 0;

      // Process groups
      if (allGroups.success && allGroups.data) {
        totalGroups = allGroups.data.length;
        adminManagedGroups = allGroups.data.filter((group: any) =>
          group.createrId === store.id // Admin created groups
        ).length;
        userCreatedGroups = totalGroups - adminManagedGroups;

        // Calculate total members from groups
        totalMembers += allGroups.data.reduce((sum: number, group: any) => sum + group.memberCount, 0);
      }

      // Process DMs
      if (allDms.success && allDms.data) {
        totalDirectChats = allDms.data.length;
        // DMs have 2 members each
        totalMembers += totalDirectChats * 2;
      }

      // Process communities (inner groups)
      if (allCommunities.success && allCommunities.data) {
        for (const community of allCommunities.data) {
          const communityGroups = await get_community_groups(community.id, store.id);
          if (communityGroups.success && communityGroups.data) {
            totalInnerGroups += communityGroups.data.length;
          }
        }
      }

      set.status = 200;
      return {
        success: true,
        code: 200,
        data: {
          totalGroups,
          adminManagedGroups,
          userCreatedGroups,
          totalInnerGroups,
          totalDirectChats,
          totalMembers
        }
      };
    } catch (error) {
      console.error("Chat management stats error:", error);
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .get("/chat-management/groups", async ({ set, store, query }) => {
    try {
      const type = (query.type as string) || "all";
      const result = await get_all_conversations_admin(type);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .get("/chat-management/direct-chats", async ({ set, store, query }) => {
    try {
      const page = Number(query.page) || 1;
      const limit = Number(query.limit) || 10;

      const result = await get_all_conversations_admin("dm");

      if (result.success && result.data) {
        // Apply pagination
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedData = result.data.slice(startIndex, endIndex);

        set.status = 200;
        return {
          success: true,
          code: 200,
          data: {
            chats: paginatedData,
            pagination: {
              currentPage: page,
              totalPages: Math.ceil(result.data.length / limit),
              totalCount: result.data.length,
              limit,
              hasNextPage: page < Math.ceil(result.data.length / limit),
              hasPreviousPage: page > 1,
            }
          }
        };
      }

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .get("/chat-management/group-details/:conversation_id", async ({ set, store, params }) => {
    try {
      const result = await get_conversation_members_admin(params.conversation_id);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    params: t.Object({
      conversation_id: t.Number()
    })
  })

  .post("/chat-management/add-member", async ({ set, store, body }) => {
    try {
      const result = await add_new_member(
        body.conversation_id,
        body.user_ids,
        body.role || "member"
      );

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    body: t.Object({
      conversation_id: t.Number(),
      user_ids: t.Array(t.Number()),
      role: t.Optional(t.Union([t.Literal("admin"), t.Literal("member")]))
    })
  })

  .delete("/chat-management/remove-member", async ({ set, store, body }) => {
    try {
      const result = await remove_member(body.conversation_id, body.user_id);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    body: t.Object({
      conversation_id: t.Number(),
      user_id: t.Number()
    })
  })

  .get("/chat-management/conversation-history/:conversation_id", async ({ set, store, params, query }) => {
    try {
      const page = Number(query.page) || 1;
      const limit = Number(query.limit) || 20;

      const result = await get_conversation_history_admin(
        params.conversation_id,
        page,
        limit
      );

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    params: t.Object({
      conversation_id: t.Number()
    }),
    query: t.Object({
      page: t.Optional(t.Number({ minimum: 1, default: 1 })),
      limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 }))
    })
  })

  .get("/chat-management/communities", async ({ set, store }) => {
    try {
      const result = await get_communities(store.id);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  })

  .get("/chat-management/community-groups/:community_id", async ({ set, store, params }) => {
    try {
      const result = await get_community_groups(params.community_id, store.id);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    params: t.Object({
      community_id: t.Number()
    })
  })

  .delete("/chat-management/permanently-delete-message/:message_id", async ({ set, store, params }) => {
    try {
      // Only super admin can permanently delete messages
      if (store.role !== "admin") {
        set.status = 403;
        return {
          success: false,
          code: 403,
          message: "Only super admin can permanently delete messages",
          data: null,
        };
      }

      const result = await permanently_delete_message_admin(params.message_id);

      set.status = result.code;
      return result;
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        code: 500,
        message: "Internal server error",
        data: null,
      };
    }
  }, {
    params: t.Object({
      message_id: t.Number()
    })
  });

export default admin_routes;
