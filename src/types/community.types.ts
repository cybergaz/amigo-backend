// Community role constants
const COMMUNITY_ROLE_CONST = ["member", "admin", "super_admin"] as const;
type CommunityRoleType = typeof COMMUNITY_ROLE_CONST[number];

// Time slot interface for group restrictions
interface TimeSlot {
  start_time: string; // Format: "HH:MM" (24-hour format)
  end_time: string;   // Format: "HH:MM" (24-hour format)
}

// Community group metadata structure for time restrictions
interface CommunityGroupMetadata {
  // Time restrictions for when the group is active
  active_time_slots?: TimeSlot[];
  
  // Timezone for the time slots (default to UTC if not specified)
  timezone?: string;
  
  // Days of week when group is active (0 = Sunday, 6 = Saturday)
  active_days?: number[];
  
  // Community-specific settings
  community_id?: number;
  
  // Other group-level metadata
  [key: string]: any;
}

// Extended conversation metadata to include community groups
interface ExtendedConversationMetadata {
  // Existing pinned message functionality
  pinned_message?: {
    message_id: number;
    user_id: number;
    pinned_at: string;
  };

  // Community group specific metadata
  community_group?: CommunityGroupMetadata;

  // Other conversation-level metadata
  [key: string]: any;
}

// Request types for community operations
interface CreateCommunityRequest {
  name: string;
  description?: string;
  metadata?: any;
}

interface UpdateCommunityRequest {
  name?: string;
  description?: string;
  metadata?: any;
}

interface CreateCommunityGroupRequest {
  community_id: number;
  title: string;
  active_time_slots: TimeSlot[];
  timezone?: string;
  active_days?: number[];
  member_ids?: number[];
}

interface UpdateCommunityGroupRequest {
  conversation_id: number;
  title?: string;
  active_time_slots?: TimeSlot[];
  timezone?: string;
  active_days?: number[];
}

interface AddCommunityMemberRequest {
  community_id: number;
  user_ids: number[];
  role?: CommunityRoleType;
}

interface RemoveCommunityMemberRequest {
  community_id: number;
  user_ids: number[];
}

interface UpdateCommunityMemberRoleRequest {
  community_id: number;
  user_id: number;
  role: CommunityRoleType;
}

interface AddCommunityGroupRequest {
  community_id: number;
  group_ids: number[];
}

interface RemoveCommunityGroupRequest {
  community_id: number;
  group_ids: number[];
}

// Response types
interface CommunityWithMembers {
  id: number;
  name: string;
  description?: string;
  super_admin_id: number;
  metadata?: any;
  created_at: string;
  updated_at: string;
  member_count: number;
  group_count: number;
}

interface CommunityGroupWithDetails {
  id: number;
  title: string;
  community_id: number;
  active_time_slots: TimeSlot[];
  timezone?: string;
  active_days?: number[];
  member_count: number;
  created_at: string;
  last_message_at?: string;
}

export { COMMUNITY_ROLE_CONST };
export type {
  CommunityRoleType,
  TimeSlot,
  CommunityGroupMetadata,
  ExtendedConversationMetadata,
  CreateCommunityRequest,
  UpdateCommunityRequest,
  CreateCommunityGroupRequest,
  UpdateCommunityGroupRequest,
  AddCommunityMemberRequest,
  RemoveCommunityMemberRequest,
  UpdateCommunityMemberRoleRequest,
  AddCommunityGroupRequest,
  RemoveCommunityGroupRequest,
  CommunityWithMembers,
  CommunityGroupWithDetails
};
