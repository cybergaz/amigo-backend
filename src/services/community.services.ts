import db from "@/config/db";
import { community_model } from "@/models/community.model";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  CreateCommunityRequest,
  UpdateCommunityRequest,
  CreateCommunityGroupRequest,
  UpdateCommunityGroupRequest,
  AddCommunityGroupRequest,
  RemoveCommunityGroupRequest,
} from "@/types/community.types";
import { ChatRoleType } from "@/types/chat.types";
import { and, eq, inArray, isNull, sql, desc, arrayContains, arrayOverlaps } from "drizzle-orm";

// Community CRUD operations
const create_community = async (
  super_admin_id: string,
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

const get_communities = async (user_id: string) => {
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
      .where(isNull(community_model.deleted_at))
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

const get_connected_communities = async (user_id: string) => {
  try {

    // we have to get all communities where the user is a member of at least one group in the community
    // Get all community groups the user is a member of
    const userGroupIdsResult = await db
      .select({ conversation_id: chat_member_model.chat_id })
      .from(chat_member_model)
      .where(
        and(
          eq(chat_member_model.user_id, user_id),
          // Only groups the user is ACTIVELY in count as "connected". Left/
          // kicked/pending rows keep removed_at NULL as shells, so without the
          // status gate a removed member would still see the community.
          isNull(chat_member_model.removed_at),
          eq(chat_member_model.status, "active")
        )
      );

    const userGroupIds = userGroupIdsResult.map(r => r.conversation_id);

    if (userGroupIds.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No connected communities",
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
          isNull(community_model.deleted_at),
          arrayOverlaps(community_model.group_ids, userGroupIds)
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

const get_community_details = async (community_id: string, user_id: string) => {
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
          isNull(community_model.deleted_at)
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
  community_id: string,
  user_id: string,
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

const delete_community = async (community_id: string, user_id: string) => {
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
      .set({ deleted_at: new Date(), updated_at: new Date() })
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
  community_id: string,
  admin_user_id: string,
  data: AddCommunityGroupRequest
) => {
  try {
    // Check if user is admin or sub_admin
    // const [user] = await db
    //   .select({ role: user_model.role })
    //   .from(user_model)
    //   .where(eq(user_model.id, admin_user_id));
    //
    // if (!user || (user.role !== "admin" && user.role !== "sub_admin")) {
    //   return {
    //     success: false,
    //     code: 403,
    //     message: "Only admins and sub admins can manage community groups",
    //   };
    // }

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
  community_id: string,
  admin_user_id: string,
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
  admin_user_id: string,
  data: CreateCommunityGroupRequest
) => {
  try {

    // Create conversation as community group
    const [group] = await db
      .insert(chat_model)
      .values({
        creater_id: admin_user_id,
        type: "community_group",
        title: data.title,
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
        chat_id: group.id,
        user_id,
        role: (user_id === admin_user_id ? "admin" : "member") as ChatRoleType,
      }));

      await db.insert(chat_member_model).values(membersToAdd);
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
  admin_user_id: string,
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
        id: chat_model.id,
        creater_id: chat_model.creater_id,
      })
      .from(chat_model)
      .where(
        and(
          eq(chat_model.id, data.conversation_id),
          eq(chat_model.type, "community_group"),
          isNull(chat_model.deleted_at)
        )
      );

    if (!group) {
      return {
        success: false,
        code: 404,
        message: "Community group not found",
      };
    }

    // Update group title
    const [updatedGroup] = await db
      .update(chat_model)
      .set({
        ...(data.title && { title: data.title }),
      })
      .where(eq(chat_model.id, data.conversation_id))
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

const get_community_groups = async (community_id: string, user_id: string) => {
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
        id: chat_model.id,
        title: chat_model.title,
        created_at: chat_model.created_at,
        last_message_at: chat_model.last_msg_at,
      })
      .from(chat_model)
      .where(
        and(
          eq(chat_model.type, "community_group"),
          inArray(chat_model.id, community.group_ids),
          isNull(chat_model.deleted_at)
        )
      )
      .orderBy(desc(chat_model.last_msg_at));

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
  conversation_id: string,
  admin_user_id: string
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

    // Verify the group exists
    const [group] = await db
      .select({ id: chat_model.id })
      .from(chat_model)
      .where(
        and(
          eq(chat_model.id, conversation_id),
          eq(chat_model.type, "community_group"),
          isNull(chat_model.deleted_at)
        )
      );

    if (!group) {
      return {
        success: false,
        code: 404,
        message: "Community group not found",
      };
    }

    // Remove the group from any community's group_ids that contains it
    const communities = await db
      .select({ id: community_model.id, group_ids: community_model.group_ids })
      .from(community_model)
      .where(arrayContains(community_model.group_ids, [conversation_id]));

    for (const community of communities) {
      const newGroupIds = (community.group_ids || []).filter(id => id !== conversation_id);
      await db
        .update(community_model)
        .set({ group_ids: newGroupIds, updated_at: new Date() })
        .where(eq(community_model.id, community.id));
    }

    // Soft delete the group
    await db
      .update(chat_model)
      .set({ deleted_at: new Date() })
      .where(eq(chat_model.id, conversation_id));

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

const get_all_community_groups = async () => {
  try {
    // Get all community groups that are not deleted
    const groups = await db
      .select({
        id: chat_model.id,
        title: chat_model.title,
        type: chat_model.type,
        created_at: chat_model.created_at,
      })
      .from(chat_model)
      .where(
        and(
          eq(chat_model.type, "community_group"),
          isNull(chat_model.deleted_at)
        )
      )
      .orderBy(desc(chat_model.created_at));

    return {
      success: true,
      code: 200,
      data: groups,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR: get_all_community_groups",
      data: null,
    };
  }
};

const create_standalone_comminity_group = async (
  admin_user_id: string,
  data: Pick<CreateCommunityGroupRequest, "title" | "active_time_slots" | "timezone" | "active_days">,
) => {
  try {
    // Find all community groups that do not have a community_id in metadata

    const [group] = await db
      .insert(chat_model)
      .values({
        creater_id: admin_user_id,
        type: "community_group",
        title: data.title,
      })
      .returning();

    if (!group) {
      return {
        success: false,
        code: 500,
        message: "Failed to create standalone community group",
      };
    }

    return {
      success: true,
      code: 201,
      message: "Standalone community group created successfully",
      data: group,
    };

  }
  catch (error) {
    console.error("add_standalone_comminity_group error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: add_standalone_comminity_group",
    };
  }
};

// Add group to multiple communities at once
const add_group_to_multiple_communities = async (
  group_id: string,
  admin_user_id: string,
  community_ids: string[]
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

    // Verify the group exists
    const [group] = await db
      .select({ id: chat_model.id })
      .from(chat_model)
      .where(
        and(
          eq(chat_model.id, group_id),
          isNull(chat_model.deleted_at)
        )
      );

    if (!group) {
      return {
        success: false,
        code: 404,
        message: "Group not found",
      };
    }

    // Add the group to each community
    let addedToCommunities = 0;
    const errors: string[] = [];

    for (const community_id of community_ids) {
      // Get current community
      const [community] = await db
        .select({ group_ids: community_model.group_ids })
        .from(community_model)
        .where(eq(community_model.id, community_id));

      if (!community) {
        errors.push(`Community ${community_id} not found`);
        continue;
      }

      // Check if group is already in community
      const currentGroupIds = community.group_ids || [];
      if (currentGroupIds.includes(group_id)) {
        errors.push(`Group already exists in community ${community_id}`);
        continue;
      }

      // Add group to community
      const newGroupIds = [...currentGroupIds, group_id];
      await db
        .update(community_model)
        .set({
          group_ids: newGroupIds,
          updated_at: new Date()
        })
        .where(eq(community_model.id, community_id));

      addedToCommunities++;
    }

    return {
      success: true,
      code: 200,
      message: `Group added to ${addedToCommunities} ${addedToCommunities === 1 ? 'community' : 'communities'}`,
      data: {
        added_to_communities: addedToCommunities,
        errors: errors.length > 0 ? errors : undefined
      },
    };
  } catch (error) {
    console.error("add_group_to_multiple_communities error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: add_group_to_multiple_communities",
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
  get_all_community_groups,
  create_standalone_comminity_group,
  add_group_to_multiple_communities
};
