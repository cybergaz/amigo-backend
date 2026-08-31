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
  is_background?: boolean;
}

interface PollingConnection {
  connection_status: ConnectionStatusType;
  last_poll_at?: Date;
  client_ip?: string;
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
  | MarqueeBannerPayload
  | ConversationDisappearingPayload;
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
  ws_timestamp?: Date;
}

const CONNECTION_STATUS_CONST = ['online', 'offline', 'background'] as const;
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
  // Canonical server-stored sent_at (client value clamped to server time).
  // The sender applies it to its local row so its display matches what
  // recipients see when the device clock was skewed.
  sent_at?: Date;
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

type TypingPayload = {
  conv_id: string;
  sender_id: string;
};

type MessagePinPayload = {
  conv_id: string;
  message_id: string;
  message_type: MessageType;
  sender_id: string;
  pin: boolean;
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
  | 'member_left'
  | 'owner_changed'
  | 'join_request:new'
  | 'join_request:resolved'
  | 'member_promoted'
  | 'member_demoted'
  | 'chat_delete'
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
  title?: string | null;
  profile_pic?: string | null;
  previous_profile_pic?: string | null;
  profile_pic_changed?: boolean;
  owner_id?: string | null;
  resolution?: 'approved' | 'rejected';
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

// Broadcast when a user updates their own profile (name and/or profile pic),
// OR when a super-admin changes the user's app-level role from the dashboard.
// Sent to every other user that shares a conversation with them so clients
// can refresh local user rows and evict stale CachedNetworkImage entries.
// Also sent to the target user themselves on role changes so they can apply
// the new permissions without logging out.
type UserUpdatePayload = {
  user_id: string;
  name?: string;
  profile_pic?: string | null;
  // Previous profile pic URL — included so clients can evict the old asset
  // from the on-disk image cache (keyed by URL).
  previous_profile_pic?: string | null;
  // App-level role: "user" | "admin" | "sub_admin" | "staff". Included only
  // on role-change broadcasts; absent on regular name/pfp updates.
  role?: string;
  // Canonical E.164 number, included only on phone-change broadcasts. Peers
  // need it because the chat-list sync only INSERTS users it has never seen
  // (see chat.provider.dart), so an existing peer's cached phone would
  // otherwise stay stale forever.
  phone?: string;
  updated_at: Date;
};

// Global super-admin-controlled marquee banner shown on the app's group list.
// Broadcast to every connected client when the super admin saves a change.
type MarqueeBannerPayload = {
  text: string;
  enabled: boolean;
  updated_at: string | null;
};

const WS_MESSAGE_EVENTS_CONST = [
  'connection:status',

  'conversation:join',
  'conversation:mark_read',
  'conversation:new',
  'conversation:typing',
  'conversation:action',
  'conversation:disappearing',

  'message:new',
  'message:sent:ack',
  'message:status:ack',
  'message:pin',
  'message:forward',
  'message:delete',
  'message:react',

  'call:init',
  'call:init:ack',
  'call:ringing',
  'call:accept',
  'call:accept:ack',
  'call:offer',
  'call:answer',
  'call:ice',
  'call:terminate',
  'call:hold',
  'call:missed',
  'call:error',
  'call:connected',           // client -> server: call reached CONNECTED (records in-call pairing)
  // Ghost-call recovery / rejoin window:
  'call:rejoin:open',         // client -> server: a party dropped, open window
  'call:rejoin:available',    // server -> dropped party: you can rejoin this cid
  'call:rejoin:resolved',     // client -> server: window resolved (rejoined|ended)
  'call:rejoin:expired',      // server -> dropped party: window closed, clear dot
  'call:rejoin:peer_dropped', // server -> waiter: peer dropped, show "Reconnecting"

  'socket:health_check',
  'socket:ping',
  'socket:pong',
  'socket:error',

  'auth:force_logout',
  'user:update',
  'marquee:update',
] as const;

const VITAL_WS_EVENTS_CONST = [
  'conversation:join',
  'conversation:mark_read',
  'conversation:new',
  'conversation:action',
  'conversation:disappearing',

  'message:new',
  'message:sent:ack',
  'message:status:ack',
  'message:pin',
  'message:forward',
  'message:delete',
  'message:react',

  'user:update',
  'auth:force_logout',

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
  MarqueeBannerPayload,
  ConversationDisappearingPayload,
  // SyncMessageItem,
  // SyncMessagesPayload,
  // MessageDeliveredPayload,
  WSMessageEventsType,
  VitalWSMessageEventsType,
  AllowedWSEventsWithoutPayloadType
};
