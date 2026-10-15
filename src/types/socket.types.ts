import { ElysiaWS } from "elysia/dist/ws";
import { ChatRoleType, ChatType, MessageType } from "./chat.types";

// WebSocket data interface for type safety
interface WebSocketData {
  user_id?: string;
  user_name?: string;
  // user_pfp?: string;
  // ---- connection lifecycle (SYNC_V2 §13.6.5 / §14.5) ----
  // 12-hex per-connection nonce, for logs (and RC-2's 4009 close reason).
  cid?: string;
  // false from JWT verify until the socket is in socket_connections; inbound
  // frames are buffered (not processed) while false.
  registered?: boolean;
  // Frames that arrived before `registered` (≤ EARLY_FRAME_LIMIT).
  early_frames?: unknown[];
  // Set by the close callback, so an `open` still awaiting auth/name lookups
  // knows not to register a socket that is already gone.
  closed?: boolean;
  // Closed by the shutdown drain (1012 + socket:restart): the close callback
  // skips the offline debounce and the last_seen write (SYNC_V2 §13.7 A6).
  draining?: boolean;
  // Closed with 4009 because a newer socket of the same user replaced it
  // (SYNC_V2 §13.6.5, RC-2): the user is not leaving — the close callback
  // skips the offline broadcast, last_seen and the presence release.
  replaced?: boolean;
  // SYNC_V2 §3.3.5 (sync_v2 'on'): tail of this socket's serial vital-frame
  // chain (sockets/vital-chain.ts). Never rejects.
  vital_tail?: Promise<unknown>;
}

// Transport types for fallback support
type TransportType = 'ws' | 'polling';

// Connection management
// Keepalive mode a client announces in connection:status (§14.5).
// 'reliable' is accepted for forward compatibility; until the server-learned
// interval ships it behaves like 'bg'.
type KeepaliveMode = 'fg' | 'bg' | 'reliable';

interface UserConnection {
  ws: ElysiaWS;
  // ws.data.cid of this socket: the presence key names it ("wid|cid|bg"),
  // so refresh / release / evict compare against it (RC-2).
  cid?: string;
  // `on` mode: the open's presence claim failed (Redis error / deadline), so
  // the key may still name this user's previous socket. The next 15 s
  // refresh re-claims instead of reading that leftover as "replaced
  // elsewhere" and closing this — live — socket as a ghost.
  presence_unclaimed?: boolean;
  missed_pings: number;
  is_background?: boolean;
  // ---- liveness / keepalive (SYNC_V2 §14.5) ----
  // ms epoch of the last frame received on THIS socket (any type).
  last_inbound_at?: number;
  // ms epoch of the last server socket:ping sent on this socket.
  last_ping_at?: number;
  // ms epoch of the last keepalive accounting point (ping sent or skip
  // counted) — only rate-limits the server_ping_skipped counter.
  last_keepalive_at?: number;
  // Per-connection keepalive interval; 20 s unless the client announced one.
  keepalive_ms?: number;
  keepalive_mode?: KeepaliveMode;
  // ms epoch when ws.send first reported backpressure; cleared on drain.
  congested_since?: number;
  // ms epoch when ws.send first DROPPED a frame on this open socket (buffer
  // past backpressureLimit). Never cleared: the frame is gone from this
  // socket even if it drains later, and only a reconnect replays the
  // pending queue, so the keepalive tick closes the socket (4008).
  dropped_at?: number;
}

interface PollingConnection {
  connection_status: ConnectionStatusType;
  last_poll_at?: Date;
  client_ip?: string;
  // Poll v2 (R3): epoch ms until which a parked long-poll keeps the lease
  // fresh (router-core lease_seen_ms). Never set by poll v1.
  held_until?: number;
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
  | ConversationDisappearingPayload
  | ChatWmPayload;
  ws_timestamp?: Date;
  // Client clock echo on socket:ping / socket:pong (§14.5): the server copies
  // the ping's `t` into its pong so the app can measure RTT.
  t?: number;
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
  // Optional keepalive announcement from new clients (§14.5). Old clients
  // never send these → default 20 s keepalive.
  mode?: string;
  ka_s?: number;
};

type ConvJoinPayload = {
  conv_id: string;
  user_id: string;
  last_read_msg_id: string;
  // SYNC_V2 §3.7 / §4.1 — additive, sync_v2 'on' only.
  // Inbound (optional): the reader's exact read seq.
  // Outbound (to senders, from apply_receipts' window): the reader, its new
  // read_seq; last_read_msg_id is then the id with the max seq <= read_seq.
  read_seq?: number;
  reader_id?: string;
};

