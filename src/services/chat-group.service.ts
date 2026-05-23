import db from "@/config/db";
import {
  chat_model,
  chat_member_model,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  ChatRoleType,
  ChatType,
} from "@/types/chat.types";
import { and, asc, eq, inArray, isNull, or, } from "drizzle-orm";
import { broadcast_message } from "@/sockets/socket.handlers";
import { NewConversationPayload, MembersType } from "@/types/socket.types";
import { get_user_details } from "./user.services";
import { broadcast_conversation_action } from "./chat.services";
import { add_members, remove_member as cache_remove_member } from "@/cache-management/conv.cache";
import {
  upload_image_to_s3,
  delete_image_from_s3,
  generate_profile_image_key,
} from "@/services/s3.service";

// Returns true if the user is an active admin of the chat. Used to gate
// admin-only mutations (title / pfp updates).
const is_chat_admin = async (chat_id: string, user_id: string) => {
  const [row] = await db
    .select({ role: chat_member_model.role })
    .from(chat_member_model)
    .where(
      and(
        eq(chat_member_model.chat_id, chat_id),
        eq(chat_member_model.user_id, user_id),
        isNull(chat_member_model.removed_at),
      )
    )
    .limit(1);
  return row?.role === "admin";
};

const create_group = async (
  creater_id: string,
  title: string,
  member_ids?: string[]
) => {

  try {
    const [chat] = await db
      .insert(chat_model)
      .values({
        creater_id,
        type: "group",
        title,
      })
      .returning();

    // Ensure creator is always in the group
    const uniqueMemberIds = Array.from(new Set([creater_id, ...member_ids || []]));

    await db.insert(chat_member_model).values(
      uniqueMemberIds.map((uid) => ({
        chat_id: chat.id,
        user_id: uid,
        role: (uid === creater_id ? "admin" : "member") as ChatRoleType,
      }))
    );

    // Send notification to all members about the new group
    try {

      const [creater] = await db
        .select({
          name: user_model.name,
          phone: user_model.phone,
          profile_pic: user_model.profile_pic
        })
        .from(user_model)
        .where(eq(user_model.id, creater_id));

      const members_res = await get_group_members(chat.id);
      const members = members_res.success ? members_res.data : [];

      const new_conversation_payload: NewConversationPayload = {
        conv_id: chat.id,
        conv_type: "group",
        creater_id: creater_id,
        title: title,
        creater_name: creater.name,
        creater_phone: creater.phone || "",
        creater_pfp: creater.profile_pic || undefined,
        members: members,
        joined_at: new Date(),
      };

      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: member_ids,
        message: {
          type: "conversation:new",
          payload: new_conversation_payload,
          ws_timestamp: new Date()
        },
      });

      // hydrate member set + invalidate LRU across instances
      await add_members(uniqueMemberIds, chat.id);

    } catch (error) {
      console.error('Error sending conversation_added notification for group:', error);
    }

    return {
      success: true,
      code: 200,
      message: "Group created successfully",
      data: chat,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : create_group",
    };
  }
};

const get_group_info = async (conversation_id: string) => {
  try {
    const [group] = await db
      .select({
        conversation_id: chat_model.id,
        type: chat_model.type,
        title: chat_model.title,
        profile_pic: chat_model.profile_pic,
        lastMessageAt: chat_model.last_msg_at,

        createrId: user_model.id,
        createrName: user_model.name,
        createrProfilePic: user_model.profile_pic,
      })
      .from(chat_model)
      .leftJoin(
        user_model,
        eq(user_model.id, chat_model.creater_id)
      )
      .where(
        and(
          eq(chat_model.id, conversation_id),
          or(
            eq(chat_model.type, "group"),
            eq(chat_model.type, "community_group")
          )
        )
      )
      .limit(1);

    if (!group) {
      return {
        success: false,
        code: 404,
        message: "Group not found",
      };
    }

    const members = await db
      .select({
        userId: user_model.id,
        userName: user_model.name,
        userProfilePic: user_model.profile_pic,
        role: chat_member_model.role,
        joinedAt: chat_member_model.joined_at,
      })
      .from(chat_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, chat_member_model.user_id)
      )
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .orderBy(asc(chat_member_model.joined_at));

    return {
      success: true,
      code: 200,
      data: {
        group: group,
        members,
      },
    };
  } catch (error) {
    console.error("get_group_info error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_group_info",
    };
  }
};

