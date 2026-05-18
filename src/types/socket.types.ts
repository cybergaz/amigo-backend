import { ElysiaWS } from "elysia/dist/ws";
import { ChatRoleType, ChatType, MessageType } from "./chat.types";

// WebSocket data interface for type safety
interface WebSocketData {
  user_id?: string;
  user_name?: string;
  // user_pfp?: string;
}

// Transport types for fallback support
type TransportType = 'ws' | 'polling';

// Connection management
interface UserConnection {
  ws: ElysiaWS;
  missed_pings: number;
  active_conv_id?: string;
}

interface PollingConnection {
  connection_status: ConnectionStatusType;
  last_poll_at?: Date;
  client_ip?: string;
  // last_poll_message_id?: string;
  // active_conv_id?: string;
  // connected_at: Date;
}

// Regular WebSocket message with payload
type WSMessage = {
  type: WSMessageEventsType;
  payload?:
  ConnectionStatusPayload
  | ConvJoinPayload
  | NewConversationPayload
  | ChatMessagePayload
  | MessageSentAckPayload
  | MessageStatusAckPayload
  | TypingPayload
  | DeleteMessagePayload
  | MessagePinPayload
  | MessageForwardPayload
  | MessageReactPayload
  | CallPayload
  | MiscPayload
  | ConversationActionPayload
  | UserUpdatePayload
  | ConversationDisappearingPayload;
  // | SyncMessagesPayload
  // | MessageDeliveredPayload;
  ws_timestamp?: Date;
};

// Subset of WSMessage for critical events that must be processed by clients even if they miss some messages (e.g. due to reconnection)
interface VitalWSMessage {
  type: VitalWSMessageEventsType;
  payload:
  ConvJoinPayload
  | NewConversationPayload
  | ChatMessagePayload
  | MessageSentAckPayload
  | MessageStatusAckPayload
  | DeleteMessagePayload
  | MessagePinPayload
  | MessageForwardPayload
  | ConversationActionPayload
  | UserUpdatePayload
  | ConversationDisappearingPayload;
  // | MessageDeliveredPayload;
  ws_timestamp?: Date;
}

const CONNECTION_STATUS_CONST = ['online', 'offline', 'stale'] as const;
type ConnectionStatusType = typeof CONNECTION_STATUS_CONST[number];

type ConnectionStatusPayload = {
  sender_id: string;
  status: ConnectionStatusType;
};

type ConvJoinPayload = {
  conv_id: string;
  user_id: string;
  last_read_msg_id: string;
};

type ChatMessagePayload = {
  id: string;
  conv_id: string;
  sender_id: string;
  msg_type: MessageType;
  body?: string;
  attachments?: any;
  replied_to?: string;
  // Pre-warmed compact preview of the replied-to message so the client can
  // render the reply container on first paint without a local DB lookup.
  replied_to_message?: {
    id: string;
    sender_id: string | null;
    sender_name: string | null;
    type: string;
    body: string | null;
    attachments: unknown;
    sent_at: Date | null;
  } | null;
  sent_at: Date;
  // Set by the server on message:new broadcast when the chat has disappearing
  // messages enabled. Clients use this to filter expired-but-not-yet-deleted
  // rows from the view; the server sweeper is what actually soft-deletes the
  // row and broadcasts message:delete.
  expires_at?: Date | string | null;
};

type MessageSentAckPayload = {
  msg_id: string;
  conv_id: string;
  is_sent: boolean;
  error_code?: number;
  new_id?: string;  // In case of message ID change due to retry or edit
};

type MessageStatusAckPayload = {
  recipient_id: string;
  at: Date;
  acks: {
    chat_id: string;
    msg_ids: string[];
    status: ('delivered' | 'read')[];   // 1 or 2 elements
  }[];
};

// type ChatMessageAckPayload = {
//   msg_id: string;
//   conv_id: string;
//   sender_id: string;
//   is_failed?: boolean;
//   error_code?: number;
//   new_id?: string;  // In case of message ID change due to retry or edit
//   // delivered_at: Date;
//   // delivered_to?: string[];   // optimistic state for DMs (1-element max)
//   // read_by?: string[];        // optimistic state for DMs (1-element max)
// };

type TypingPayload = {
  conv_id: string;
  sender_id: string;
  // is_typing: boolean;
  // sender_name?: string;
  // sender_pfp?: string;
};

type MessagePinPayload = {
  conv_id: string;
  message_id: string;
  message_type: MessageType;
  sender_id: string;
  pin: boolean;
  // sender_name?: string;
  // sender_pfp?: string;
};

type MessageForwardPayload = {
  source_conv_id: string;
  forwarder_id: string;
  forwarder_name?: string;
  forwarded_message_ids: string[];
  target_conv_ids: string[];
};

type DeleteMessagePayload = {
  conv_id: string;
  sender_id: string;
  message_ids: string[];
};

type MessageReactPayload = {
  message_id: string;
  conv_id: string;
  sender_id: string;
  emoji: string;
  action: 'add' | 'remove';
  // sender_name?: string;
};

type NewConversationPayload = {
  conv_id: string;
  conv_type: ChatType;
  title?: string;
  creater_id: string;
  creater_name: string;
  creater_phone: string;
  creater_pfp?: string;
  members?: MembersType[];
  joined_at: Date;
};

type MembersType = {
  user_id: string;
  user_name: string;
  user_pfp?: string;
  role: ChatRoleType;
  joined_at: Date;
};

