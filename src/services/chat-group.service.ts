import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import {
  ChatRoleType,
  ChatType,
} from "@/types/chat.types";
import { create_unique_id } from "@/utils/general.utils";
import { and, asc, eq, inArray, or, } from "drizzle-orm";
import { redis } from "@/config/redis";
import { broadcast_message } from "@/sockets/socket.handlers";
import { NewConversationPayload, MembersType } from "@/types/socket.types";
import { get_user_details } from "./user.services";
import { broadcast_conversation_action } from "./chat.services";

const create_group = async (
  creater_id: number,
  title: string,
  member_ids?: number[]
) => {

  try {
    const [chat] = await db
      .insert(conversation_model)
      .values({
        id: create_unique_id(),
        creater_id,
        type: "group",
        title,
      })
      .returning();

    // Ensure creator is always in the group
    const uniqueMemberIds = Array.from(new Set([creater_id, ...member_ids || []]));

    await db.insert(conversation_member_model).values(
      uniqueMemberIds.map((uid) => ({
        conversation_id: chat.id,
        user_id: uid,
        role: (uid === creater_id ? "admin" : "member") as ChatRoleType, // creator is admin
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
        .where(eq(user_model.id, creater_id))

      const members_res = await get_group_members(chat.id);
      const members = members_res.success ? members_res.data : [];

      // for (const memberId of uniqueMemberIds) {
      //   const conversationData = await getConversationDetailsForUser(chat.id, memberId);
      // }

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
      }

      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "users",
        user_ids: member_ids,
        message: {
          type: "conversation:new",
          payload: new_conversation_payload,
          ws_timestamp: new Date()
        },
      })
      // if (conversationData) {
      //   await send_to_user(memberId, {
      //     type: 'conversation_added',
      //     conversation_id: chat.id,
      //     data: conversationData,
      //     timestamp: new Date().toISOString()
      //   });
      // }

      // update redis entries
      const redis_key = `conv:${chat.id}:members`;
      const new_members_id = uniqueMemberIds.map(id => id.toString());
      await redis.sadd(redis_key, ...new_members_id);

      // Invalidate conversation lru cache in other services
      await redis.publish("conv:invalidate", chat.id.toString());

    } catch (error) {
      console.error('Error sending conversation_added notification for group:', error);
      // Don't fail the request if notification fails
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

const get_group_info = async (conversation_id: number) => {
  try {
    const [group] = await db
      .select({
        conversation_id: conversation_model.id,
        type: conversation_model.type,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        lastMessageAt: conversation_model.last_message_at,

        createrId: user_model.id,
        createrName: user_model.name,
        createrProfilePic: user_model.profile_pic,
      })
      .from(conversation_model)
      .leftJoin(
        user_model,
        eq(user_model.id, conversation_model.creater_id)
      )
      .where(
        and(
          eq(conversation_model.id, conversation_id),
          or(
            eq(conversation_model.type, "group"),
            eq(conversation_model.type, "community_group")
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
        role: conversation_member_model.role,
        joinedAt: conversation_member_model.joined_at,
      })
      .from(conversation_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(eq(conversation_member_model.conversation_id, conversation_id))
      .orderBy(asc(conversation_member_model.joined_at));

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
}

const get_group_admin_info = async (conv_id: number) => {
  try {

    const [conversation] = await db
      .select({ creater_id: conversation_model.creater_id })
      .from(conversation_model)
      .where(eq(conversation_model.id, conv_id))
      .limit(1);


    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      }
    }

    const admin = await get_user_details(conversation.creater_id);

    if (!admin.success) {
      return {
        success: false,
        code: 404,
        message: "Admin info not found",
      }
    }

    return {
      success: true,
      code: 200,
      data: admin.data,
    }

  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : get_group_admin_info",
    }
  }
}

const get_group_members = async (conversation_id: number) => {
  try {
    const members = await db
      .select({
        user_id: user_model.id,
        user_name: user_model.name,
        user_pfp: user_model.profile_pic,
        role: conversation_member_model.role,
        joined_at: conversation_member_model.joined_at,
      })
      .from(conversation_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(eq(conversation_member_model.conversation_id, conversation_id))

    return {
      success: true,
      code: 200,
      data: members as MembersType[],
    }
  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : get_group_members",
    }
  }
}

const add_new_member = async (
  conversation_id: number,
  user_ids: number[],
  role: ChatRoleType = "member",
  actor_id?: number,
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

    // 2. Find already existing members
    const existingMembers = await db
      .select({ user_id: conversation_member_model.user_id })
      .from(conversation_member_model)
      .where(
        and(
          inArray(conversation_member_model.user_id, validUserIds),
          eq(conversation_member_model.conversation_id, conversation_id)
        )
      )

    const existingIds = existingMembers.map((m) => m.user_id);

    // 3. Eligible new members = valid - existing
    const eligibleIds = validUserIds.filter((id) => !existingIds.includes(id));

    // 4. Insert eligible members
    let inserted: typeof conversation_member_model.$inferSelect[] = [];
    if (eligibleIds.length > 0) {
      inserted = await db
        .insert(conversation_member_model)
        .values(
          eligibleIds.map((id) => ({
            conversation_id,
            user_id: id,
            role,
          }))
        )
        .returning();
    }

    // Send websocket message to newly added member
    // try {
    //   for (const newMemberId of eligibleIds) {
    //     const conversationData = await getConversationDetailsForUser(conversation_id, newMemberId);
    //     // if (conversationData) {
    //     //   await send_to_user(newMemberId, {
    //     //     type: 'conversation_added',
    //     //     conversation_id: conversation_id,
    //     //     data: conversationData,
    //     //     timestamp: new Date().toISOString()
    //     //   });
    //     // }
    //   }
    // } catch (error) {
    //   console.error('Error sending conversation_added notification for new members:', error);
    //   // Don't fail the request if notification fails
    // }

    const [conv_details] = await db
      .select()
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .limit(1);

    if (!conv_details) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    const actor_details = actor_id ? await get_user_details(actor_id) : null;

    const creater_info = await get_user_details(conv_details.creater_id);
    const members_res = await get_group_members(conversation_id);
    const members = members_res.success ? members_res.data : [];

    if (!creater_info.success || !creater_info.data) {
      throw new Error("Admin info not found");
    }

    // for (const memberId of uniqueMemberIds) {
    //   const conversationData = await getConversationDetailsForUser(chat.id, memberId);
    // }

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
    }
    // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    await broadcast_message({
      to: "users",
      user_ids: user_ids,
      message: {
        type: "conversation:new",
        payload: new_conversation_payload,
        ws_timestamp: new Date()
      },
    })
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
    // if (conversationData) {
    //   await send_to_user(memberId, {
    //     type: 'conversation_added',
    //     conversation_id: chat.id,
    //     data: conversationData,
    //     timestamp: new Date().toISOString()
    //   });
    // }

    // update redis entries
    const redis_key = `conv:${conversation_id}:members`;
    const new_members_id = eligibleIds.map(id => id.toString());
    await redis.sadd(redis_key, ...new_members_id);

    // Invalidate conversation lru cache in other services
    await redis.publish("conv:invalidate", conversation_id.toString());

    return {
      success: true,
      code: 200,
      message: "Processed members",
      data: {
        inserted,          // ✅ actually added
        existing: existingIds, // ⚠️ already in conversation
        invalid: invalidUserIds, // ❌ not real users
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
  conversation_id: number,
  user_id: number,
  actor_id?: number,
) => {
  try {
    const [conversation] = await db
      .select({ type: conversation_model.type })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .limit(1);

    const member_info = await db
      .select({
        user_id: conversation_member_model.user_id,
        role: conversation_member_model.role,
        joined_at: conversation_member_model.joined_at,
        user_name: user_model.name,
        user_pfp: user_model.profile_pic,
      })
      .from(conversation_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
        )
      );

    const actor_details = actor_id ? await get_user_details(actor_id) : null;

    const result = await db
      .delete(conversation_member_model)
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
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

    // Update redis set
    const redis_key = `conv:${conversation_id}:members`;
    await redis.srem(redis_key, user_id.toString());

    // Invalidate conversation lru cache in other services
    await redis.publish("conv:invalidate", conversation_id.toString());

    if (member_info.length) {
      const members_for_action: MembersType[] = member_info.map((m) => ({
        user_id: m.user_id,
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
  conversation_id: number,
  user_id: number,
  actor_id?: number,
) => {
  try {
    const [conversation] = await db
      .select({ type: conversation_model.type })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .limit(1);

    const actor_details = actor_id ? await get_user_details(actor_id) : null;
    const target_user_details = await get_user_details(user_id);

    const [member] = await db
      .update(conversation_member_model)
      .set({ role: "admin" })
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
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
}

const demote_to_member = async (
  conversation_id: number,
  user_id: number,
  actor_id?: number,
) => {
  try {
    const [conversation] = await db
      .select({ type: conversation_model.type })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .limit(1);

    const actor_details = actor_id ? await get_user_details(actor_id) : null;
    const target_user_details = await get_user_details(user_id);

    const [member] = await db
      .update(conversation_member_model)
      .set({ role: "member" })
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
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
}

const update_group_title = async (
  conversation_id: number,
  title: string
) => {
  try {
    const [chat] = await db
      .update(conversation_model)
      .set({ title })
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (!chat) {
      return {
        success: false,
        code: 404,
        message: "Group not found",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Group title updated successfully",
      data: chat,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : update_group_title",
    };
  }
}

export {
  get_group_info,
  create_group,
  add_new_member,
  remove_member,
  promote_to_admin,
  demote_to_member,
  update_group_title,
  get_group_admin_info
}