const get_group_admin_info = async (conv_id: string) => {
  try {

    const [conversation] = await db
      .select({ creater_id: chat_model.creater_id })
      .from(chat_model)
      .where(eq(chat_model.id, conv_id))
      .limit(1);


    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    if (!conversation.creater_id) {
      return {
        success: false,
        code: 404,
        message: "Group has no creator",
      };
    }

    const admin = await get_user_details(conversation.creater_id);

    if (!admin.success) {
      return {
        success: false,
        code: 404,
        message: "Admin info not found",
      };
    }

    return {
      success: true,
      code: 200,
      data: admin.data,
    };

  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : get_group_admin_info",
    };
  }
};

const get_group_members = async (conversation_id: string) => {
  try {
    const members = await db
      .select({
        user_id: user_model.id,
        user_name: user_model.name,
        user_pfp: user_model.profile_pic,
        role: chat_member_model.role,
        joined_at: chat_member_model.joined_at,
      })
      .from(chat_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, chat_member_model.user_id)
      )
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          isNull(chat_member_model.removed_at)
        )
      );

    return {
      success: true,
      code: 200,
      data: members as MembersType[],
    };
  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : get_group_members",
    };
  }
};

const add_new_member = async (
  conversation_id: string,
  user_ids: string[],
  role: ChatRoleType = "member",
  actor_id?: string,
) => {
  try {
    // 1. Filter valid users
    const validUsers = await db
      .select({ id: user_model.id })
      .from(user_model)
      .where(inArray(user_model.id, user_ids));

    const validUserIds = validUsers.map((u) => u.id);
    const invalidUserIds = user_ids.filter((id) => !validUserIds.includes(id));

    if (validUserIds.length === 0) {
      return {
        success: false,
        code: 400,
        message: "No valid users found",
        data: { inserted: [], existing: [], invalid: invalidUserIds },
      };
    }

    // 2. Look up existing rows, distinguishing ACTIVE (removed_at IS NULL)
    //    from previously-REMOVED (removed_at IS NOT NULL). Revived members
    //    need an UPDATE to clear removed_at and reset joined_at/role, not
    //    just a no-op skip.
    const existingRows = await db
      .select({
        user_id: chat_member_model.user_id,
        removed_at: chat_member_model.removed_at,
      })
      .from(chat_member_model)
      .where(
        and(
          inArray(chat_member_model.user_id, validUserIds),
          eq(chat_member_model.chat_id, conversation_id),
        )
      );

    const activeIds: string[] = existingRows
      .filter((r) => r.removed_at === null && r.user_id !== null)
      .map((r) => r.user_id as string);
    const removedIds: string[] = existingRows
      .filter((r) => r.removed_at !== null && r.user_id !== null)
      .map((r) => r.user_id as string);
    const brandNewIds: string[] = validUserIds.filter(
      (id) => !activeIds.includes(id) && !removedIds.includes(id),
    );

    // 3. Eligible = brand-new inserts + revived updates (both make a user
    //    active again; both should be broadcast as "added").
    const eligibleIds = [...brandNewIds, ...removedIds];

    // 4. Insert brand-new rows
    let inserted: typeof chat_member_model.$inferSelect[] = [];
    if (brandNewIds.length > 0) {
      inserted = await db
        .insert(chat_member_model)
        .values(
          brandNewIds.map((id) => ({
            chat_id: conversation_id,
            user_id: id,
            role,
          }))
        )
        .returning();
    }

    // 4b. Revive removed rows: clear removed_at, reset joined_at & role,
    //     clear any stale cursor fields so the user starts fresh.
    if (removedIds.length > 0) {
      const revived = await db
        .update(chat_member_model)
        .set({
          removed_at: null,
          joined_at: new Date(),
          role,
          last_read_msg_id: null,
          last_delivered_msg_id: null,
        })
        .where(
          and(
            eq(chat_member_model.chat_id, conversation_id),
            inArray(chat_member_model.user_id, removedIds),
          )
        )
        .returning();
      inserted = [...inserted, ...revived];
    }

    const [conv_details] = await db
      .select()
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id))
      .limit(1);

    if (!conv_details) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    const actor_details = actor_id ? await get_user_details(actor_id) : null;

    const creater_info = conv_details.creater_id ? await get_user_details(conv_details.creater_id) : { success: false, data: null };
    const members_res = await get_group_members(conversation_id);
    const members = members_res.success ? members_res.data : [];

    if (!creater_info.success || !creater_info.data) {
      throw new Error("Admin info not found");
    }

    const new_conversation_payload: NewConversationPayload = {
      conv_id: conversation_id,
      conv_type: "group",
      creater_id: creater_info.data.id,
      title: conv_details.title || "",
      creater_name: creater_info.data.name,
      creater_phone: creater_info.data.phone || "",
      creater_pfp: creater_info.data.profile_pic || undefined,
      members: members,
      joined_at: new Date(),
    };
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: user_ids,
      message: {
        type: "conversation:new",
        payload: new_conversation_payload,
        ws_timestamp: new Date()
      },
    });
    if (eligibleIds.length > 0) {
      const users_meta = await db
        .select({
          id: user_model.id,
          name: user_model.name,
          profile_pic: user_model.profile_pic,
        })
        .from(user_model)
        .where(inArray(user_model.id, eligibleIds));

      const members_for_action: MembersType[] = eligibleIds.map((id) => {
        const meta = users_meta.find((m) => m.id === id);
        const memberRow = inserted.find((row) => row.user_id === id);
        const joinedAt = memberRow?.joined_at
          ? new Date(memberRow.joined_at)
          : new Date();

        return {
          user_id: id,
          user_name: meta?.name || "Member",
          user_pfp: meta?.profile_pic || undefined,
          role: (memberRow?.role as ChatRoleType) || role,
          joined_at: joinedAt,
        };
      });

      await broadcast_conversation_action({
        conv_id: conversation_id,
        conv_type: (conv_details.type as ChatType) || "group",
        action: "member_added",
        members: members_for_action,
        actor_id,
        actor_name: actor_details?.data?.name,
        actor_pfp: actor_details?.data?.profile_pic || undefined,
      });
    }

    // hydrate new members + invalidate LRU across instances
    if (eligibleIds.length > 0) {
      await add_members(eligibleIds, conversation_id);
    }

    return {
      success: true,
      code: 200,
      message: "Processed members",
      data: {
        inserted,
        existing: activeIds,
        revived: removedIds,
        invalid: invalidUserIds,
      },
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : add_new_member",
    };
  }
};