type CallPayload = {
  call_id?: string;
  caller_id: string;
  caller_name?: string;
  caller_pfp?: string;
  callee_id: string;
  callee_name?: string;
  callee_pfp?: string;
  callType?: 'audio' | 'video';
  data?: any;
  error?: any;
  timestamp?: Date;
};

type MiscPayload = {
  message?: string;
  data?: any;
  code?: number;
  error?: any;
};

type ConversationActionType =
  | 'member_added'
  | 'member_removed'
  | 'member_promoted'
  | 'member_demoted'
  | 'chat_delete'
  // Group title or profile picture changed by an admin. Members carries no
  // entries for this action — title / profile_pic / previous_profile_pic
  // describe the change. Routed through conversation:action so it inherits
  // the existing vital-event storage path for offline-replay.
  | 'chat_details:update';

type ConversationActionPayload = {
  event_id: string;
  conv_id: string;
  conv_type: ChatType;
  action: ConversationActionType;
  members: MembersType[];
  actor_id?: string;
  message: string;
  action_at: Date;
  // chat_details:update fields. Only set when at least one of title /
  // profile_pic changed. profile_pic == null with profile_pic_changed = true
  // means the avatar was cleared.
  title?: string | null;
  profile_pic?: string | null;
  // Previous profile pic URL — clients use it as the cache key to evict the
  // old image from on-disk CachedNetworkImage cache.
  previous_profile_pic?: string | null;
  // Explicit "the pfp column was touched" flag. Needed because both
  // profile_pic == null (cleared) and field-absent (title-only update) would
  // otherwise collapse to the same wire shape.
  profile_pic_changed?: boolean;
  // actor_name?: string;
  // actor_pfp?: string;
};

// Broadcast when a user changes the disappearing-messages duration on a chat.
// duration_sec = null clears the setting (off). Already-sent messages are not
// retroactively touched — only future messages get expires_at stamped.
type ConversationDisappearingPayload = {
  conv_id: string;
  actor_id: string;
  duration_sec: number | null;
  changed_at: Date | string;
};

// Broadcast when a user updates their own profile (name and/or profile pic).
// Sent to every other user that shares a conversation with them so clients
// can refresh local user rows and evict stale CachedNetworkImage entries.
type UserUpdatePayload = {
  user_id: string;
  name?: string;
  profile_pic?: string | null;
  // Previous profile pic URL — included so clients can evict the old asset
  // from the on-disk image cache (keyed by URL).
  previous_profile_pic?: string | null;
  updated_at: Date;
};

// type SyncMessagesPayload = {
//   messages: ChatMessagePayload[];
//   sync_timestamp: Date;
//   total_count: number;
// };

// Delivery receipt payload - sent by recipient when message is delivered via FCM
// type MessageDeliveredPayload = {
//   message_id: string;
//   conv_id: string;
//   sender_id: string;
//   recipient_id: string;
//   delivered_at: Date;
// };

const WS_MESSAGE_EVENTS_CONST = [
  'connection:status',
  'conversation:join',
  // 'conversation:leave',
  'conversation:new',
  'conversation:typing',
  'conversation:action',
  'message:new',
  'message:sent:ack',
  'message:status:ack',
  'message:pin',
  'message:forward',
  'message:delete',
  'message:react',
  'conversation:disappearing',
  // 'message:sync',  // Sync missed messages on reconnection
  // 'message:delivered',  // Delivery receipt from FCM messages
  'call:init',
  'call:init:ack',
  'call:ringing',
  'call:accept',
  'call:offer',
  'call:answer',
  'call:ice',
  'call:terminate',
  'call:hold',
  'call:missed',
  // 'call:decline',
  // 'call:end',
  'call:error',
  'socket:health_check',
  'socket:ping',
  'socket:pong',
  'socket:error',
  'auth:force_logout',
  'user:update',
] as const;

const VITAL_WS_EVENTS_CONST = [
  'conversation:join',
  // 'conversation:leave',
  'conversation:new',
  'conversation:action',
  'message:new',
  'message:sent:ack',
  'message:status:ack',
  'message:pin',
  'message:forward',
  'message:delete',
  'message:react',
  'conversation:disappearing',
  'user:update',
] as const;

const ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD = ['socket:ping', 'socket:pong', 'socket:health_check'] as const;

type WSMessageEventsType = typeof WS_MESSAGE_EVENTS_CONST[number];
type VitalWSMessageEventsType = typeof VITAL_WS_EVENTS_CONST[number];
type AllowedWSEventsWithoutPayloadType = typeof ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD[number];

export {
  WS_MESSAGE_EVENTS_CONST,
  CONNECTION_STATUS_CONST,
  VITAL_WS_EVENTS_CONST,
  ALLOWED_WS_EVENTS_WITHOUT_PAYLOAD
};
export type {
  WebSocketData,
  UserConnection,
  PollingConnection,
  TransportType,
  WSMessage,
  VitalWSMessage,
  ConnectionStatusPayload,
  ConvJoinPayload,
  ChatMessagePayload,
  MessageSentAckPayload,
  MessageStatusAckPayload,
  TypingPayload,
  DeleteMessagePayload,
  MiscPayload,
  NewConversationPayload,
  MembersType,
  MessagePinPayload,
  MessageForwardPayload,
  MessageReactPayload,
  CallPayload,
  ConnectionStatusType,
  ConversationActionPayload,
  UserUpdatePayload,
  ConversationDisappearingPayload,
  // SyncMessageItem,
  // SyncMessagesPayload,
  // MessageDeliveredPayload,
  WSMessageEventsType,
  VitalWSMessageEventsType,
  AllowedWSEventsWithoutPayloadType
};
