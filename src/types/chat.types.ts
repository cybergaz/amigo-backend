const CHAT_TYPE_CONSTS = ["dm", "group", "community_group"] as const;
type ChatType = typeof CHAT_TYPE_CONSTS[number];

const MESSAGE_TYPE_CONSTS = ["text", "image", "video", "audio", "document", "media", "reply", "forwarded", "system", "attachment", "reaction", "contact"] as const;
type MessageType = typeof MESSAGE_TYPE_CONSTS[number];

const MESSAGE_STATUS_CONSTS = ["sent", "delivered", "read"] as const;
type MessageStatusType = typeof MESSAGE_STATUS_CONSTS[number];

const CHAT_ROLE_CONST = ["member", "admin"] as const;
type ChatRoleType = typeof CHAT_ROLE_CONST[number];

// Message operations types
const MESSAGE_OPERATION_CONSTS = ["pin", "star", "reply", "forward", "delete", "react"] as const;
type MessageOperationType = typeof MESSAGE_OPERATION_CONSTS[number];

// Conversation metadata structure
// interface ConversationMetadata {
//   // Pin functionality - only one message can be pinned per conversation
//   pinned_message?: {
//     message_id: string;
//     user_id: string;
//     pinned_at: string;
//   };
//
//   // Other conversation-level metadata
//   [key: string]: any;
// }

// Message metadata structure
// interface MessageMetadata {
//   // Reply functionality
//   reply_to?: {
//     message_id: string;
//     sender_id: string;
//     body?: string; // Preview of original message
//     created_at: string;
//   };
//
//   // Star functionality - array of users who starred
//   starred_by?: Array<{
//     user_id: string;
//     starred_at: string;
//   }>;
//
//   // Forward functionality - track original message info
//   forwarded_from?: {
//     original_message_id: string;
//     original_conversation_id: string;
//     original_sender_id: string;
//     forwarded_by: string;
//     forwarded_at: string;
//   };
//
//   // Edit history
//   edits?: Array<{
//     body: string;
//     edited_at: string;
//   }>;
//
//   // Mentions
//   mentions?: Array<{
//     user_id: string;
//     start_index: number;
//     end_index: number;
//   }>;
//
//   // Emoji reactions - map of emoji -> array of user reactions
//   reactions?: Record<string, Array<{
//     user_id: string;
//     user_name?: string;
//     reacted_at: string;
//   }>>;
//
//   // Other metadata
//   [key: string]: any;
// }

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

// interface StarMessageRequest {
//   message_ids: string[];
//   conversation_id: string;
// }

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

// interface MediaMetadataRequest {
//   conversation_id: string;
//   url: string;
//   key: string;
//   category: string; // e.g. "images", "docs"
//   file_name: string;
//   file_size: number;
//   mime_type: string;
// }

interface ReactMessageRequest {
  message_id: string;
  conversation_id: string;
  emoji: string;
  action: 'add' | 'remove';
}

export { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS, MESSAGE_STATUS_CONSTS, CHAT_ROLE_CONST, MESSAGE_OPERATION_CONSTS };
export type {
  ChatType,
  MessageType,
  ChatRoleType,
  MessageOperationType,
  MessageStatusType,
  // ConversationMetadata,
  // MessageMetadata,
  BulkMessageOperation,
  PinMessageRequest,
  // StarMessageRequest,
  ReplyMessageRequest,
  ForwardMessageRequest,
  DeleteMessageRequest,
  // MediaMetadataRequest,
  ReactMessageRequest
};