const remove_member = async (
  conversation_id: string,
  user_id: string,
  actor_id?: string,
) => {
  try {
    const [conversation] = await db
      .select({ type: chat_model.type })
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id))
      .limit(1);

    const member_info = await db
      .select({
        user_id: chat_member_model.user_id,
        role: chat_member_model.role,
        joined_at: chat_member_model.joined_at,
        user_name: user_model.name,
        user_pfp: user_model.profile_pic,
      })
      .from(chat_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, chat_member_model.user_id)
      )
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at)
        )
      );

    const actor_details = actor_id ? await get_user_details(actor_id) : null;

    const result = await db
      .update(chat_member_model)
      .set({ removed_at: new Date() })
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Member not found in the conversation",
        data: { conversation_id, user_id, removed: false },
      };
    }

    // drop from member set + invalidate LRU across instances
    await cache_remove_member(user_id, conversation_id);

    if (member_info.length) {
      const members_for_action: MembersType[] = member_info.filter(m => m.user_id !== null).map((m) => ({
        user_id: m.user_id!,
        user_name: m.user_name || "Member",
        user_pfp: m.user_pfp || undefined,
        role: m.role as ChatRoleType,
        joined_at: m.joined_at ? new Date(m.joined_at) : new Date(),
      }));

      await broadcast_conversation_action({
        conv_id: conversation_id,
        conv_type: (conversation?.type as ChatType) || "group",
        action: "member_removed",
        members: members_for_action,
        actor_id,
        actor_name: actor_details?.data?.name,
        actor_pfp: actor_details?.data?.profile_pic || undefined,
      });
    }

    return {
      success: true,
      code: 200,
      message: "Member removed successfully",
      data: result[0]
    };

  } catch (error) {
    console.error("remove member error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : remove_member",
    };
  }
};

