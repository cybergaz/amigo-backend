import db from "@/config/db";
import {
  conversation_model,
  conversation_member_model,
  message_model,
  message_status_model,
  DBUpdateConversationType,
} from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import user_routes from "@/routes/user.routes";
import {
  ChatRoleType,
  ChatType,
  ConversationMetadata,
} from "@/types/chat.types";
import { create_dm_key, create_unique_id } from "@/utils/general.utils";
import { and, arrayContains, asc, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { redis } from "@/config/redis";
import { broadcast_message } from "@/sockets/socket.handlers";
import { ConversationActionPayload, DeleteMessagePayload, NewConversationPayload, MembersType } from "@/types/socket.types";
import { socket_connections } from "@/sockets/socket.server";
import { get_user_details } from "./user.services";
import { get_conversation_members } from "@/sockets/socket.cache";
import { status } from "elysia";

const build_conversation_action_message = (
  action: ConversationActionPayload["action"],
  members: MembersType[],
) => {
  const names = members.map((m) => m.user_name).filter(Boolean);
  const target = names.length ? names.join(", ") : "Member";

  switch (action) {
    case "member_added":
      return `${target} added`;
    case "member_removed":
      return `${target} removed`;
    case "member_promoted":
      return `${target} promoted to admin`;
    case "member_demoted":
      return `${target} demoted to member`;
    default:
      return target;
  }
};

const broadcast_conversation_action = async (data: {
  conv_id: number;
  conv_type: ChatType;
  action: ConversationActionPayload["action"];
  members: MembersType[];
  actor_id?: number;
  actor_name?: string;
  actor_pfp?: string;
}) => {
  if (!data.members.length) return;

  const action_at = new Date();
  const payload: ConversationActionPayload = {
    event_id: create_unique_id(),
    conv_id: data.conv_id,
    conv_type: data.conv_type,
    action: data.action,
    members: data.members,
    actor_id: data.actor_id,
    actor_name: data.actor_name,
    actor_pfp: data.actor_pfp,
    message: build_conversation_action_message(data.action, data.members),
    action_at,
  };

  await broadcast_message({
    to: "conversation",
    conv_id: data.conv_id,
    message: {
      type: "conversation:action",
      payload,
      ws_timestamp: action_at,
    },
  });
};

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

    if (existingChat.length > 0) {
      return {
        success: true,
        code: 200,
        data: {
          id: existingChat[0].conversation_id,
          existing: true
        },
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

    // // -----------------------------------------------------------------------------------
    // // TEMPORARY HACK FOR THAT FIRST MESSAGE DISSAPPEAR ISSUE
    // // -----------------------------------------------------------------------------------
    // await db.insert(message_model).values({
    //   conversation_id: chat.id,
    //   sender_id: sender_id,
    //   type: "system",
    //   body: "chat initiated",
    // });
    // // await db.insert(message_model).values({
    // //   conversation_id: chat.id,
    // //   sender_id: sender_id,
    // //   type: "system",
    // //   body: "chat initiated 2",
    // // });
    // // -----------------------------------------------------------------------------------
    // // TEMPORARY HACK FOR THAT FIRST MESSAGE DISSAPPEAR ISSUE
    // // -----------------------------------------------------------------------------------

    // Send notification to receiver about new DM
    try {
      // Get sender info for notification
      const [sender] = await db
        .select({ name: user_model.name, phone: user_model.phone, profile_pic: user_model.profile_pic })
        .from(user_model)
        .where(eq(user_model.id, sender_id))
        .limit(1);

      if (sender) {
        // update redis entries
        const redis_key = `conv:${chat.id}:members`;
        const new_members_id = [receiver_id, sender_id].map(id => id.toString());
        await redis.sadd(redis_key, ...new_members_id);

        // Invalidate conversation lru cache in other services
        await redis.publish("conv:invalidate", chat.id.toString());

        // mark the creater as active in conversation in socket connection if online
        const conn = socket_connections.get(sender_id)
        if (conn && conn.ws.readyState === 1) {
          conn.active_conv_id = chat.id;
        }

        // Prepare payload and broadcast to online users about new conversation
        const new_conversation_payload: NewConversationPayload = {
          conv_id: chat.id,
          conv_type: "dm",
          creater_id: sender_id,
          creater_name: sender.name,
          creater_phone: sender.phone || "",
          creater_pfp: sender.profile_pic || undefined,
          joined_at: new Date(),
        }

        // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        await broadcast_message({
          to: "users",
          user_ids: [receiver_id],
          message: {
            type: "conversation:new",
            payload: new_conversation_payload,
            ws_timestamp: new Date()
          },
        })
      }
    } catch (error) {
      console.error('Error sending conversation_added notification for DM:', error);
      // Don't fail the request if notification fails
    }

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
        createrId: conversation_model.creater_id,

        role: conversation_member_model.role,
        unreadCount: conversation_member_model.unread_count,
        joinedAt: conversation_member_model.joined_at,

        // from user_model - for DMs, this will be the other user
        userId: user_model.id,
        userName: user_model.name,
        userPhone: user_model.phone,
        userProfilePic: user_model.profile_pic,
        onlineStatus: user_model.online_status,
        lastSeen: user_model.last_seen,
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
          type !== "all" ?
            type === "group"
              ? eq(conversation_model.type, "group")
              : type === "community_group"
                ? eq(conversation_model.type, "community_group")
                : type === "deleted_dm"
                  ? and(eq(conversation_model.type, "dm"), eq(conversation_member_model.deleted, true))
                  : and(eq(conversation_model.type, "dm"), eq(conversation_member_model.deleted, false))
            : eq(conversation_model.deleted, false),
          eq(conversation_model.deleted, false),
        )
      )
      .orderBy(
        desc(conversation_model.last_message_at),
        // desc(conversation_member_model.joined_at),
      )

    // For groups and community groups, we don't need the other user info
    // For DMs, we need to get the other user's info separately
    const processedChats = await Promise.all(
      chats.map(async (chat) => {
        let final_chat_item: any;
        if (chat.type === "dm" && !chat.userId) {
          // Get the other user for DM
          const [otherUser] = await db
            .select({
              userId: user_model.id,
              userName: user_model.name,
              userPhone: user_model.phone,
              userProfilePic: user_model.profile_pic,
              onlineStatus: user_model.online_status,
              lastSeen: user_model.last_seen,
            })
            .from(conversation_member_model)
            .innerJoin(user_model, eq(user_model.id, conversation_member_model.user_id))
            .where(
              and(
                eq(conversation_member_model.conversation_id, chat.conversationId),
                ne(conversation_member_model.user_id, user_id)
              )
            );

          final_chat_item = {
            ...chat,
            userId: otherUser?.userId || null,
            userName: otherUser?.userName || null,
            userPhone: otherUser?.userPhone || null,
            userProfilePic: otherUser?.userProfilePic || null,
            onlineStatus: otherUser?.onlineStatus || false,
            lastSeen: otherUser?.lastSeen || null,
          };
        }

        // For groups and community groups, clear user info since it's not relevant
        if (chat.type === "group" || chat.type === "community_group") {
          const userMemberInfo = (await db
            .select({
              role: conversation_member_model.role,
              joinedAt: conversation_member_model.joined_at,
              unreadCount: conversation_member_model.unread_count
            })
            .from(conversation_member_model)
            .where(and(
              eq(conversation_member_model.conversation_id, chat.conversationId),
              eq(conversation_member_model.user_id, user_id)
            )))[0]

          final_chat_item = {
            ...chat,
            userId: null,
            userName: null,
            userPhone: null,
            onlineStatus: false,
            lastSeen: null,
            userProfilePic: null,
            userRole: userMemberInfo?.role || null,
            userJoinedAt: userMemberInfo?.joinedAt || null,
            userUnreadCount: userMemberInfo?.unreadCount || 0,
          };
        }

        if (chat.metadata !== null) {
          const metadata = chat.metadata as any;

          // if last_message exists in metadata, extract it if pinned message available append it as well
          if (metadata.last_message != null) {
            final_chat_item = {
              ...final_chat_item,
              lastMessageId: metadata.last_message.id,
              lastMessageBody: metadata.last_message.body,
              lastMessageType: metadata.last_message.type,
            }
          }

          if (metadata.pinned_message != null) {
            final_chat_item = {
              ...final_chat_item,
              pinnedMessageId: metadata.pinned_message.message_id,
            }
          }
        }

        return final_chat_item;
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

const update_conversation = async (conv_data: DBUpdateConversationType) => {
  try {
    if (!conv_data.id) {
      return {
        success: false,
        code: 400,
        message: "Conversation ID is required for update",
      }
    }

    if (conv_data.metadata) {
      // Update conversation's last_message_at and last_message in metadata
      const [conversation] = await db
        .select({ metadata: conversation_model.metadata })
        .from(conversation_model)
        .where(eq(conversation_model.id, conv_data.id))
        .limit(1);

      if (conversation) {
        const currentMetadata = (conversation.metadata as ConversationMetadata) || {};

        conv_data.metadata = {
          ...currentMetadata,
          ...conv_data.metadata
        } as ConversationMetadata;
      }
    }

    const [updated_conversation] = await db
      .update(conversation_model)
      .set(conv_data)
      .where(eq(conversation_model.id, conv_data.id))

    return {
      success: true,
      code: 200,
      message: "Conversation updated successfully",
      data: updated_conversation,
    }


  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : update_conversation",
    }
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
    const redis_key = `chat:${conversation_id}:members`;
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

const soft_delete_message = async (message_ids: number[], user_id: number, is_admin_or_staff?: boolean) => {
  try {
    // console.log("soft_delete_message called with:", { message_ids, user_id, is_admin_or_staff });

    // First, get the messages to retrieve conversation_id and check if they exist
    const messagesToDelete = await db
      .select({
        id: message_model.id,
        conversation_id: message_model.conversation_id,
      })
      .from(message_model)
      .where(and(
        inArray(message_model.id, message_ids),
        eq(message_model.deleted, false),
        !is_admin_or_staff ? eq(message_model.sender_id, user_id) : undefined,
      ));

    if (messagesToDelete.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Either message not found or you do not own this message",
        data: { message_id: message_ids, deleted: false },
      };
    }

    // Get unique conversation IDs (filter out null values)
    const conversationIds = [...new Set(messagesToDelete.map(m => m.conversation_id).filter((id): id is number => id !== null))];

    // Delete the messages
    const deletedMessages = await db
      .update(message_model)
      .set({ deleted: true })
      .where(and(
        inArray(message_model.id, message_ids),
        eq(message_model.deleted, false),
        !is_admin_or_staff ? eq(message_model.sender_id, user_id) : undefined,
      ))
      .returning();

    if (!deletedMessages || deletedMessages.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Either message not found or you do not own this message",
        data: { message_id: message_ids, deleted: false },
      };
    }

    // Broadcast delete event to each conversation
    for (const conversationId of conversationIds) {
      const messagesInConversation = messagesToDelete.filter(m => m.conversation_id === conversationId);

      // Broadcast delete event
      const message_payload: DeleteMessagePayload = {
        sender_id: user_id,
        conv_id: conversationId,
        message_ids: messagesInConversation.map(m => m.id),
      };
      // >>>>>-- broadcasting -->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      await broadcast_message({
        to: "conversation",
        conv_id: conversationId,
        message: {
          type: "message:delete",
          payload: message_payload,
          ws_timestamp: new Date()
        },
        exclude_user_ids: [user_id]
      });

      // Check if any deleted message was the last_message and update if needed
      const [conversation] = await db
        .select()
        .from(conversation_model)
        .where(eq(conversation_model.id, conversationId))
        .limit(1);

      if (conversation && conversation.metadata) {
        const metadata = conversation.metadata as any;
        const lastMessage = metadata.last_message;

        // Check if the deleted message was the last_message
        if (lastMessage && messagesInConversation.some(m => m.id === lastMessage.id)) {
          // Get the new last message (non-deleted)
          const [newLastMessage] = await db
            .select()
            .from(message_model)
            .where(
              and(
                eq(message_model.conversation_id, conversationId),
                eq(message_model.deleted, false)
              )
            )
            .orderBy(desc(message_model.created_at))
            .limit(1);

          // Update conversation metadata with new last_message or null if no messages left
          await db
            .update(conversation_model)
            .set({
              metadata: newLastMessage ? {
                last_message: {
                  id: newLastMessage.id,
                  conversation_id: newLastMessage.conversation_id,
                  sender_id: newLastMessage.sender_id,
                  type: newLastMessage.type,
                  body: newLastMessage.body,
                  attachments: newLastMessage.attachments,
                  metadata: newLastMessage.metadata,
                  created_at: newLastMessage.created_at.toISOString(),
                }
              } : { last_message: null },
              last_message_at: newLastMessage ? newLastMessage.created_at : conversation.last_message_at
            })
            .where(eq(conversation_model.id, conversationId));
        }
      }
    }

    return {
      success: true,
      code: 200,
      message: "Messages marked as deleted successfully",
      data: deletedMessages
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
  limit: number = 100
) => {
  try {
    // First, verify user is a member of this conversation
    const members = await db
      .select({
        user_id: conversation_member_model.user_id,
        name: user_model.name,
        phone: user_model.phone,
        user_role: user_model.role,
        group_role: conversation_member_model.role,
        profile_pic: user_model.profile_pic,
        joining_date: conversation_member_model.joined_at,
        last_read_message_id: conversation_member_model.last_read_message_id,
        lasthistory_delivered_message_id: conversation_member_model.last_delivered_message_id,
        is_online: user_model.online_status,
        connection_status: user_model.connection_status,
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

    const user_details = members.find(m => m.user_id === user_id);
    if (!user_details) {
      return {
        success: false,
        code: 404,
        message: "User not found",
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
        sent_at: message_model.sent_at,
        created_at: message_model.created_at,
        status: message_model.status,
        deleted: message_model.deleted,
        forwarded_from: message_model.forwarded_from,
        forwarded_count: message_model.forwarded_to,

        // Sender information
        sender_name: user_model.name,
        sender_profile_pic: user_model.profile_pic,
      })
      .from(message_model)
      .innerJoin(
        user_model,
        eq(user_model.id, message_model.sender_id)
      )
      .where(
        and(
          or(
            eq(message_model.conversation_id, conversation_id),
            arrayContains(message_model.forwarded_to, [conversation_id]),
          ),
          or(
            // and(
            //   eq(message_model.sender_id, user_id),
            //   eq(message_model.deleted, false)
            // ),
            // ne(message_model.sender_id, user_id),
            eq(message_model.deleted, false),
            // user_details.user_role === "admin" || user_details.user_role === "staff" ? undefined : eq(message_model.deleted, false)
          ),
          user_details.joining_date ? gt(message_model.created_at, user_details.joining_date) : undefined
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

const get_message_statuses = async (
  conversation_id: number,
  user_id: number,
  page: number = 1,
  limit: number = 1000
) => {
  try {
    // First, verify user is a member of this conversation
    const [member] = await db
      .select({
        user_id: conversation_member_model.user_id,
      })
      .from(conversation_member_model)
      .where(
        and(
          eq(conversation_member_model.conversation_id, conversation_id),
          eq(conversation_member_model.user_id, user_id),
          eq(conversation_member_model.deleted, false)
        )
      )
      .limit(1);

    if (!member) {
      return {
        success: false,
        code: 403,
        message: "You are not a member of this conversation",
      };
    }

    // Calculate offset for pagination
    const offset = (page - 1) * limit;

    // Get all message statuses for this conversation
    // This includes statuses for all users in the conversation
    const statuses = await db
      .select()
      .from(message_status_model)
      .where(
        and(
          eq(message_status_model.conv_id, conversation_id)
        )
      )
      .orderBy(desc(message_status_model.updated_at))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination info
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(message_status_model)
      .where(eq(message_status_model.conv_id, conversation_id));

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      success: true,
      code: 200,
      data: {
        statuses,
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
    console.error("get_message_statuses error", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : get_message_statuses",
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
        user_role: user_model.role
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
        sent_at: message_model.sent_at,
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

// Helper function to get conversation details for a specific user
// Returns data in the same format as get_chat_list for consistency
const getConversationDetailsForUser = async (conversation_id: number, user_id: number) => {
  try {
    const [chat] = await db
      .select({
        conversationId: conversation_model.id,
        type: conversation_model.type,
        title: conversation_model.title,
        metadata: conversation_model.metadata,
        lastMessageAt: conversation_model.last_message_at,
        role: conversation_member_model.role,
        unreadCount: conversation_member_model.unread_count,
        joinedAt: conversation_member_model.joined_at,
        userId: user_model.id,
        userName: user_model.name,
        userPhone: user_model.phone,
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
          ne(user_model.id, user_id)
        )
      )
      .where(
        and(
          eq(conversation_model.id, conversation_id),
          eq(conversation_member_model.user_id, user_id)
        )
      )
      .limit(1);

    if (!chat) return null;

    // For DMs, get the other user's info

    let final_chat_item: any;

    if (chat.type === "dm" && !chat.userId) {
      const [otherUser] = await db
        .select({
          userId: user_model.id,
          userName: user_model.name,
          userPhone: user_model.phone,
          onlineStatus: user_model.online_status,
          lastSeen: user_model.last_seen,
          userProfilePic: user_model.profile_pic,
        })
        .from(conversation_member_model)
        .innerJoin(user_model, eq(user_model.id, conversation_member_model.user_id))
        .where(
          and(
            eq(conversation_member_model.conversation_id, conversation_id),
            ne(conversation_member_model.user_id, user_id)
          )
        )
        .limit(1);

      final_chat_item = {
        ...chat,
        userId: otherUser?.userId || null,
        userName: otherUser?.userName || null,
        userPhone: otherUser?.userPhone || null,
        onlineStatus: otherUser?.onlineStatus || "offline",
        lastSeen: otherUser?.lastSeen || null,
        userProfilePic: otherUser?.userProfilePic || null,
      };
    }

    // For groups, clear user info
    if (chat.type === "group" || chat.type === "community_group") {
      // Also get group members for groups
      const members = await db
        .select({
          userId: user_model.id,
          userName: user_model.name,
          userPhone: user_model.phone,
          userProfilePic: user_model.profile_pic,
          role: conversation_member_model.role,
          joinedAt: conversation_member_model.joined_at,
        })
        .from(conversation_member_model)
        .innerJoin(user_model, eq(user_model.id, conversation_member_model.user_id))
        .where(eq(conversation_member_model.conversation_id, conversation_id))
        .orderBy(asc(conversation_member_model.joined_at));

      final_chat_item = {
        ...chat,
        userId: null,
        userName: null,
        userPhone: null,
        onlineStatus: "offline",
        lastSeen: null,
        userProfilePic: null,
        members: members.map(m => ({
          userId: m.userId,
          name: m.userName,
          profilePic: m.userProfilePic,
          role: m.role,
          joinedAt: m.joinedAt,
        })),
      };
    }

    if (chat.metadata !== null) {
      const metadata = chat.metadata as any;

      // if last_message exists in metadata, extract it if pinned message available append it as well
      if (metadata.last_message != null) {
        final_chat_item = {
          ...final_chat_item,
          lastMessageId: metadata.last_message.id,
          lastMessageBody: metadata.last_message.body,
          lastMessageType: metadata.last_message.type,
        }
      }

      if (metadata.pinned_message != null) {
        final_chat_item = {
          ...final_chat_item,
          pinnedMessageId: metadata.pinned_message.message_id,
        }
      }
    }

    return final_chat_item;
  } catch (error) {
    console.error('Error getting conversation details:', error);
    return null;
  }
};


export {
  create_chat,
  get_chat_list,
  get_group_info,
  create_group,
  update_conversation,
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
  get_message_statuses,
  get_all_conversations_admin,
  get_conversation_members_admin,
  get_conversation_history_admin,
  getConversationDetailsForUser,
  get_group_admin_info,
};
