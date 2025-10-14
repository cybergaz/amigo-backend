import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
  message_model,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import user_routes from "@/routes/user.routes";
import {
  ChatRoleType,
  ChatType,
} from "@/types/chat.types";
import { create_dm_key, create_unique_id } from "@/utils/general.utils";
import { and, arrayContains, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

const create_chat = async (sender_id: number, receiver_id: number) => {
  try {
    const dm_key = create_dm_key(sender_id, receiver_id)

    const existingChat = await db
      .select({ conversation_id: conversation_model.id })
      .from(conversation_model)
      .where(
        and(
          eq(conversation_model.type, "dm"),
          eq(conversation_model.dm_key, dm_key)
        )
      );

    // const existingChat = await db
    //   .select({ conversation_id: conversation_member_model.conversation_id })
    //   .from(conversation_member_model)
    //   .leftJoin(
    //     conversation_model,
    //     eq(conversation_member_model.conversation_id, conversation_model.id)
    //   )
    //   .where(
    //     and(
    //       eq(conversation_model.type, "dm"),
    //       inArray(conversation_member_model.user_id, [sender_id, receiver_id])
    //     )
    //   )
    //   .groupBy(conversation_member_model.conversation_id)
    //   .having(sql`count(distinct ${conversation_member_model.user_id}) = 2`);

    // console.log("existingChat ->", existingChat)

    if (existingChat.length > 0) {
      return {
        success: true,
        code: 200,
        data: { id: existingChat[0].conversation_id, existing: true },
      };
    }

    const [chat] = await db
      .insert(conversation_model)
      .values({
        id: create_unique_id(),
        creater_id: sender_id,
        type: "dm",
        dm_key: dm_key,
      })
      .returning();

    // Insert both members in conversation_member_model
    await db.insert(conversation_member_model).values([
      {
        conversation_id: chat.id,
        user_id: sender_id,
      },
      {
        conversation_id: chat.id,
        user_id: receiver_id,
      },
    ]);

    // -----------------------------------------------------------------------------------
    // TEMPORARY HACK FOR THAT FIRST MESSAGE DISSAPPEAR ISSUE
    // -----------------------------------------------------------------------------------
    await db.insert(message_model).values({
      conversation_id: chat.id,
      sender_id: sender_id,
      type: "system",
      body: "chat initiated",
    });
    // -----------------------------------------------------------------------------------
    // TEMPORARY HACK FOR THAT FIRST MESSAGE DISSAPPEAR ISSUE
    // -----------------------------------------------------------------------------------

    return {
      success: true,
      code: 200,
      message: "DM Chat created successfully",
      data: chat,
    };

  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : create_chat",
    };
  }
};

