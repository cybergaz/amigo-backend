import { ElysiaWS } from "elysia/dist/ws";
import { ChatRoleType, ChatType, MessageStatusType, MessageType } from "./chat.types";


// WebSocket data interface for type safety
interface WebSocketData {
  user_id?: number;
  user_name?: string;
  user_pfp?: string;
}

// Connection management
interface UserConnection {
  ws: ElysiaWS;
  connection_status: ConnectionStatusType;
  active_conv_id?: number;
}

type WSMessage = {
  type: WSMessageType
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
  // | WSPayload
  ws_timestamp?: Date
}

// type WSPayload = {
//   sender_id: number
//   sender_name?: number
//   target_user_ids?: number[];
//   origin_conv_id?: number
//   target_conv_ids?: number[]
//   message_ids?: number[]
//   content?: any
// }

const CONNECTION_STATUS_CONST = ['foreground', 'background', 'disconnected', 'stale'] as const;
type ConnectionStatusType = typeof CONNECTION_STATUS_CONST[number]

type ConnectionStatusPayload = {
  sender_id: number
  status: ConnectionStatusType
}

type JoinLeavePayload = {
  conv_id: number
  conv_type: ChatType
  user_id: number
  user_name?: string
}

type ChatMessagePayload = {
  optimistic_id: number
  canonical_id?: number
  sender_id: number
  sender_name?: string
  conv_id: number
  conv_type: ChatType
  msg_type: MessageType
  body?: string
  attachments?: any
  metadata?: any
  reply_to_message_id?: number
  sent_at: Date
}

type ChatMessageAckPayload = {
  optimistic_id: number
  canonical_id: number
  conv_id: number
  sender_id: number
  delivered_at: Date
  delivered_to?: number[]
  read_by?: number[]
  offline_users?: number[]
}

type TypingPayload = {
  conv_id: number
  sender_id: number
  sender_name?: string
  sender_pfp?: string
  is_typing: boolean
}

type MessagePinPayload = {
  conv_id: number
  message_id: number
  message_type: MessageType
  sender_id: number
  sender_name?: string
  sender_pfp?: string
  pin: boolean
}

type MessageForwardPayload = {
  source_conv_id: number
  forwarder_id: number
  forwarder_name?: string
  forwarded_message_ids: number[]
  target_conv_ids: number[]
}

type DeleteMessagePayload = {
  conv_id: number
  sender_id: number
  message_ids: number[]
}

type NewConversationPayload = {
  conv_id: number
  conv_type: ChatType
  title?: string
  creater_id: number
  creater_name: string
  creater_phone: string
  creater_pfp?: string
  members?: MembersType[]
  joined_at: Date
}

type MembersType = {
  user_id: number
  user_name: string
  user_pfp?: string
  role: ChatRoleType
  joined_at: Date
}

type CallPayload = {
  call_id?: number
  caller_id: number
  caller_name?: string
  caller_pfp?: string
  callee_id: number
  callee_name?: string
  callee_pfp?: string
  data?: any
  error?: any
  timestamp?: Date
}

type MiscPayload = {
  message?: string
  data?: any
  code?: number
  error?: any
}

type ConversationActionType =
  | 'member_added'
  | 'member_removed'
  | 'member_promoted'
  | 'member_demoted';

type ConversationActionPayload = {
  event_id: number
  conv_id: number
  conv_type: ChatType
  action: ConversationActionType
  members: MembersType[]
  actor_id?: number
  actor_name?: string
  actor_pfp?: string
  message: string
  action_at: Date
}

const WS_MESSAGE_TYPE_CONST = [
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
  'call:init',
  'call:init:ack',
  'call:offer',
  'call:answer',
  'call:ice',
  'call:accept',
  'call:decline',
  'call:end',
  'call:ringing',
  'call:missed',
  'call:error',
  'socket:health_check',
  'socket:error',
  'auth:force_logout',
  'ping',
  'pong'
] as const;

type WSMessageType = typeof WS_MESSAGE_TYPE_CONST[number];

export { WS_MESSAGE_TYPE_CONST, CONNECTION_STATUS_CONST }
export type {
  WebSocketData,
  UserConnection,
  WSMessage,
  WSMessageType,
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
};
