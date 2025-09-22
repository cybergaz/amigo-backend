import db from "@/config/db";
import { community_model } from "@/models/community.model";
import { conversation_model, conversation_member_model } from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  CreateCommunityRequest,
  UpdateCommunityRequest,
  CreateCommunityGroupRequest,
  UpdateCommunityGroupRequest,
  AddCommunityGroupRequest,
  RemoveCommunityGroupRequest,
  CommunityGroupMetadata
} from "@/types/community.types";
import { ChatRoleType } from "@/types/chat.types";
import { create_unique_id } from "@/utils/general.utils";
import { and, eq, inArray, sql, desc, arrayContains } from "drizzle-orm";

// Community CRUD operations
const create_community = async (
  super_admin_id: number,
  data: CreateCommunityRequest
) => {
  try {
    // Check if user is super admin or sub admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, super_admin_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only super admins and sub admins can create communities",
      };
    }

    const [community] = await db
      .insert(community_model)
      .values({
        id: create_unique_id(),
        name: data.name,
        metadata: data.metadata || {},
        updated_at: new Date(),
      })
      .returning();

    return {
      success: true,
      code: 201,
      message: "Community created successfully",
      data: community,
    };
  } catch (error) {
    console.error("create_community error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: create_community",
    };
  }
};

const get_communities = async (user_id: number) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can view communities",
      };
    }

    const communities = await db
      .select({
        id: community_model.id,
        name: community_model.name,
        group_ids: community_model.group_ids,
        metadata: community_model.metadata,
        created_at: community_model.created_at,
        updated_at: community_model.updated_at,
      })
      .from(community_model)
      .where(eq(community_model.deleted, false))
      .orderBy(desc(community_model.updated_at));

    return {
      success: true,
      code: 200,
      data: communities,
    };
  } catch (error) {
    console.error("get_communities error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: get_communities",
    };
  }
};

const get_connected_communities = async (user_id: number) => {
  try {

    // we have to get all communities where the user is a member of at least one group in the community
    // Get all community groups the user is a member of
    const userGroupIdsResult = await db
      .select({ conversation_id: conversation_member_model.conversation_id })
      .from(conversation_member_model)
      .where(eq(conversation_member_model.user_id, user_id));

    const userGroupIds = userGroupIdsResult.map(r => r.conversation_id);

    if (userGroupIds.length === 0) {
      return {
        success: true,
        code: 200,
        data: [],
      };
    }

    // Get all communities where group_ids overlap with userGroupIds
    // Using raw SQL for array overlap
    const communities = await db
      .select({
        id: community_model.id,
        name: community_model.name,
        group_ids: community_model.group_ids,
        metadata: community_model.metadata,
        created_at: community_model.created_at,
        updated_at: community_model.updated_at,
      })
      .from(community_model)
      .where(
        and(
          eq(community_model.deleted, false),
          arrayContains(community_model.group_ids, userGroupIds)
        )
      )
      .orderBy(desc(community_model.updated_at));


    return {
      success: true,
      code: 200,
      message: "Communities fetched successfully",
      data: communities,
    };

  } catch (error) {
    console.error("get_communities error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: get_communities",
    };
  }
};

const get_community_details = async (community_id: number, user_id: number) => {
  try {
    // Check if user is admin or sub_admin
    // const [user] = await db
    //   .select({ role: user_model.role })
    //   .from(user_model)
    //   .where(eq(user_model.id, user_id));
    //
    // if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "Only admins and sub admins can view community details",
    //   };
    // }

    // Get community details
    const [community] = await db
      .select()
      .from(community_model)
      .where(
        and(
          eq(community_model.id, community_id),
          eq(community_model.deleted, false)
        )
      );

    if (!community) {
      return {
        success: false,
        code: 404,
        message: "Community not found",
      };
    }

    // Get group count from group_ids array
    const group_count = community.group_ids ? community.group_ids.length : 0;

    return {
      success: true,
      code: 200,
      data: {
        ...community,
        group_count,
      },
    };
  } catch (error) {
    console.error("get_community_details error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: get_community_details",
    };
  }
};

const update_community = async (
  community_id: number,
  user_id: number,
  data: UpdateCommunityRequest
) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can update communities",
      };
    }

    const [updatedCommunity] = await db
      .update(community_model)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(community_model.id, community_id))
      .returning();

    return {
      success: true,
      code: 200,
      message: "Community updated successfully",
      data: updatedCommunity,
    };
  } catch (error) {
    console.error("update_community error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: update_community",
    };
  }
};

