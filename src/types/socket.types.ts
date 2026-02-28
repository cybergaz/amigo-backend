import { ElysiaWS } from "elysia/dist/ws";
import { ChatRoleType, ChatType, MessageStatusType, MessageType } from "./chat.types";


// WebSocket data interface for type safety
interface WebSocketData {
  user_id?: number;
  user_name?: string;
  user_pfp?: string;
}

// Transport types for fallback support
type TransportType = 'ws' | 'polling';

// Connection management
interface UserConnection {
  ws: ElysiaWS;
  connection_status: ConnectionStatusType;
  active_conv_id?: number;
  // transport_type: TransportType;
  last_ping_sent?: Date;
  last_pong_received?: Date;
  missed_pings: number;
  // last_poll?: Date;
  // last_poll_message_id?: bigint;
  connected_at: Date;
  client_ip?: string;
}

interface PollingConnection {
  // transport_type: TransportType;
  connection_status: ConnectionStatusType;
  active_conv_id?: number;
  last_poll?: Date;
  last_poll_message_id?: bigint;
  connected_at: Date;
  client_ip?: string;
}

// Regular WebSocket message with payload
type WSMessage = {
  type: WSMessageEventsType;
  payload?: ConnectionStatusPayload
  | JoinLeavePayload
  | NewConversationPayload
  | ChatMessagePayload
  | ChatMessageAckPayload
  | TypingPayload
  | DeleteMessagePayload
  | MessagePinPayload
  | MessageForwardPayload
  | CallPayload
  | MiscPayload
  | ConversationActionPayload
  | SyncMessagesPayload
  | MessageDeliveredPayload;
  ws_timestamp?: Date;
};

// Subset of WSMessage for critical events that must be processed by clients even if they miss some messages (e.g. due to reconnection)
interface VitalWSMessage {
  type: VitalWSMessageEventsType;
  payload:
  NewConversationPayload
  | ChatMessagePayload
  | ChatMessageAckPayload
  | DeleteMessagePayload
  | MessagePinPayload
  | MessageForwardPayload
  | ConversationActionPayload
  | MessageDeliveredPayload;
  ws_timestamp?: Date;
}

const CONNECTION_STATUS_CONST = ['foreground', 'background', 'disconnected', 'stale'] as const;
type ConnectionStatusType = typeof CONNECTION_STATUS_CONST[number];

type ConnectionStatusPayload = {
  sender_id: number;
  status: ConnectionStatusType;
};

type JoinLeavePayload = {
  conv_id: number;
  conv_type: ChatType;
  user_id: number;
  user_name?: string;
};

type ChatMessagePayload = {
  id: bigint;
  sender_id: number;
  sender_name?: string;
  conv_id: number;
  conv_type: ChatType;
  msg_type: MessageType;
  body?: string;
  attachments?: any;
  metadata?: any;
  reply_to_message_id?: bigint;
  sent_at: Date;
};

type ChatMessageAckPayload = {
  id: bigint;
  conv_id: number;
  sender_id: number;
  delivered_at: Date;
  delivered_to?: number[];
  read_by?: number[];
  offline_users?: number[];
  is_failed?: boolean;
  error_code?: number;
  new_id?: bigint;  // In case of message ID change due to retry or edit
};

type TypingPayload = {
  conv_id: number;
  sender_id: number;
  sender_name?: string;
  sender_pfp?: string;
  is_typing: boolean;
};

type MessagePinPayload = {
  conv_id: number;
  message_id: bigint;
  message_type: MessageType;
  sender_id: number;
  sender_name?: string;
  sender_pfp?: string;
  pin: boolean;
};

type MessageForwardPayload = {
  source_conv_id: number;
  forwarder_id: number;
  forwarder_name?: string;
  forwarded_message_ids: bigint[];
  target_conv_ids: number[];
};

type DeleteMessagePayload = {
  conv_id: number;
  sender_id: number;
  message_ids: bigint[];
};

type NewConversationPayload = {
  conv_id: number;
  conv_type: ChatType;
  title?: string;
  creater_id: number;
  creater_name: string;
  creater_phone: string;
  creater_pfp?: string;
  members?: MembersType[];
  joined_at: Date;
};

type MembersType = {
  user_id: number;
  user_name: string;
  user_pfp?: string;
  role: ChatRoleType;
  joined_at: Date;
};

type CallPayload = {
  call_id?: number;
  caller_id: number;
  caller_name?: string;
  caller_pfp?: string;
  callee_id: number;
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
  | 'member_demoted';

type ConversationActionPayload = {
  event_id: number;
  conv_id: number;
  conv_type: ChatType;
  action: ConversationActionType;
  members: MembersType[];
  actor_id?: number;
  actor_name?: string;
  actor_pfp?: string;
  message: string;
  action_at: Date;
};

// Sync payload for missed messages on reconnection
// type SyncMessageItem = {
//   id: number
//   conv_id: number
//   conv_type: ChatType
//   sender_id: number
//   sender_name?: string
//   sender_pfp?: string
//   msg_type: MessageType
//   body?: string
//   attachments?: any
//   metadata?: any
//   sent_at: Date
//   created_at: Date
// }

type SyncMessagesPayload = {
  messages: ChatMessagePayload[];
  sync_timestamp: Date;
  total_count: number;
};

// Delivery receipt payload - sent by recipient when message is delivered via FCM
type MessageDeliveredPayload = {
  message_id: bigint;
  conv_id: number;
  sender_id: number;
  recipient_id: number;
  delivered_at: Date;
};

const WS_MESSAGE_EVENTS_CONST = [
  'connection:status',
  'conversation:join',
  'conversation:leave',
  'conversation:new',
  'conversation:typing',
  'conversation:action',
  'message:new',
  'message:ack',
  'message:pin',
  'message:forward',
  'message:delete',
  'message:sync',  // Sync missed messages on reconnection
  'message:delivered',  // Delivery receipt from FCM messages
  'call:init',
  'call:init:ack',
  'call:offer',
  'call:answer',
  'call:ice',
  'call:ringing',
  'call:accept',
  'call:terminate',
  // 'call:decline',
  // 'call:end',
  // 'call:missed',
  'call:error',
  'socket:health_check',
  'socket:ping',
  'socket:pong',
  'socket:error',
  'auth:force_logout',
] as const;

const VITAL_WS_EVENTS_CONST = [
  'conversation:new',
  'conversation:action',
  'message:pin',
  'message:forward',
  'message:delete',
  'message:new',
  'message:ack',
  'message:delivered',
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
  JoinLeavePayload,
  ChatMessagePayload,
  ChatMessageAckPayload,
  TypingPayload,
  DeleteMessagePayload,
  MiscPayload,
  NewConversationPayload,
  MembersType,
  MessagePinPayload,
  MessageForwardPayload,
  CallPayload,
  ConnectionStatusType,
  ConversationActionPayload,
  // SyncMessageItem,
  SyncMessagesPayload,
  MessageDeliveredPayload,
  WSMessageEventsType,
  VitalWSMessageEventsType,
  AllowedWSEventsWithoutPayloadType
};
