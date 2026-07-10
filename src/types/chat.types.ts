const CHAT_TYPE_CONSTS = ["dm", "group", "community_group"] as const;
type ChatType = typeof CHAT_TYPE_CONSTS[number];

const MESSAGE_TYPE_CONSTS = ["text", "image", "video", "audio", "document", "media", "reply", "forwarded", "system", "attachment", "reaction", "contact"] as const;
type MessageType = typeof MESSAGE_TYPE_CONSTS[number];

const MESSAGE_STATUS_CONSTS = ["sent", "delivered", "read"] as const;
type MessageStatusType = typeof MESSAGE_STATUS_CONSTS[number];

const CHAT_ROLE_CONST = ["member", "admin"] as const;
type ChatRoleType = typeof CHAT_ROLE_CONST[number];

// Per-group membership lifecycle. "active" is the only role that can send /
// receive / read. "left" = voluntarily left OR kicked by an admin (collapsed
// into one state); the row is KEPT (removed_at stays NULL) so the chat still
// shows in the user's list as a read-only shell with an "ask to join" action.
// "pending" = the user has requested to (re)join and is awaiting owner approval.
// INVARIANT: left/pending rows keep removed_at IS NULL, so every membership
// gate must check `removed_at IS NULL AND status = 'active'`, not removed_at alone.
const CHAT_MEMBER_STATUS_CONST = ["active", "left", "pending"] as const;
type ChatMemberStatusType = typeof CHAT_MEMBER_STATUS_CONST[number];

// Message operations types
const MESSAGE_OPERATION_CONSTS = ["pin", "star", "reply", "forward", "delete", "react"] as const;
type MessageOperationType = typeof MESSAGE_OPERATION_CONSTS[number];


// Request types for bulk operations
interface BulkMessageOperation {
  message_ids: string[];
  operation: MessageOperationType;
  conversation_id: string;
}

interface PinMessageRequest {
  message_id: string;
  conv_id: string;
  user_id: string;
}

interface ReplyMessageRequest {
  message_id: string;
  reply_to_message_id: string;
  conversation_id: string;
  body: string;
  attachments?: any[];
}

interface ForwardMessageRequest {
  message_ids: string[];
  source_conversation_id: string;
  target_conversation_ids: string[];
}

interface DeleteMessageRequest {
  message_ids: string[];
  conversation_id: string;
}

interface ReactMessageRequest {
  message_id: string;
  conversation_id: string;
  emoji: string;
  action: 'add' | 'remove';
}

export { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS, MESSAGE_STATUS_CONSTS, CHAT_ROLE_CONST, CHAT_MEMBER_STATUS_CONST, MESSAGE_OPERATION_CONSTS };
export type {
  ChatType,
  MessageType,
  ChatRoleType,
  ChatMemberStatusType,
  MessageOperationType,
  MessageStatusType,
  BulkMessageOperation,
  PinMessageRequest,
  ReplyMessageRequest,
  ForwardMessageRequest,
  DeleteMessageRequest,
  ReactMessageRequest
};