const promote_to_admin = async (
  conversation_id: string,
  user_id: string,
  actor_id?: string,
) => {
  try {
    const [conversation] = await db
      .select({ type: chat_model.type })
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id))
      .limit(1);

    const actor_details = actor_id ? await get_user_details(actor_id) : null;
    const target_user_details = await get_user_details(user_id);

    const [member] = await db
      .update(chat_member_model)
      .set({ role: "admin" })
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .returning();

    if (!member) {
      return {
        success: false,
        code: 404,
        message: "Member not found in the conversation",
      };
    }

    const members_for_action: MembersType[] = [
      {
        user_id: user_id,
        user_name: target_user_details.data?.name || "Member",
        user_pfp: target_user_details.data?.profile_pic || undefined,
        role: "admin",
        joined_at: member.joined_at ? new Date(member.joined_at) : new Date(),
      },
    ];

    await broadcast_conversation_action({
      conv_id: conversation_id,
      conv_type: (conversation?.type as ChatType) || "group",
      action: "member_promoted",
      members: members_for_action,
      actor_id,
      actor_name: actor_details?.data?.name,
      actor_pfp: actor_details?.data?.profile_pic || undefined,
    });

    return {
      success: true,
      code: 200,
      message: "Member promoted to admin successfully",
      data: member,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : promote_to_admin",
    };
  }
};

const demote_to_member = async (
  conversation_id: string,
  user_id: string,
  actor_id?: string,
) => {
  try {
    const [conversation] = await db
      .select({ type: chat_model.type })
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id))
      .limit(1);

    const actor_details = actor_id ? await get_user_details(actor_id) : null;
    const target_user_details = await get_user_details(user_id);

    const [member] = await db
      .update(chat_member_model)
      .set({ role: "member" })
      .where(
        and(
          eq(chat_member_model.chat_id, conversation_id),
          eq(chat_member_model.user_id, user_id),
          isNull(chat_member_model.removed_at)
        )
      )
      .returning();

    if (!member) {
      return {
        success: false,
        code: 404,
        message: "Member not found in the conversation",
      };
    }

    const members_for_action: MembersType[] = [
      {
        user_id: user_id,
        user_name: target_user_details.data?.name || "Member",
        user_pfp: target_user_details.data?.profile_pic || undefined,
        role: "member",
        joined_at: member.joined_at ? new Date(member.joined_at) : new Date(),
      },
    ];

    await broadcast_conversation_action({
      conv_id: conversation_id,
      conv_type: (conversation?.type as ChatType) || "group",
      action: "member_demoted",
      members: members_for_action,
      actor_id,
      actor_name: actor_details?.data?.name,
      actor_pfp: actor_details?.data?.profile_pic || undefined,
    });

    return {
      success: true,
      code: 200,
      message: "Member demoted to member successfully",
      data: member,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : demote_to_member",
    };
  }
};

const update_group_title = async (
  conversation_id: string,
  title: string,
  actor_id: string,
) => {
  try {
    if (!(await is_chat_admin(conversation_id, actor_id))) {
      return {
        success: false,
        code: 403,
        message: "Only group admins can update the group title",
      };
    }

    const [chat] = await db
      .update(chat_model)
      .set({ title })
      .where(eq(chat_model.id, conversation_id))
      .returning();

    if (!chat) {
      return {
        success: false,
        code: 404,
        message: "Group not found",
      };
    }

    // Fan out to all members so creators *and* peers see the new title in
    // their local DB + UI. Routed through conversation:action so the event
    // is durably stored for any member offline at the moment.
    await broadcast_conversation_action({
      conv_id: conversation_id,
      conv_type: (chat.type as ChatType) || "group",
      action: "chat_details:update",
      members: [],
      actor_id,
      title,
    });

    return {
      success: true,
      code: 200,
      message: "Group title updated successfully",
      data: chat,
    };
  } catch (error) {
    console.error("update_group_title error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : update_group_title",
    };
  }
};