type ChatMessagePayload = {
  id: string;
  conv_id: string;
  sender_id: string;
  msg_type: MessageType;
  body?: string;
  attachments?: any;
  // null on the wire for a plain message (the app sends it explicitly).
  replied_to?: string | null;
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
    // SYNC_V2 §4.1 (additive, 'on' only)
    seq?: number | null;
    mod_seq?: number | null;
  } | null;
  sent_at: Date;
  // Set by the server on message:new broadcast when the chat has disappearing
  // messages enabled. Clients use this to filter expired-but-not-yet-deleted
  // rows from the view; the server sweeper is what actually soft-deletes the
  // row and broadcasts message:delete.
  expires_at?: Date | string | null;
  // SYNC_V2 §3.10 (additive; only with sync_v2_system_rows on): this
  // message:new is a system row whose wire sender_id is the ACTOR (old apps
  // decode sender_id as a non-null String); the stored row has sender_id NULL.
  system_actor?: boolean;
  // SYNC_V2 §4.1 (additive, sync_v2 'on' only): the stored row's clock
  // values and server arrival time (srv_ts = created_at).
  seq?: number | null;
  mod_seq?: number | null;
  srv_ts?: Date | string | null;
  // SYNC_V2 §4.1 (inbound, optional, v2 senders): split-message diagnostics.
  split_group?: string;
  part_index?: number;
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
  // Present ONLY for messages sent into a broadcast-list chat (also on the
  // idempotent duplicate re-ack): one entry per recipient naming the 1:1 DM
  // the server copied the message into and the copy's id. A send into a list
  // with no recipients is refused (is_sent:false, error_code:422) rather than
  // acked with an empty array. See BROADCAST_LISTS.md.
  broadcast_copies?: BroadcastCopyRef[];
  // SYNC_V2 §4.1 (additive, sync_v2 'on' only): the stored row's seq and
  // server arrival time. A duplicate re-ack carries the ORIGINAL values.
  seq?: number | null;
  srv_ts?: Date | string | null;
};

// One server-made copy of a broadcast message: the recipient, the DM it was
// delivered in, and the copy's message id inside that DM.
type BroadcastCopyRef = {
  recipient_id: string;
  conv_id: string;
  msg_id: string;
};

type MessageStatusAckPayload = {
  recipient_id: string;
  at: Date;
  acks: {
    chat_id: string;
    msg_ids: string[];
    status: ('delivered' | 'read')[];   // 1 or 2 elements
    // SYNC_V2 §4.1 (additive, outbound, 'on' only): seq of each msg_ids entry.
    seqs?: number[];
  }[];
  // SYNC_V2 §4.1 (additive, outbound, 'on' only): the reader and its absolute
  // watermarks in the chat the acks are about (single-chat frames).
  reader_id?: string;
  delivered_seq?: number;
  read_seq?: number;
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
  // SYNC_V2 §3.12 / §4.1 (additive, 'on' only). pinned_message travels on the
  // LIVE WS frame only, never in the pending store or FCM.
  pin_seq?: number;
  pinned_message?: unknown;
};

type MessageForwardPayload = {
  source_conv_id: string;
  forwarder_id: string;
  forwarder_name?: string;
  forwarded_message_ids: string[];
  target_conv_ids: string[];
  // SYNC_V2 §3.3.7 (optional, honoured in 'on'): client ids per target chat,
  // one per forwarded_message_ids entry (same order).
  ids?: Record<string, string[]>;
};

type DeleteMessagePayload = {
  conv_id: string;
  sender_id: string;
  message_ids: string[];
  // SYNC_V2 §3.12 / §4.1 (additive, outbound, 'on' only): each deleted row's
  // new mod_seq, and — when the delete unpinned the chat (the trigger
  // allocated pin_seq) — the resulting pin state.
  mods?: { id: string; mod_seq: number }[];
  pin?: { pinned_msg_id: null; pin_seq: number };
};

// SYNC_V2 §3.7 / §4.1 chat:wm — the per-viewer "others" receipt watermarks
// after the receipt mins rose. Live only, to proto-2 sockets; never stored.
type ChatWmPayload = {
  conv_id: string;
  others_read_seq: number;
  others_delivered_seq: number;
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
  // SYNC_V2 §3.10 (additive; only with app_settings.sync_v2_system_rows on):
  // the persisted type='system' row for this action, id = event_id. The
  // spec calls it `message`, but `message` is already the display text that
  // old apps decode as a String, so it travels under this name instead.
  system_message?: { id: string; seq: number | null; srv_ts: string };
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

  // SYNC_V2 §4.1: server → proto-2 WS only, never stored (not vital).
  'chat:wm',

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
  KeepaliveMode,
  UserConnection,
  PollingConnection,
  TransportType,
  WSMessage,
  VitalWSMessage,
  ConnectionStatusPayload,
  ConvJoinPayload,
  ChatMessagePayload,
  MessageSentAckPayload,
  BroadcastCopyRef,
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
  ChatWmPayload,
  // SyncMessageItem,
  // SyncMessagesPayload,
  // MessageDeliveredPayload,
  WSMessageEventsType,
  VitalWSMessageEventsType,
  AllowedWSEventsWithoutPayloadType
};
