const CHAT_TYPE_CONSTS = ["dm", "group", "community_group"] as const;
type ChatType = typeof CHAT_TYPE_CONSTS[number];

const MESSAGE_TYPE_CONSTS = ["text", "image", "video", "audio", "document", "media", "reply", "forwarded", "system", "attachment", "reaction"] as const;
type MessageType = typeof MESSAGE_TYPE_CONSTS[number];

const MESSAGE_STATUS_CONSTS = ["sent", "delivered", "read"] as const;
type MessageStatusType = typeof MESSAGE_STATUS_CONSTS[number];

const CHAT_ROLE_CONST = ["member", "admin"] as const;
type ChatRoleType = typeof CHAT_ROLE_CONST[number];

// Message operations types
const MESSAGE_OPERATION_CONSTS = ["pin", "star", "reply", "forward", "delete"] as const;
type MessageOperationType = typeof MESSAGE_OPERATION_CONSTS[number];

// Conversation metadata structure
interface ConversationMetadata {
  // Pin functionality - only one message can be pinned per conversation
  pinned_message?: {
    message_id: number;
    user_id: number;
    pinned_at: string;
  };

  // Other conversation-level metadata
  [key: string]: any;
}

// Message metadata structure
interface MessageMetadata {
  // Reply functionality
  reply_to?: {
    message_id: number;
    sender_id: number;
    body?: string; // Preview of original message
    created_at: string;
  };

  // Star functionality - array of users who starred
  starred_by?: Array<{
    user_id: number;
    starred_at: string;
  }>;

  // Forward functionality - track original message info
  forwarded_from?: {
    original_message_id: number;
    original_conversation_id: number;
    original_sender_id: number;
    forwarded_by: number;
    forwarded_at: string;
  };

  // Edit history
  edits?: Array<{
    body: string;
    edited_at: string;
  }>;

  // Mentions
  mentions?: Array<{
    user_id: number;
    start_index: number;
    end_index: number;
  }>;

  // Other metadata
  [key: string]: any;
}

// Request types for bulk operations
interface BulkMessageOperation {
  message_ids: number[];
  operation: MessageOperationType;
  conversation_id: number;
}

interface PinMessageRequest {
  message_id: number;
  conv_id: number;
  user_id: number;
}

interface StarMessageRequest {
  message_ids: number[];
  conversation_id: number;
}

interface ReplyMessageRequest {
  reply_to_message_id: number;
  conversation_id: number;
  body: string;
  attachments?: any[];
}

interface ForwardMessageRequest {
  message_ids: number[];
  source_conversation_id: number;
  target_conversation_ids: number[];
}

interface DeleteMessageRequest {
  message_ids: number[];
  conversation_id: number;
  // delete_for_everyone?: boolean; // true = delete for all, false = delete for me only
}

interface MediaMetadataRequest {
  conversation_id: number;
  url: string;
  key: string;
  category: string; // e.g. "images", "docs"
  file_name: string;
  file_size: number;
  mime_type: string;
}


export { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS, MESSAGE_STATUS_CONSTS, CHAT_ROLE_CONST, MESSAGE_OPERATION_CONSTS };
export type {
  ChatType,
  MessageType,
  ChatRoleType,
  MessageOperationType,
  MessageStatusType,
  ConversationMetadata,
  MessageMetadata,
  BulkMessageOperation,
  PinMessageRequest,
  StarMessageRequest,
  ReplyMessageRequest,
  ForwardMessageRequest,
  DeleteMessageRequest,
  MediaMetadataRequest
};