const update_group_profile_pic = async (
  conversation_id: string,
  actor_id: string,
  file: File,
) => {
  try {
    if (!(await is_chat_admin(conversation_id, actor_id))) {
      return {
        success: false,
        code: 403,
        message: "Only group admins can update the group profile picture",
      };
    }

    // File validation mirrors update_profile_image — keep client expectations
    // identical for both endpoints.
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      return {
        success: false,
        code: 400,
        message: "Invalid file type. Only JPEG, PNG, and WebP images are allowed.",
      };
    }
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return {
        success: false,
        code: 400,
        message: "File size too large. Maximum size is 5MB.",
      };
    }

    const [existing] = await db
      .select({
        id: chat_model.id,
        type: chat_model.type,
        profile_pic: chat_model.profile_pic,
      })
      .from(chat_model)
      .where(eq(chat_model.id, conversation_id))
      .limit(1);

    if (!existing) {
      return { success: false, code: 404, message: "Group not found" };
    }

    // Keyed by chat id so old uploads land in a deterministic prefix and
    // multiple admins editing don't collide. Reuse the PROFILE_IMAGES folder
    // — it's already public-readable and CDN-pathed identically.
    const imageKey = generate_profile_image_key(`group_${conversation_id}`, file.name);
    const upload = await upload_image_to_s3(file, imageKey);
    if (!upload.success || !upload.url) {
      return {
        success: false,
        code: 500,
        message: upload.error || "Failed to upload image",
      };
    }

    const previous_profile_pic = existing.profile_pic ?? null;

    await db
      .update(chat_model)
      .set({ profile_pic: upload.url })
      .where(eq(chat_model.id, conversation_id));

    // Best-effort old-image cleanup. The S3 key is everything after the
    // bucket host — extract by stripping the bucket URL prefix instead of
    // assuming "profile-images/x/y" structure.
    if (previous_profile_pic) {
      try {
        const url = new URL(previous_profile_pic);
        const oldKey = url.pathname.replace(/^\//, "");
        if (oldKey) await delete_image_from_s3(oldKey);
      } catch (err) {
        console.error("[CHAT_DETAILS] previous pfp cleanup failed:", err);
      }
    }

    await broadcast_conversation_action({
      conv_id: conversation_id,
      conv_type: (existing.type as ChatType) || "group",
      action: "chat_details:update",
      members: [],
      actor_id,
      profile_pic: upload.url,
      previous_profile_pic,
      profile_pic_changed: true,
    });

    return {
      success: true,
      code: 200,
      message: "Group profile picture updated successfully",
      data: { profile_pic: upload.url },
    };
  } catch (error) {
    console.error("update_group_profile_pic error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : update_group_profile_pic",
    };
  }
};

// ---------------------------------------------------------------------------
// Bulk multi-group operations powering the sub-admin "manage groups" flow
// on mobile. The actor picks users first, then a set of target groups; we
// apply add/remove across every (group, user) pair and broadcast one
// `conversation:action` event per group so existing client wiring updates
// member lists live.
// ---------------------------------------------------------------------------

// Apply the same set of `user_ids` to every group in `conversation_ids` as
// new members. Iterates `add_new_member` per group — that helper already
// batches inserts/revivals across the user_ids array and silently no-ops on
// users that are already active in the group, so we don't need to dedupe
// here. Per-group cost is one round-trip, so a sub-admin pushing 20 users
// into 5 groups is 5 round-trips (not 100).
const bulk_add_members_to_groups = async (
  conversation_ids: string[],
  user_ids: string[],
  actor_id?: string,
  role: ChatRoleType = "member",
) => {
  if (conversation_ids.length === 0 || user_ids.length === 0) {
    return {
      success: false,
      code: 400,
      message: "Missing conversation_ids or user_ids",
      data: null,
    };
  }

  const results: Array<{
    conversation_id: string;
    added: string[];
    existing: string[];
    revived: string[];
    invalid: string[];
    success: boolean;
    message?: string;
  }> = [];

  for (const conv_id of conversation_ids) {
    const r = await add_new_member(conv_id, user_ids, role, actor_id);
    const data = (r.data || {}) as {
      inserted?: Array<{ user_id?: string | null }>;
      existing?: string[];
      revived?: string[];
      invalid?: string[];
    };
    const inserted_ids = (data.inserted || [])
      .map((row) => row.user_id || "")
      .filter(Boolean);
    const revived_ids = data.revived || [];
    const added_ids = inserted_ids.filter((id) => !revived_ids.includes(id));

    results.push({
      conversation_id: conv_id,
      added: added_ids,
      existing: data.existing || [],
      revived: revived_ids,
      invalid: data.invalid || [],
      success: r.success,
      message: r.success ? undefined : r.message,
    });
  }

  return {
    success: results.some((r) => r.success),
    code: 200,
    message: "Bulk add processed",
    data: { results },
  };
};