const get_chat_list = async (user_id: number, type: string) => {
  try {
    const conversationIdsRes = await db
      .select({ conversationId: conversation_member_model.conversation_id })
      .from(conversation_member_model)
      .where(eq(conversation_member_model.user_id, user_id));

    const conversationIds = conversationIdsRes.map((c) => c.conversationId);

    const chats = await db
      .select({
        conversationId: conversation_model.id,
        type: conversation_model.type,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        lastMessageAt: conversation_model.last_message_at,

        role: conversation_member_model.role,
        unreadCount: conversation_member_model.unread_count,
        joinedAt: conversation_member_model.joined_at,

        // from user_model - for DMs, this will be the other user
        userId: user_model.id,
        userName: user_model.name,
        onlineStatus: user_model.online_status,
        lastSeen: user_model.last_seen,
        userProfilePic: user_model.profile_pic,
      })
      .from(conversation_member_model)
      .innerJoin(
        conversation_model,
        eq(conversation_model.id, conversation_member_model.conversation_id)
      )
      .leftJoin(
        user_model,
        and(
          eq(user_model.id, conversation_member_model.user_id),
          ne(user_model.id, user_id) // Only join with other users for DMs
        )
      )
      .where(
        and(
          inArray(conversation_model.id, conversationIds),
          eq(conversation_member_model.user_id, user_id), // Get user's own membership record
          // type !== "all" ?
          type === "group"
            ? eq(conversation_model.type, "group")
            : type === "community_group"
              ? eq(conversation_model.type, "community_group")
              : type === "deleted_dm"
                ? and(eq(conversation_model.type, "dm"), eq(conversation_member_model.deleted, true))
                : and(eq(conversation_model.type, "dm"), eq(conversation_member_model.deleted, false)),
          // : eq(conversation_model.type, "dm")
          // : eq(conversation_model.deleted, false),
          // eq(conversation_member_model.deleted, false),
          eq(conversation_model.deleted, false),
        )
      )
      .orderBy(desc(conversation_model.last_message_at));

    // For groups and community groups, we don't need the other user info
    // For DMs, we need to get the other user's info separately
    const processedChats = await Promise.all(
      chats.map(async (chat) => {
        if (chat.type === "dm" && !chat.userId) {
          // Get the other user for DM
          const [otherUser] = await db
            .select({
              userId: user_model.id,
              userName: user_model.name,
              onlineStatus: user_model.online_status,
              lastSeen: user_model.last_seen,
              userProfilePic: user_model.profile_pic,
            })
            .from(conversation_member_model)
            .innerJoin(user_model, eq(user_model.id, conversation_member_model.user_id))
            .where(
              and(
                eq(conversation_member_model.conversation_id, chat.conversationId),
                ne(conversation_member_model.user_id, user_id)
              )
            );

          return {
            ...chat,
            userId: otherUser?.userId || null,
            userName: otherUser?.userName || null,
            onlineStatus: otherUser?.onlineStatus || "offline",
            lastSeen: otherUser?.lastSeen || null,
            userProfilePic: otherUser?.userProfilePic || null,
          };
        }

        // For groups and community groups, clear user info since it's not relevant
        if (chat.type === "group" || chat.type === "community_group") {
          return {
            ...chat,
            userId: null,
            userName: null,
            onlineStatus: "offline",
            lastSeen: null,
            userProfilePic: null,
          };
        }

        return chat;
      })
    );

    if (processedChats.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No chats found",
      };
    }

    return {
      success: true,
      code: 200,
      data: processedChats,
    };
  } catch (error) {
    console.error("get_chat_list error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_chat_list",
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



const add_new_member = async (
  conversation_id: number,
  user_ids: number[],
  role: ChatRoleType = "member"
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
  user_id: number
) => {
  try {
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
) => {
  try {
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
) => {
  try {
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

const soft_delete_chat = async (conversation_id: number, user_id: number) => {
  try {
    const [conversation] = await db
      .update(conversation_model)
      .set({ deleted: true })
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: { conversation_id, deleted: false },
      };
    }

    return {
      success: true,
      code: 200,
      message: "Conversation soft deleted successfully",
      data: conversation
    };

  } catch (error) {
    console.error("delete conversation error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : soft_delete_conversation",
    };
  }
};

const hard_delete_chat = async (conversation_id: number) => {
  try {
    const [conversation] = await db
      .delete(conversation_model)
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: { conversation_id, deleted: false },
      };
    }

    return {
      success: true,
      code: 200,
      message: "Conversation deleted successfully",
      data: conversation
    };

  } catch (error) {
    console.error("delete conversation error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : hard_delete_conversation",
    };
  }
};

const revive_chat = async (conversation_id: number) => {
  try {
    // Verify conversation exists
    const [conversation] = await db
      .select({
        id: conversation_model.id,
        deleted: conversation_model.deleted,
      })
      .from(conversation_model)
      .where(eq(conversation_model.id, conversation_id));

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: null,
      };
    }

    if (!conversation.deleted) {
      return {
        success: false,
        code: 400,
        message: "Conversation is not deleted",
        data: null,
      };
    }

    // Revive the conversation by setting deleted to false
    const result = await db
      .update(conversation_model)
      .set({ deleted: false })
      .where(eq(conversation_model.id, conversation_id))
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 500,
        message: "Failed to revive conversation",
        data: null,
      };
    }

    return {
      success: true,
      code: 200,
      message: "Conversation revived successfully",
      data: result[0],
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : revive_chat",
      data: null,
    };
  }
}


const dm_delete_status = async (conversation_id: number, user_id: number, status: boolean) => {
  try {
    const [conversation] = await db
      .update(conversation_member_model)
      .set({ deleted: status })
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
        )
      )
      .returning();

    if (!conversation) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
        data: { conversation_id, deleted: false },
      }
    }

    return {
      success: true,
      code: 200,
      message: `Conversation ${status ? "deleted" : "revived"} successfully`,
      data: conversation
    };

  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : dm_delete_status",
    };
  }
};