const delete_community = async (community_id: number, user_id: number) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can delete communities",
      };
    }

    // Soft delete community
    await db
      .update(community_model)
      .set({ deleted: true, updated_at: new Date() })
      .where(eq(community_model.id, community_id));

    return {
      success: true,
      code: 200,
      message: "Community deleted successfully",
    };
  } catch (error) {
    console.error("delete_community error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: delete_community",
    };
  }
};

// Community group management
const add_community_groups = async (
  community_id: number,
  admin_user_id: number,
  data: AddCommunityGroupRequest
) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, admin_user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can manage community groups",
      };
    }

    // Get current community
    const [community] = await db
      .select({ group_ids: community_model.group_ids })
      .from(community_model)
      .where(eq(community_model.id, community_id));

    if (!community) {
      return {
        success: false,
        code: 404,
        message: "Community not found",
      };
    }

    // Add new group IDs to the community
    const currentGroupIds = community.group_ids || [];
    const newGroupIds = [...new Set([...currentGroupIds, ...data.group_ids])];

    await db
      .update(community_model)
      .set({
        group_ids: newGroupIds,
        updated_at: new Date()
      })
      .where(eq(community_model.id, community_id));

    return {
      success: true,
      code: 200,
      message: "Groups added to community successfully",
      data: { group_ids: newGroupIds },
    };
  } catch (error) {
    console.error("add_community_groups error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: add_community_groups",
    };
  }
};

const remove_community_groups = async (
  community_id: number,
  admin_user_id: number,
  data: RemoveCommunityGroupRequest
) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, admin_user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can manage community groups",
      };
    }

    // Get current community
    const [community] = await db
      .select({ group_ids: community_model.group_ids })
      .from(community_model)
      .where(eq(community_model.id, community_id));

    if (!community) {
      return {
        success: false,
        code: 404,
        message: "Community not found",
      };
    }

    // Remove group IDs from the community
    const currentGroupIds = community.group_ids || [];
    const newGroupIds = currentGroupIds.filter(id => !data.group_ids.includes(id));

    await db
      .update(community_model)
      .set({
        group_ids: newGroupIds,
        updated_at: new Date()
      })
      .where(eq(community_model.id, community_id));

    return {
      success: true,
      code: 200,
      message: "Groups removed from community successfully",
      data: { group_ids: newGroupIds },
    };
  } catch (error) {
    console.error("remove_community_groups error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: remove_community_groups",
    };
  }
};

// Community group creation (creates a new group and adds it to community)
const create_community_group = async (
  admin_user_id: number,
  data: CreateCommunityGroupRequest
) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, admin_user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can create community groups",
      };
    }

    // Create community group metadata
    const groupMetadata: CommunityGroupMetadata = {
      community_id: data.community_id,
      active_time_slots: data.active_time_slots,
      timezone: data.timezone || "UTC",
      active_days: data.active_days || [1, 2, 3, 4, 5, 6, 0], // Default to all days
    };

    // Create conversation as community group
    const [group] = await db
      .insert(conversation_model)
      .values({
        id: create_unique_id(),
        creater_id: admin_user_id,
        type: "community_group",
        title: data.title,
        metadata: groupMetadata,
      })
      .returning();

    // Add the group to the community's group_ids
    const [community] = await db
      .select({ group_ids: community_model.group_ids })
      .from(community_model)
      .where(eq(community_model.id, data.community_id));

    if (community) {
      const currentGroupIds = community.group_ids || [];
      const newGroupIds = [...currentGroupIds, group.id];

      await db
        .update(community_model)
        .set({
          group_ids: newGroupIds,
          updated_at: new Date()
        })
        .where(eq(community_model.id, data.community_id));
    }

    // Add members to the group if specified
    if (data.member_ids && data.member_ids.length > 0) {
      const membersToAdd = data.member_ids.map(user_id => ({
        conversation_id: group.id,
        user_id,
        role: (user_id === admin_user_id ? "admin" : "member") as ChatRoleType,
      }));

      await db.insert(conversation_member_model).values(membersToAdd);
    }

    return {
      success: true,
      code: 201,
      message: "Community group created successfully",
      data: group,
    };
  } catch (error) {
    console.error("create_community_group error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: create_community_group",
    };
  }
};

