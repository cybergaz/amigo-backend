import db from "@/config/db";
import { community_model, community_member_model } from "@/models/community.model";
import { conversation_model, conversation_member_model } from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  CreateCommunityRequest,
  UpdateCommunityRequest,
  CreateCommunityGroupRequest,
  UpdateCommunityGroupRequest,
  AddCommunityMemberRequest,
  RemoveCommunityMemberRequest,
  UpdateCommunityMemberRoleRequest,
  CommunityGroupMetadata
} from "@/types/community.types";
import { ChatRoleType } from "@/types/chat.types";
import { create_unique_id } from "@/utils/general.utils";
import { and, eq, inArray, sql, desc } from "drizzle-orm";

// Community CRUD operations
const create_community = async (
  super_admin_id: number,
  data: CreateCommunityRequest
) => {
  try {
    // Check if user is super admin
    const [user] = await db
      .select({ role: user_model.role })
      .from(user_model)
      .where(eq(user_model.id, super_admin_id));

    if (!user || user.role !== "admin") {
      return {
        success: false,
        code: 403,
        message: "Only super admins can create communities",
      };
    }

    const [community] = await db
      .insert(community_model)
      .values({
        id: create_unique_id(),
        name: data.name,
        description: data.description,
        super_admin_id,
        metadata: data.metadata || {},
        updated_at: new Date(),
      })
      .returning();

    // Add super admin as community member
    await db.insert(community_member_model).values({
      id: create_unique_id(),
      community_id: community.id,
      user_id: super_admin_id,
      role: "admin",
    });

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
    const communities = await db
      .select({
        id: community_model.id,
        name: community_model.name,
        description: community_model.description,
        super_admin_id: community_model.super_admin_id,
        metadata: community_model.metadata,
        created_at: community_model.created_at,
        updated_at: community_model.updated_at,
        user_role: community_member_model.role,
      })
      .from(community_member_model)
      .innerJoin(
        community_model,
        eq(community_model.id, community_member_model.community_id)
      )
      .where(
        and(
          eq(community_member_model.user_id, user_id),
          eq(community_model.deleted, false),
          eq(community_member_model.deleted, false)
        )
      )
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

const get_community_details = async (community_id: number, user_id: number) => {
  try {
    // Check if user is member of community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          eq(community_member_model.user_id, user_id),
          eq(community_member_model.deleted, false)
        )
      );

    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this community",
      };
    }

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

    // Get member count
    const memberCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          eq(community_member_model.deleted, false)
        )
      );

    // Get group count
    const groupCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(conversation_model)
      .where(
        and(
          eq(conversation_model.type, "community_group"),
          sql`${conversation_model.metadata}->>'community_id' = ${community_id.toString()}`,
          eq(conversation_model.deleted, false)
        )
      );

    return {
      success: true,
      code: 200,
      data: {
        ...community,
        user_role: membership.role,
        member_count: memberCountResult[0]?.count || 0,
        group_count: groupCountResult[0]?.count || 0,
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
    // Check if user is super admin of the community
    const [community] = await db
      .select({ super_admin_id: community_model.super_admin_id })
      .from(community_model)
      .where(eq(community_model.id, community_id));

    if (!community || community.super_admin_id !== user_id) {
      return {
        success: false,
        code: 403,
        message: "Only the super admin can update this community",
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
    // Check if user is super admin of the community
    const [community] = await db
      .select({ super_admin_id: community_model.super_admin_id })
      .from(community_model)
      .where(eq(community_model.id, community_id));

    if (!community || community.super_admin_id !== user_id) {
      return {
        success: false,
        code: 403,
        message: "Only the super admin can delete this community",
      };
    }

    // Soft delete community
    await db
      .update(community_model)
      .set({ deleted: true, updated_at: new Date() })
      .where(eq(community_model.id, community_id));

    // Also soft delete all community groups
    await db
      .update(conversation_model)
      .set({ deleted: true })
      .where(
        and(
          eq(conversation_model.type, "community_group"),
          sql`${conversation_model.metadata}->>'community_id' = ${community_id.toString()}`
        )
      );

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

// Community member management
const add_community_members = async (
  community_id: number,
  admin_user_id: number,
  data: AddCommunityMemberRequest
) => {
  try {
    // Check if user is admin of the community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          eq(community_member_model.user_id, admin_user_id)
        )
      );

    if (!membership || membership.role !== "admin") {
      return {
        success: false,
        code: 403,
        message: "Only community admins can add members",
      };
    }

    // Add members
    const membersToAdd = data.user_ids.map(user_id => ({
      id: create_unique_id(),
      community_id,
      user_id,
      role: data.role || "member",
    }));

    const addedMembers = await db
      .insert(community_member_model)
      .values(membersToAdd)
      .onConflictDoNothing()
      .returning();

    return {
      success: true,
      code: 200,
      message: "Members added successfully",
      data: addedMembers,
    };
  } catch (error) {
    console.error("add_community_members error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: add_community_members",
    };
  }
};

const remove_community_members = async (
  community_id: number,
  admin_user_id: number,
  data: RemoveCommunityMemberRequest
) => {
  try {
    // Check if user is admin of the community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          eq(community_member_model.user_id, admin_user_id)
        )
      );

    if (!membership || membership.role !== "admin") {
      return {
        success: false,
        code: 403,
        message: "Only community admins can remove members",
      };
    }

    // Soft delete members
    const removedMembers = await db
      .update(community_member_model)
      .set({ deleted: true })
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          inArray(community_member_model.user_id, data.user_ids)
        )
      )
      .returning();

    return {
      success: true,
      code: 200,
      message: "Members removed successfully",
      data: removedMembers,
    };
  } catch (error) {
    console.error("remove_community_members error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: remove_community_members",
    };
  }
};