const soft_delete_message = async (message_ids: number[], user_id: number) => {
  try {
    const messages = await db
      .update(message_model)
      .set({ deleted: true })
      .where(and(
        inArray(message_model.id, message_ids),
        eq(message_model.sender_id, user_id)
      ))

    if (!messages) {
      return {
        success: false,
        code: 404,
        message: "Either message not found or you do not own this message",
        data: { message_id: message_ids, deleted: false },
      };
    }

    return {
      success: true,
      code: 200,
      message: "Messages marked as deleted successfully",
      data: messages
    };

  } catch (error) {
    console.error("delete Message error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : mark_as_delete_message",
    };
  }
};

const hard_delete_message = async (message_id: number) => {
  try {
    // Check if user is super admin (this should be verified at route level)
    const result = await db
      .delete(message_model)
      .where(eq(message_model.id, message_id))
      .returning();

    if (result.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Message not found",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Message permanently deleted",
      data: result[0],
    };
  } catch (error) {
    console.error("permanently_delete_message_admin error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : permanently_delete_message_admin",
    };
  }
};

const get_conversation_history = async (
  conversation_id: number,
  user_id: number,
  page: number = 1,
  limit: number = 20
) => {
  try {
    // First, verify user is a member of this conversation
    const members = await db
      .select({
        user_id: conversation_member_model.user_id,
        name: user_model.name,
        profile_pic: user_model.profile_pic,
        last_read_message_id: conversation_member_model.last_read_message_id,
        last_delivered_message_id: conversation_member_model.last_delivered_message_id,
      })
      .from(conversation_member_model)
      .leftJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.deleted, false)
        )
      );

    if (members.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Conversation not found",
      };
    }

    if (!members.find(m => m.user_id === user_id)) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Get messages with sender information
    const messages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        metadata: message_model.metadata,
        edited_at: message_model.edited_at,
        created_at: message_model.created_at,
        deleted: message_model.deleted,
        forwarded_from: message_model.forwarded_from,
        forwarded_count: message_model.forwarded_to,

        // Sender information
        // sender_name: user_model.name,
        // sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      // .innerJoin(
      //   user_model,
      //   eq(user_model.id, message_model.sender_id)
      // )
      .where(
        and(
          or(
            eq(message_model.conversation_id, conversation_id),
            arrayContains(message_model.forwarded_to, [conversation_id]),
          ),
          eq(message_model.deleted, false)
        )
      )
      .orderBy(desc(message_model.created_at))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination info
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_model)
      .where(
        and(
          eq(message_model.conversation_id, conversation_id),
          eq(message_model.deleted, false)
        )
      );

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      success: true,
      code: 200,
      data: {
        messages: messages.reverse(), // Reverse to show oldest first
        members,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          limit,
          hasNextPage,
          hasPreviousPage,
        },
      },
    };

  } catch (error) {
    console.error("get_conversation_history error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_history",
    };
  }
};