const update_community_group = async (
  admin_user_id: number,
  data: UpdateCommunityGroupRequest
) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, admin_user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can update community groups",
      };
    }

    // Get current group data
    const [group] = await db
      .select({
        id: conversation_model.id,
        metadata: conversation_model.metadata,
        creater_id: conversation_model.creater_id,
      })
      .from(conversation_model)
      .where(
        and(
          eq(conversation_model.id, data.conversation_id),
          eq(conversation_model.type, "community_group"),
          eq(conversation_model.deleted, false)
        )
      );

    if (!group) {
      return {
        success: false,
        code: 404,
        message: "Community group not found",
      };
    }

    const currentMetadata = group.metadata as CommunityGroupMetadata;

    // Update metadata
    const updatedMetadata: CommunityGroupMetadata = {
      ...currentMetadata,
      ...(data.active_time_slots && { active_time_slots: data.active_time_slots }),
      ...(data.timezone && { timezone: data.timezone }),
      ...(data.active_days && { active_days: data.active_days }),
    };

    // Update group
    const [updatedGroup] = await db
      .update(conversation_model)
      .set({
        ...(data.title && { title: data.title }),
        metadata: updatedMetadata,
      })
      .where(eq(conversation_model.id, data.conversation_id))
      .returning();

    return {
      success: true,
      code: 200,
      message: "Community group updated successfully",
      data: updatedGroup,
    };
  } catch (error) {
    console.error("update_community_group error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: update_community_group",
    };
  }
};

const get_community_groups = async (community_id: number, user_id: number) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can view community groups",
      };
    }

    // Get community to get group_ids
    const [community] = await db
      .select({ group_ids: community_model.group_ids })
      .from(community_model)
      .where(eq(community_model.id, community_id));

    if (!community || !community.group_ids || community.group_ids.length === 0) {
      return {
        success: true,
        code: 200,
        data: [],
      };
    }

    // Get groups by IDs
    const groups = await db
      .select({
        id: conversation_model.id,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        created_at: conversation_model.created_at,
        last_message_at: conversation_model.last_message_at,
      })
      .from(conversation_model)
      .where(
        and(
          eq(conversation_model.type, "community_group"),
          inArray(conversation_model.id, community.group_ids),
          eq(conversation_model.deleted, false)
        )
      )
      .orderBy(desc(conversation_model.last_message_at));

    return {
      success: true,
      code: 200,
      data: groups,
    };
  } catch (error) {
    console.error("get_community_groups error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: get_community_groups",
    };
  }
};

const delete_community_group = async (
  conversation_id: number,
  admin_user_id: number
) => {
  try {
    // Check if user is admin or sub_admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, admin_user_id));

    if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
      return {
        success: false,
        code: 403,
        message: "Only admins and sub admins can delete community groups",
      };
    }

    // Get group data
    const [group] = await db
      .select({
        metadata: conversation_model.metadata,
      })
      .from(conversation_model)
      .where(
        and(
          eq(conversation_model.id, conversation_id),
          eq(conversation_model.type, "community_group"),
          eq(conversation_model.deleted, false)
        )
      );

    if (!group) {
      return {
        success: false,
        code: 404,
        message: "Community group not found",
      };
    }

    const metadata = group.metadata as CommunityGroupMetadata;

    // Remove the group from the community's group_ids
    if (metadata.community_id) {
      const [community] = await db
        .select({ group_ids: community_model.group_ids })
        .from(community_model)
        .where(eq(community_model.id, metadata.community_id));

      if (community) {
        const currentGroupIds = community.group_ids || [];
        const newGroupIds = currentGroupIds.filter(id => id !== conversation_id);

        await db
          .update(community_model)
          .set({
            group_ids: newGroupIds,
            updated_at: new Date()
          })
          .where(eq(community_model.id, metadata.community_id));
      }
    }

    // Soft delete the group
    await db
      .update(conversation_model)
      .set({ deleted: true })
      .where(eq(conversation_model.id, conversation_id));

    return {
      success: true,
      code: 200,
      message: "Community group deleted successfully",
    };
  } catch (error) {
    console.error("delete_community_group error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: delete_community_group",
    };
  }
};

export {
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
  get_connected_communities,
  delete_community_group,

};
