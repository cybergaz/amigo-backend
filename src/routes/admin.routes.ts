import { app_middleware } from "@/middleware";
import { request_auth } from "@/middleware/request-auth";
import Elysia, { t } from "elysia";
import { get_all_users_paginated, update_user_role, update_user_call_access, get_dashboard_stats, create_admin_user, get_all_admins, update_admin_permissions, update_admin_status, get_user_permissions, delete_user_permanently, update_user_details, admin_update_user_phone_number, admin_create_user, admin_set_user_password_pin, admin_set_user_admin_pin } from "@/services/user.services";
import { get_pin_reset_requests, resolve_pin_reset_request } from "@/services/pin-reset.service";
import { get_communities, get_community_groups } from "@/services/community.services";
import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { chat_model } from "@/models/chat.model";
import { REQUEST_STATUS_CONST } from "@/types/user.types";
import { eq, sql } from "drizzle-orm";
import { community_model } from "@/models/community.model";
import { update_signup_request_status, get_all_signup_requests } from "@/services/auth.service";
import { force_declare_group_creater, get_all_conversations_admin, get_conversation_history_admin, get_conversation_members_admin, hard_delete_chat } from "@/services/chat-admin.service";
import { add_new_member, remove_member, bulk_add_members_to_groups, bulk_remove_members_from_groups } from "@/services/chat-group.service";
import { hard_delete_message, revive_chat } from "@/services/chat.services";
import { get_marquee_banner, set_marquee_banner } from "@/services/app-settings.service";
import { get_admin_pin_events, delete_admin_pin_event } from "@/services/admin-pin-event.service";
import { publish_global_broadcast } from "@/sockets/ws-broadcast";
import { cluster_stats } from "@/cluster/stats";
import { sync_health } from "@/services/sync/sync-health";
import { net_health } from "@/services/net-beacon.service";
import { read_fcm_health } from "@/services/fcm-health";
import { ack_fallback_stats } from "@/services/fcm-ack-fallback";
import { snapshot_counters } from "@/utils/counters";
import { chunked_upload_stats } from "@/services/chunked-upload.service";