// Admin-specific functions for managing all chats
const get_all_conversations_admin = async (type?: string) => {
  try {
    let whereCondition

    if (type && type !== "all") {
      whereCondition = and(
        // eq(conversation_model.deleted, false),
        eq(conversation_model.type, type as ChatType)
      )!;
    }

    const conversations = await db
      .select({
        conversationId: conversation_model.id,
        type: conversation_model.type,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        lastMessageAt: conversation_model.last_message_at,
        created_at: conversation_model.created_at,
        createrId: conversation_model.creater_id,
        deleted: conversation_model.deleted,

        // Creator info
        createrName: user_model.name,
        createrProfilePic: user_model.profile_pic,
      })
      .from(conversation_model)
      .leftJoin(
        user_model,
        eq(user_model.id, conversation_model.creater_id)
      )
      .where(whereCondition)
      .orderBy(desc(conversation_model.last_message_at));

    // Get member counts and participant details for each conversation
    const conversationsWithMembers = await Promise.all(
      conversations.map(async (conv) => {
        const memberCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(conversation_member_model)
          .where(
            and(
              eq(conversation_member_model.conversation_id, conv.conversationId),
              eq(conversation_member_model.deleted, false)
            )
          );

        // For DM conversations, get both participants
        if (conv.type === "dm") {
          const participants = await db
            .select({
              userId: user_model.id,
              userName: user_model.name,
              userProfilePic: user_model.profile_pic,
              userEmail: user_model.email,
            })
            .from(conversation_member_model)
            .innerJoin(
              user_model,
              eq(user_model.id, conversation_member_model.user_id)
            )
            .where(
              and(
                eq(conversation_member_model.conversation_id, conv.conversationId),
                eq(conversation_member_model.deleted, false)
              )
            )
            .limit(2);

          // Determine participant1 (creator) and participant2 (other user)
          const participant1 = participants.find(p => p.userId === conv.createrId) || participants[0];
          const participant2 = participants.find(p => p.userId !== conv.createrId) || participants[1];

          return {
            ...conv,
            memberCount: memberCount[0]?.count || 0,
            participant1: participant1 ? {
              userId: participant1.userId,
              userName: participant1.userName,
              userProfilePic: participant1.userProfilePic,
              userEmail: participant1.userEmail,
            } : null,
            participant2: participant2 ? {
              userId: participant2.userId,
              userName: participant2.userName,
              userProfilePic: participant2.userProfilePic,
              userEmail: participant2.userEmail,
            } : null,
          };
        }

        return {
          ...conv,
          memberCount: memberCount[0]?.count || 0
        };
      })
    );

    return {
      success: true,
      code: 200,
      data: conversationsWithMembers,
    };
  } catch (error) {
    console.error("get_all_conversations_admin error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_all_conversations_admin",
    };
  }
};

const get_conversation_members_admin = async (conversation_id: number) => {
  try {
    const members = await db
      .select({
        userId: user_model.id,
        userName: user_model.name,
        userProfilePic: user_model.profile_pic,
        userEmail: user_model.email,
        role: conversation_member_model.role,
        joinedAt: conversation_member_model.joined_at,
        unreadCount: conversation_member_model.unread_count,
      })
      .from(conversation_member_model)
      .innerJoin(
        user_model,
        eq(user_model.id, conversation_member_model.user_id)
      )
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.deleted, false)
        )
      )
      .orderBy(asc(conversation_member_model.joined_at));

    return {
      success: true,
      code: 200,
      data: members,
    };
  } catch (error) {
    console.error("get_conversation_members_admin error:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_members_admin",
    };
  }
};

const get_conversation_history_admin = async (
  conversation_id: number,
  page: number = 1,
  limit: number = 20
) => {
  try {
    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Get messages with sender information
    const messages = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
        sender_id: message_model.sender_id,
        type: message_model.type,
        body: message_model.body,
        attachments: message_model.attachments,
        metadata: message_model.metadata,
        edited_at: message_model.edited_at,
        created_at: message_model.created_at,
        deleted: message_model.deleted,
        forwarded_from: message_model.forwarded_from,
        forwarded_count: message_model.forwarded_to,

        // Sender information
        senderName: user_model.name,
        senderProfilePic: user_model.profile_pic,
      })
      .from(message_model)
      .leftJoin(
        user_model,
        eq(user_model.id, message_model.sender_id)
      )
      .where(eq(message_model.conversation_id, conversation_id))
      .orderBy(desc(message_model.created_at))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination info
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_model)
      .where(eq(message_model.conversation_id, conversation_id));

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      success: true,
      code: 200,
      data: {
        messages: messages.reverse(), // Reverse to show oldest first
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          limit,
          hasNextPage,
          hasPreviousPage,
        },
      },
    };

  } catch (error) {
    console.error("get_conversation_history_admin error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_conversation_history_admin",
    };
  }
};


export {
  create_chat,
  get_chat_list,
  get_group_info,
  create_group,
  add_new_member,
  remove_member,
  promote_to_admin,
  demote_to_member,
  update_group_title,
  soft_delete_chat,
  hard_delete_chat,
  revive_chat,
  dm_delete_status,
  soft_delete_message,
  hard_delete_message,
  get_conversation_history,
  get_all_conversations_admin,
  get_conversation_members_admin,
  get_conversation_history_admin,
};
