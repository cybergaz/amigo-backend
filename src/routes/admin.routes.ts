import { app_middleware } from "@/middleware";
import Elysia, { t } from "elysia";
import { get_all_users_paginated, update_user_role, update_user_call_access, get_dashboard_stats, create_admin_user, get_all_admins, update_admin_permissions, update_admin_status, get_user_permissions, delete_user_permanently } from "@/services/user.services";
import { get_chat_list, get_group_info, add_new_member, remove_member, get_conversation_history, get_all_conversations_admin, get_conversation_members_admin, get_conversation_history_admin, permanently_delete_message_admin } from "@/services/chat.services";
import { get_communities, get_community_groups } from "@/services/community.services";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { conversation_model } from "@/models/chat.model";
import { create_unique_id } from "@/utils/general.utils";
import { RoleType } from "@/types/user.types";
import { eq, sql } from "drizzle-orm";
import { community_model } from "@/models/community.model";

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

  .delete("/delete-user/:id", async ({ params, set, store }) => {
    try {
      // Only super admin can permanently delete users
      if (store.role !== "admin") {
        set.status = 403;
        return {
          success: false,
          code: 403,
          message: "Only super admin can permanently delete users",
          data: null,
        };
      }

      const userId = params.id;

      if (!userId) {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Missing required field: user id",
          data: null,
        };
      }

      // Prevent super admin from deleting themselves
      if (userId === store.id) {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Cannot delete your own account",
          data: null,
        };
      }

      const result = await delete_user_permanently(userId);

      set.status = result.code;
      return result;
    } catch (error) {
      console.error("Delete user error:", error);
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
      id: t.Number()
    })
  })

  // Admin Chat Management Routes
  .get("/chat-management/stats", async ({ set, store }) => {
    try {
      const [db_count_res] =
        await db.execute(sql`
            SELECT
              (SELECT COUNT(*) FROM ${user_model} WHERE role = 'user')::int AS users_count,
              (SELECT COUNT(*) FROM ${user_model} WHERE role = 'admin' OR role = 'sub_admin')::int AS admin_count,
              (SELECT COUNT(*) FROM ${conversation_model} WHERE type = 'group')::int AS group_count,
              (SELECT COUNT(*) FROM ${conversation_model} WHERE type = 'dm')::int AS dm_count,
              (SELECT COUNT(*) FROM ${conversation_model} WHERE type = 'community_group')::int AS comm_group_count,
              (SELECT COUNT(*) FROM ${community_model})::int AS comm_count
          `);

      set.status = 200;
      return {
        success: true,
        code: 200,
        data: {
          totalGroups: (Number(db_count_res.group_count) + Number(db_count_res.comm_group_count) | 0) | 0,
          adminManagedGroups: Number(db_count_res.comm_group_count) | 0,
          userCreatedGroups: Number(db_count_res.group_count) | 0,
          totalInnerGroups: Number(db_count_res.comm_group_count) | 0,
          totalDirectChats: Number(db_count_res.dm_count) | 0,
          totalMembers: Number(db_count_res.users_count) | 0,
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
      const search = (query.search as string) || '';

      const result = await get_all_conversations_admin("dm");

      if (result.success && result.data) {
        let filteredData = result.data;

        // Apply search filter if search query exists
        if (search && search.trim() !== '') {
          const searchLower = search.toLowerCase().trim();
          filteredData = result.data.filter((chat: any) => {
            // Search by participant names
            const participant1Name = chat.participant1?.userName?.toLowerCase() || '';
            const participant2Name = chat.participant2?.userName?.toLowerCase() || '';

            // Search by participant emails (which might contain phone)
            const participant1Email = chat.participant1?.userEmail?.toLowerCase() || '';
            const participant2Email = chat.participant2?.userEmail?.toLowerCase() || '';

            // Search by participant IDs
            const participant1Id = chat.participant1?.userId?.toString() || '';
            const participant2Id = chat.participant2?.userId?.toString() || '';

            return participant1Name.includes(searchLower) ||
              participant2Name.includes(searchLower) ||
              participant1Email.includes(searchLower) ||
              participant2Email.includes(searchLower) ||
              participant1Id.includes(searchLower) ||
              participant2Id.includes(searchLower);
          });
        }

        // Apply pagination
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedData = filteredData.slice(startIndex, endIndex);

        set.status = 200;
        return {
          success: true,
          code: 200,
          data: {
            chats: paginatedData,
            pagination: {
              currentPage: page,
              totalPages: Math.ceil(filteredData.length / limit),
              totalCount: filteredData.length,
              limit,
              hasNextPage: page < Math.ceil(filteredData.length / limit),
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
  })

  .delete("/chat-management/soft-delete-dm/:conversation_id", async ({ set, store, params }) => {
    try {
      const conversationId = params.conversation_id;

      // Verify conversation exists and is a DM
      const [conversation] = await db
        .select({
          id: conversation_model.id,
          type: conversation_model.type,
        })
        .from(conversation_model)
        .where(eq(conversation_model.id, conversationId));

      if (!conversation) {
        set.status = 404;
        return {
          success: false,
          code: 404,
          message: "Conversation not found",
          data: null,
        };
      }

      if (conversation.type !== "dm") {
        set.status = 400;
        return {
          success: false,
          code: 400,
          message: "Only DM conversations can be soft deleted",
          data: null,
        };
      }

      // Soft delete the conversation
      const result = await db
        .update(conversation_model)
        .set({ deleted: true })
        .where(eq(conversation_model.id, conversationId))
        .returning();

      if (result.length === 0) {
        set.status = 500;
        return {
          success: false,
          code: 500,
          message: "Failed to delete conversation",
          data: null,
        };
      }

      set.status = 200;
      return {
        success: true,
        code: 200,
        message: "DM conversation marked as deleted",
        data: result[0],
      };
    } catch (error) {
      console.error("Soft delete DM error:", error);
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
  });

export default admin_routes;
