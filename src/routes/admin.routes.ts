import { app_middleware } from "@/middleware";
import Elysia, { t } from "elysia";
import { get_all_users_paginated, update_user_role, update_user_call_access, get_dashboard_stats, create_admin_user, get_all_admins, update_admin_permissions, update_admin_status, get_user_permissions, delete_user_permanently, update_user_details, admin_update_user_phone_number } from "@/services/user.services";
import { get_communities, get_community_groups } from "@/services/community.services";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { chat_model } from "@/models/chat.model";
import { REQUEST_STATUS_CONST, RoleType } from "@/types/user.types";
import { eq, sql } from "drizzle-orm";
import { community_model } from "@/models/community.model";
import { update_signup_request_status, get_all_signup_requests } from "@/services/auth.service";
import { force_declare_group_creater, get_all_conversations_admin, get_conversation_history_admin, get_conversation_members_admin, hard_delete_chat } from "@/services/chat-admin.service";
import { add_new_member, remove_member, bulk_add_members_to_groups, bulk_remove_members_from_groups } from "@/services/chat-group.service";
import { hard_delete_message, revive_chat } from "@/services/chat.services";

const admin_routes = new Elysia({ prefix: "/admin" })
  // unauthorized route to create a super admin if none exists
  .get("/seed-admin-for-admin-panel", async ({ set }) => {
    const newAdmin = await db
      .insert(user_model)
      .values({
        name: "Super Admin",
        email: "admin@gmail.com",
        role: "admin" as RoleType,
        hashed_password: "$2b$10$F0.mx/.RuN.J3NDSxzvUBOyiFYdiktAPuMCJWUs.08uOmOmNGdXpG",
      });

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
  .state({ id: "", role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers, allowed: ["admin", "sub_admin"] });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

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
        permissions: string[];
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

      const { id, permissions } = body as { id: string; permissions: string[]; };

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
      id: t.String(),
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

      const { id, active } = body as { id: string; active: boolean; };

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
      id: t.String(),
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
      const role = query.role as string || 'all';

      const result = await get_all_users_paginated(page, limit, search, role);

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
      const { id, role } = body as { id: string; role: string; };

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
      const { id, call_access } = body as { id: string; call_access: boolean; };

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
      id: t.String()
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
              (SELECT COUNT(*) FROM ${chat_model} WHERE type = 'group')::int AS group_count,
              (SELECT COUNT(*) FROM ${chat_model} WHERE type = 'dm')::int AS dm_count,
              (SELECT COUNT(*) FROM ${chat_model} WHERE type = 'community_group')::int AS comm_group_count,
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
      const page = Number(query.page) || 1;
      const limit = Number(query.limit) || 20;
      const search = (query.search as string) || '';
      const showDeleted = query.showDeleted === 'true';

      const result = await get_all_conversations_admin(type);

      if (result.success && result.data) {
        let filteredData = result.data;

        // Filter by deleted status
        if (showDeleted) {
          // Show ONLY deleted groups
          filteredData = filteredData.filter((group: any) => group.deleted_at != null);
        } else {
          // Show ONLY non-deleted groups
          filteredData = filteredData.filter((group: any) => group.deleted_at == null);
        }

        // Apply search filter if search query exists
        if (search && search.trim() !== '') {
          const searchLower = search.toLowerCase().trim();
          filteredData = filteredData.filter((group: any) => {
            // Search by group title
            const title = group.title?.toLowerCase() || '';

            // Search by conversation ID
            const conversationId = group.conversationId?.toString() || '';

            // Search by creator name
            const creatorName = group.createrName?.toLowerCase() || '';

            return title.includes(searchLower) ||
              conversationId.includes(searchLower) ||
              creatorName.includes(searchLower);
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
            groups: paginatedData,
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
    const result = await get_conversation_members_admin(params.conversation_id);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({
      conversation_id: t.String()
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
      conversation_id: t.String(),
      user_ids: t.Array(t.String()),
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
      conversation_id: t.String(),
      user_id: t.String()
    })
  })

  // Bulk-add the same set of users to every group in `conversation_ids` in
  // one request. Powers the sub-admin "manage groups" flow on mobile where
  // the actor first picks users, then picks target groups. Per-group
  // already-active users are silently skipped (handled by `add_new_member`).
  .post("/chat-management/bulk-add-members-to-groups", async ({ set, store, body }) => {
    try {
      const result = await bulk_add_members_to_groups(
        body.conversation_ids,
        body.user_ids,
        store.id,
        body.role || "member",
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
      conversation_ids: t.Array(t.String()),
      user_ids: t.Array(t.String()),
      role: t.Optional(t.Union([t.Literal("admin"), t.Literal("member")])),
    })
  })

  // Bulk-remove the cross-product of (conversation_ids × user_ids) — users
  // who aren't currently active members of a given group are silently
  // skipped (one batched UPDATE, no per-pair queries). One
  // `conversation:action` (member_removed) broadcast fans out per affected
  // group so member lists update live for everyone in the chat.
  .delete("/chat-management/bulk-remove-members-from-groups", async ({ set, store, body }) => {
    try {
      const result = await bulk_remove_members_from_groups(
        body.conversation_ids,
        body.user_ids,
        store.id,
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
      conversation_ids: t.Array(t.String()),
      user_ids: t.Array(t.String()),
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
      conversation_id: t.String()
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
      community_id: t.String()
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

      const result = await hard_delete_message(params.message_id);

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
      message_id: t.String()
    })
  })

  .delete("/chat-management/hard-delete-chat/:conversation_id", async ({ set, store, params }) => {
    const delete_result = await hard_delete_chat(params.conversation_id, store.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  .post("/chat-management/revive-chat/:conversation_id", async ({ set, store, params }) => {
    const revive_result = await revive_chat(params.conversation_id);
    set.status = revive_result.code;
    return revive_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  .post("/chat-management/force-declare-group-creater", async ({ set, body }) => {
    const declare_creater_result = await force_declare_group_creater(body.conversation_id, body.member_id);
    set.status = declare_creater_result.code;
    return declare_creater_result;

  }, {
    body: t.Object({
      conversation_id: t.String(),
      member_id: t.String()
    })
  })

  .get("/auth-management/signup-requests", async ({ set }) => {
    const signup_requests_result = await get_all_signup_requests();
    set.status = signup_requests_result.code;
    return signup_requests_result;
  })

  .post("/auth-management/approve-signup-request", async ({ set, body }) => {
    const approve_signup_request_result = await update_signup_request_status(body);
    set.status = approve_signup_request_result.code;
    return approve_signup_request_result;
  }, {
    body: t.Object({
      phone: t.String(),
      first_name: t.String(),
      last_name: t.String(),
      status: t.Optional(t.Enum(Object.fromEntries(REQUEST_STATUS_CONST.map(x => [x, x])))),
      rejected_reason: t.Optional(t.String()),
    })
  })

  .post("/user/update-phone-number", async ({ set, body }) => {
    const change_phone_result = await admin_update_user_phone_number(body.user_id, body.phone);
    set.status = change_phone_result.code;
    return change_phone_result;

  }, {
    body: t.Object({
      phone: t.String(),
      user_id: t.String(),
    })
  });


export default admin_routes;