const get_community_members = async (community_id: number, user_id: number) => {
  try {
    // Check if user is member of community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          eq(community_member_model.user_id, user_id),
          eq(community_member_model.deleted, false)
        )
      );

    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this community",
      };
    }

    const members = await db
      .select({
        id: community_member_model.id,
        user_id: community_member_model.user_id,
        role: community_member_model.role,
        joined_at: community_member_model.joined_at,
        user_name: user_model.name,
        user_profile_pic: user_model.profile_pic,
        user_last_seen: user_model.last_seen,
      })
      .from(community_member_model)
      .innerJoin(user_model, eq(user_model.id, community_member_model.user_id))
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          eq(community_member_model.deleted, false)
        )
      )
      .orderBy(community_member_model.joined_at);

    return {
      success: true,
      code: 200,
      data: members,
    };
  } catch (error) {
    console.error("get_community_members error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR: get_community_members",
    };
  }
};

// Community group management
const create_community_group = async (
  admin_user_id: number,
  data: CreateCommunityGroupRequest
) => {
  try {
    // Check if user is admin of the community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, data.community_id),
          eq(community_member_model.user_id, admin_user_id)
        )
      );

    if (!membership || membership.role !== "admin") {
      return {
        success: false,
        code: 403,
        message: "Only community admins can create groups",
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

    // Get all community members to add to the group
    const communityMembers = await db
      .select({ user_id: community_member_model.user_id })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, data.community_id),
          eq(community_member_model.deleted, false)
        )
      );

    // Add all community members to the group
    const membersToAdd = communityMembers.map(member => ({
      conversation_id: group.id,
      user_id: member.user_id,
      role: (member.user_id === admin_user_id ? "admin" : "member") as ChatRoleType,
    }));

    await db.insert(conversation_member_model).values(membersToAdd);

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
    
    // Check if user is admin of the community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, currentMetadata.community_id!),
          eq(community_member_model.user_id, admin_user_id)
        )
      );

    if (!membership || membership.role !== "admin") {
      return {
        success: false,
        code: 403,
        message: "Only community admins can update groups",
      };
    }

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
    // Check if user is member of community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, community_id),
          eq(community_member_model.user_id, user_id),
          eq(community_member_model.deleted, false)
        )
      );

    if (!membership) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this community",
      };
    }

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
          sql`${conversation_model.metadata}->>'community_id' = ${community_id.toString()}`,
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
    
    // Check if user is admin of the community
    const [membership] = await db
      .select({ role: community_member_model.role })
      .from(community_member_model)
      .where(
        and(
          eq(community_member_model.community_id, metadata.community_id!),
          eq(community_member_model.user_id, admin_user_id)
        )
      );

    if (!membership || membership.role !== "admin") {
      return {
        success: false,
        code: 403,
        message: "Only community admins can delete groups",
      };
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
  add_community_members,
  remove_community_members,
  get_community_members,
  create_community_group,
  update_community_group,
  get_community_groups,
  delete_community_group
};