const admin_routes = new Elysia({ prefix: "/admin" })
  // Protects all routes below. Per-request identity (middleware/request-auth.ts),
  // never the app-wide store. The first admin is created by `bun db:admin:seed`.
  .resolve(({ cookie, set, headers }) =>
    request_auth(set, app_middleware({ cookie, headers, allowed: ["admin", "sub_admin"] })))

  // Admin Management Routes
  .get("/admins", async ({ set, auth }) => {
    try {
      // Only super admin can view all admins
      if (auth.role !== "admin") {
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

  .post("/create-admin", async ({ body, set, auth }) => {
    try {
      // Only super admin can create sub-admins
      if (auth.role !== "admin") {
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

  .put("/update-admin-permissions", async ({ body, set, auth }) => {
    try {
      // Only super admin can update permissions
      if (auth.role !== "admin") {
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

  .put("/update-admin-status", async ({ body, set, auth }) => {
    try {
      // Only super admin can update admin status
      if (auth.role !== "admin") {
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
      if (id === auth.id) {
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

  .get("/user-permissions", async ({ set, auth }) => {
    try {
      const result = await get_user_permissions(auth.id);

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

  .get("/fetch-all-users", async ({ query, set, auth }) => {
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

  .get("/dashboard-stats", async ({ set, auth }) => {
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

  // Per-worker WS / poll counts, event-loop lag, rev and uptime from the
  // worker beats (SYNC_V2 §13.15 "Admin dashboard", RC-2). Admin-guarded.
  .get("/cluster/workers", async ({ set }) => {
    try {
      const data = await cluster_stats();
      set.status = 200;
      return { success: true, code: 200, message: "Cluster workers", data };
    } catch (error) {
      set.status = 500;
      return { success: false, code: 500, message: "Internal server error", data: null };
    }
  })

  // Sync v2 health for THIS worker (SYNC_V2 §10): flags + markers, the
  // [SEQ]/[RCPT]/[UNREAD-SHADOW] counters of the current window, unnumbered
  // chats, mins-runner backlog. Admin-guarded.
  .get("/sync-health", async ({ set }) => {
    try {
      const data = await sync_health();
      set.status = 200;
      return { success: true, code: 200, message: "Sync v2 health", data };
    } catch (error) {
      set.status = 500;
      return { success: false, code: 500, message: "Internal server error", data: null };
    }
  })

  // Network health (SYNC_V2 §14.14): beacon aggregates over the last `hours`
  // (default 24, max 336) by version / OEM / OS, RTT, carrier share, WS
  // failure kinds, reach time, FCM, background runs and media throughput;
  // the 7-day FCM health (§14.13, all users, plus `user_id` when given);
  // this worker's [FCM]/[NET] counters and ack-fallback state; chunked
  // uploads (§14.11): switch, open uploads, this worker's permits and its
  // [UPLOAD] counters (init / chunk / chunk_409 / part_assembled / complete /
  // abort / gc_* and byte totals). Admin-guarded.
  .get("/net-health", async ({ set, query }) => {
    try {
      const hours = Number(query.hours ?? 24);
      const user_id = typeof query.user_id === "string" && /^[0-9a-f-]{36}$/i.test(query.user_id) ? query.user_id : null;
      const [net, fcm_health, uploads] = await Promise.all([
        net_health(Number.isFinite(hours) ? hours : 24),
        read_fcm_health(user_id).catch(() => null),
        chunked_upload_stats().catch(() => null),
      ]);
      const counters = snapshot_counters();
      set.status = 200;
      return {
        success: true,
        code: 200,
        message: "Network health",
        data: {
          ...net,
          fcm_health,
          ack_fallback: ack_fallback_stats(),
          uploads,
          counters: { FCM: counters.FCM ?? {}, NET: counters.NET ?? {}, UPLOAD: counters.UPLOAD ?? {} },
        },
      };
    } catch (error) {
      console.error("[ADMIN] net-health failed:", error);
      set.status = 500;
      return { success: false, code: 500, message: "Internal server error", data: null };
    }
  })

  .put("/update-user-role", async ({ body, set, auth }) => {
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

  .put("/update-user-call-access", async ({ body, set, auth }) => {
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

  .delete("/delete-user/:id", async ({ params, set, auth }) => {
    try {
      // Only super admin can permanently delete users
      if (auth.role !== "admin") {
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
      if (userId === auth.id) {
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
  .get("/chat-management/stats", async ({ set, auth }) => {
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

  .get("/chat-management/groups", async ({ set, auth, query }) => {
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

  .get("/chat-management/direct-chats", async ({ set, auth, query }) => {
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

  .get("/chat-management/group-details/:conversation_id", async ({ set, auth, params }) => {
    const result = await get_conversation_members_admin(params.conversation_id);
    set.status = result.code;
    return result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  .post("/chat-management/add-member", async ({ set, auth, body }) => {
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

  .delete("/chat-management/remove-member", async ({ set, auth, body }) => {
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
  .post("/chat-management/bulk-add-members-to-groups", async ({ set, auth, body }) => {
    try {
      const result = await bulk_add_members_to_groups(
        body.conversation_ids,
        body.user_ids,
        auth.id,
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
  .delete("/chat-management/bulk-remove-members-from-groups", async ({ set, auth, body }) => {
    try {
      const result = await bulk_remove_members_from_groups(
        body.conversation_ids,
        body.user_ids,
        auth.id,
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

  .get("/chat-management/conversation-history/:conversation_id", async ({ set, auth, params, query }) => {
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

  .get("/chat-management/communities", async ({ set, auth }) => {
    try {
      const result = await get_communities(auth.id);

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

  .get("/chat-management/community-groups/:community_id", async ({ set, auth, params }) => {
    try {
      const result = await get_community_groups(params.community_id, auth.id);

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

  .delete("/chat-management/permanently-delete-message/:message_id", async ({ set, auth, params }) => {
    try {
      // Only super admin can permanently delete messages
      if (auth.role !== "admin") {
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

  .delete("/chat-management/hard-delete-chat/:conversation_id", async ({ set, auth, params }) => {
    const delete_result = await hard_delete_chat(params.conversation_id, auth.id);
    set.status = delete_result.code;
    return delete_result;
  }, {
    params: t.Object({
      conversation_id: t.String()
    })
  })

  .post("/chat-management/revive-chat/:conversation_id", async ({ set, auth, params }) => {
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
      name: t.Optional(t.String()),
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
  })

  // Marquee banner shown on the app's group-list screen. Super-admin only:
  // sub-admins must not be able to author the global banner.
  .get("/marquee-banner", async ({ set, auth }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return {
        success: false,
        code: 403,
        message: "Only super admin can manage the marquee banner",
        data: null,
      };
    }
    const data = await get_marquee_banner();
    set.status = 200;
    return { success: true, code: 200, message: "OK", data };
  })

  .put("/marquee-banner", async ({ set, auth, body }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return {
        success: false,
        code: 403,
        message: "Only super admin can manage the marquee banner",
        data: null,
      };
    }
    const data = await set_marquee_banner(
      { text: body.text, enabled: body.enabled },
      auth.id,
    );
    // Push the change live to every connected client (across all instances).
    // Fire-and-forget — the DB write is the source of truth; clients also
    // re-fetch on launch, so a failed broadcast just delays the live update.
    publish_global_broadcast({
      type: "marquee:update",
      payload: data,
      ws_timestamp: new Date(),
    }).catch((err) => console.error("[MARQUEE] broadcast failed:", err));
    set.status = 200;
    return { success: true, code: 200, message: "Marquee banner updated", data };
  }, {
    body: t.Object({
      text: t.String(),
      enabled: t.Boolean(),
    })
  })

  // Admin PIN Usage (camouflage / duress) history — super admin only.
  .get("/admin-pin-events", async ({ set, auth, query }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return { success: false, code: 403, message: "Only super admin can view Admin PIN usage", data: null };
    }
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const result = await get_admin_pin_events(page, limit);
    set.status = result.code;
    return result;
  })

  // Resolve (delete) an Admin PIN usage entry — super admin only.
  .delete("/admin-pin-events/:id", async ({ set, auth, params }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return { success: false, code: 403, message: "Only super admin can resolve Admin PIN usage", data: null };
    }
    const result = await delete_admin_pin_event(params.id);
    set.status = result.code;
    return result;
  })

  // ── User provisioning + PIN management (super-admin only) ───────────────────
  // Create a brand-new app user with a phone + starter password PIN. The user is
  // flagged must_reset_pin so first login forces them to set their own PIN.
  .post("/create-user", async ({ set, auth, body }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return { success: false, code: 403, message: "Only super admin can create users", data: null };
    }
    const result = await admin_create_user({
      name: body.name,
      phone: body.phone,
      password_pin: body.password_pin,
    });
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      name: t.String(),
      phone: t.String(),
      password_pin: t.String({ pattern: "^\\d{4}$" }),
    }),
  })

  // Set/overwrite a user's login (password) PIN — fulfils a forgot-PIN request and
  // re-flags must_reset_pin. Auto-accepts the user's pending reset request.
  .post("/user/set-password-pin", async ({ set, auth, body }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return { success: false, code: 403, message: "Only super admin can change a user's PIN", data: null };
    }
    const result = await admin_set_user_password_pin(body.user_id, body.pin, auth.id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      user_id: t.String(),
      pin: t.String({ pattern: "^\\d{4}$" }),
    }),
  })

  // Set/override a user's ADMIN PIN (app-lock camouflage PIN). No login-reset side
  // effects — just sets it (must differ from the login PIN).
  .post("/user/set-admin-pin", async ({ set, auth, body }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return { success: false, code: 403, message: "Only super admin can change a user's admin PIN", data: null };
    }
    const result = await admin_set_user_admin_pin(body.user_id, body.pin);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      user_id: t.String(),
      pin: t.String({ pattern: "^\\d{4}$" }),
    }),
  })

  // List user-raised PIN reset requests (pending first).
  .get("/pin-reset-requests", async ({ set, auth, query }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return { success: false, code: 403, message: "Only super admin can view reset-PIN requests", data: null };
    }
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const status = (query.status as string) || undefined;
    const search = (query.search as string) || undefined;
    const result = await get_pin_reset_requests(page, limit, status, search);
    set.status = result.code;
    return result;
  })

  // Dismiss/reject a reset request without changing the PIN (fulfilment happens via
  // /user/set-password-pin, which auto-accepts the pending request).
  .post("/pin-reset-requests/:id/resolve", async ({ set, auth, params, body }) => {
    if (auth.role !== "admin") {
      set.status = 403;
      return { success: false, code: 403, message: "Only super admin can resolve reset-PIN requests", data: null };
    }
    const status = body?.status === "accepted" ? "accepted" : "rejected";
    const result = await resolve_pin_reset_request(params.id, status, auth.id);
    set.status = result.code;
    return result;
  }, {
    body: t.Object({
      status: t.Optional(t.String()),
    }),
  });


export default admin_routes;