// Mark every active (chat_id, user_id) row that matches the cross-product
// of inputs as removed in ONE batched UPDATE, then fan out the standard
// `conversation:action` (member_removed) event per affected group. Users
// who aren't in a given group simply don't match the WHERE clause — no
// error, no per-pair query.
const bulk_remove_members_from_groups = async (
  conversation_ids: string[],
  user_ids: string[],
  actor_id?: string,
) => {
  if (conversation_ids.length === 0 || user_ids.length === 0) {
    return {
      success: false,
      code: 400,
      message: "Missing conversation_ids or user_ids",
      data: null,
    };
  }

  try {
    // 1. One batched UPDATE returning every (chat_id, user_id, role, joined_at)
    //    that was actually active and got soft-deleted. Anything not in the
    //    group silently fails to match — desired behaviour per spec.
    const removed_rows = await db
      .update(chat_member_model)
      .set({ removed_at: new Date() })
      .where(
        and(
          inArray(chat_member_model.chat_id, conversation_ids),
          inArray(chat_member_model.user_id, user_ids),
          isNull(chat_member_model.removed_at),
        )
      )
      .returning({
        chat_id: chat_member_model.chat_id,
        user_id: chat_member_model.user_id,
        role: chat_member_model.role,
        joined_at: chat_member_model.joined_at,
      });

    if (removed_rows.length === 0) {
      return {
        success: true,
        code: 200,
        message: "No members were removed (none of the selected users were in any of the selected groups)",
        data: {
          results: conversation_ids.map((c) => ({
            conversation_id: c,
            removed: [] as string[],
          })),
          total_removed: 0,
        },
      };
    }

    // 2. Hydrate user name/pfp once for all distinct affected users so the
    //    per-group broadcast payloads don't re-query.
    const distinct_user_ids = Array.from(
      new Set(removed_rows.map((r) => r.user_id).filter(Boolean) as string[])
    );
    const users_meta = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        profile_pic: user_model.profile_pic,
      })
      .from(user_model)
      .where(inArray(user_model.id, distinct_user_ids));
    const user_meta_by_id = new Map(users_meta.map((u) => [u.id, u]));

    // 3. Group affected rows by chat for broadcast + cache invalidation.
    const by_chat = new Map<string, typeof removed_rows>();
    for (const row of removed_rows) {
      if (!row.chat_id) continue;
      const list = by_chat.get(row.chat_id) ?? [];
      list.push(row);
      by_chat.set(row.chat_id, list);
    }

    // 4. Look up each affected group's chat type (group / community_group)
    //    so the broadcast payload's conv_type is accurate, in one query.
    const affected_chat_ids = Array.from(by_chat.keys());
    const chats = await db
      .select({ id: chat_model.id, type: chat_model.type })
      .from(chat_model)
      .where(inArray(chat_model.id, affected_chat_ids));
    const type_by_chat = new Map(chats.map((c) => [c.id, c.type]));

    const actor = actor_id ? await get_user_details(actor_id) : null;

    // 5. Cache invalidation + WS broadcast in parallel, per group.
    await Promise.all(
      Array.from(by_chat.entries()).map(async ([chat_id, rows]) => {
        // Drop each removed user from the conversation member LRU set so
        // future broadcasts and presence lookups don't re-fan to them.
        await Promise.all(
          rows
            .filter((r) => r.user_id)
            .map((r) => cache_remove_member(r.user_id!, chat_id))
        );

        const members_for_action: MembersType[] = rows
          .filter((r) => r.user_id)
          .map((r) => {
            const meta = user_meta_by_id.get(r.user_id!);
            return {
              user_id: r.user_id!,
              user_name: meta?.name || "Member",
              user_pfp: meta?.profile_pic || undefined,
              role: r.role as ChatRoleType,
              joined_at: r.joined_at ? new Date(r.joined_at) : new Date(),
            };
          });

        await broadcast_conversation_action({
          conv_id: chat_id,
          conv_type: (type_by_chat.get(chat_id) as ChatType) || "group",
          action: "member_removed",
          members: members_for_action,
          actor_id,
          actor_name: actor?.data?.name,
          actor_pfp: actor?.data?.profile_pic || undefined,
        });
      })
    );

    const results = conversation_ids.map((conv_id) => ({
      conversation_id: conv_id,
      removed: (by_chat.get(conv_id) ?? [])
        .map((r) => r.user_id)
        .filter(Boolean) as string[],
    }));

    return {
      success: true,
      code: 200,
      message: "Bulk remove processed",
      data: { results, total_removed: removed_rows.length },
    };
  } catch (error) {
    console.error("bulk_remove_members_from_groups error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : bulk_remove_members_from_groups",
    };
  }
};

export {
  get_group_info,
  create_group,
  add_new_member,
  remove_member,
  promote_to_admin,
  demote_to_member,
  update_group_title,
  update_group_profile_pic,
  get_group_admin_info,
  is_chat_admin,
  bulk_add_members_to_groups,
  bulk_remove_members_from_groups,
};
