import db from "@/config/db";
import { chat_model, chat_member_model } from "@/models/chat.model";
import { user_model } from "@/models/user.model";
import { ChatMemberStatusType, ChatRoleType, ChatType } from "@/types/chat.types";
import { RoleType } from "@/types/user.types";
import { and, eq, isNull } from "drizzle-orm";

// Single source of truth for "who can do what" in a group. Mirrored on the
// client in lib/ui/chat/group-capabilities.dart — keep the two in lockstep.
//
// Roles in play:
//   - owner            : chats.owner_id (transferable). The only one who can
//                        delete the group / assign admins / transfer ownership
//                        / review join requests (alongside masters).
//   - group admin      : chat_members.role === 'admin' AND active. Can
//                        add/remove/kick members only.
//   - member           : a plain active member. Can leave; nothing else.
//   - staff (global)   : treated EXACTLY like a normal member here.
//   - master (global)  : 'admin' | 'sub_admin' app-level roles. Can do
//                        everything an owner can WITHOUT being a member.
export type GroupCaps = {
  isActive: boolean;
  isOwner: boolean;
  isMaster: boolean;
  isGroupAdmin: boolean;
  canSendMessage: boolean;
  canLeave: boolean;
  canDelete: boolean;
  canManageMembers: boolean; // add / remove / kick
  canPromoteDemote: boolean; // assign / remove the group-admin role
  canTransferOwnership: boolean;
  canManageJoinRequests: boolean;
};

export const compute_group_caps = (args: {
  ownerId: string | null;
  myUserId: string;
  myGroupRole: ChatRoleType | null;
  myStatus: ChatMemberStatusType | null;
  globalRole: RoleType | null;
}): GroupCaps => {
  const { ownerId, myUserId, myGroupRole, myStatus, globalRole } = args;

  const isMaster = globalRole === "admin" || globalRole === "sub_admin";
  const isActive = myStatus === "active";
  const isOwner = !!ownerId && myUserId === ownerId;
  const isGroupAdmin = isActive && myGroupRole === "admin";

  // add/remove/kick: owner, master, or an active group admin.
  const canManageMembers = isOwner || isMaster || isGroupAdmin;
  // assigning admins, transferring ownership, deleting, reviewing join
  // requests: owner or master only — never a plain group admin or staff.
  const ownerOrMaster = isOwner || isMaster;

  return {
    isActive,
    isOwner,
    isMaster,
    isGroupAdmin,
    canSendMessage: isActive,
    canLeave: isActive,
    canDelete: ownerOrMaster,
    canManageMembers,
    canPromoteDemote: ownerOrMaster,
    canTransferOwnership: ownerOrMaster,
    canManageJoinRequests: ownerOrMaster,
  };
};

// Loads everything compute_group_caps needs for a (chat, actor) pair in two
// cheap indexed lookups + the actor's global role. `exists` is false when the
// chat row is missing; `membership` is null for a master who isn't a member.
export const load_group_actor_context = async (
  chat_id: string,
  user_id: string,
): Promise<{
  exists: boolean;
  type: ChatType | null;
  ownerId: string | null;
  createrId: string | null;
  deletedAt: Date | null;
  role: ChatRoleType | null;
  status: ChatMemberStatusType | null;
  globalRole: RoleType | null;
}> => {
  const [chat] = await db
    .select({
      type: chat_model.type,
      owner_id: chat_model.owner_id,
      creater_id: chat_model.creater_id,
      deleted_at: chat_model.deleted_at,
    })
    .from(chat_model)
    .where(eq(chat_model.id, chat_id))
    .limit(1);

  // Groups never set removed_at (left/pending keep it NULL), so this returns the
  // single live row for the actor regardless of their status.
  const [membership] = await db
    .select({ role: chat_member_model.role, status: chat_member_model.status })
    .from(chat_member_model)
    .where(
      and(
        eq(chat_member_model.chat_id, chat_id),
        eq(chat_member_model.user_id, user_id),
        isNull(chat_member_model.removed_at),
      ),
    )
    .limit(1);

  const [user] = await db
    .select({ role: user_model.role })
    .from(user_model)
    .where(eq(user_model.id, user_id))
    .limit(1);

  return {
    exists: !!chat,
    type: (chat?.type as ChatType) ?? null,
    ownerId: chat?.owner_id ?? null,
    createrId: chat?.creater_id ?? null,
    deletedAt: chat?.deleted_at ?? null,
    role: (membership?.role as ChatRoleType) ?? null,
    status: (membership?.status as ChatMemberStatusType) ?? null,
    globalRole: (user?.role as RoleType) ?? null,
  };
};
