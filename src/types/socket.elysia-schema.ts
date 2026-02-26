import { t } from "elysia";
import { CONNECTION_STATUS_CONST, VITAL_WS_EVENTS_CONST, WS_MESSAGE_EVENTS_CONST } from "./socket.types";
import { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS, CHAT_ROLE_CONST, MESSAGE_STATUS_CONSTS } from "./chat.types";

// Flexible date type that accepts Date objects, ISO date-time strings (with or without timezone),
// and numeric timestamps. Dart's DateTime.toIso8601String() omits the timezone suffix,
// which fails TypeBox's strict RFC 3339 date-time validation. This helper avoids that.
const FlexDate = () => t.Union([t.Date(), t.String(), t.Number()]);

// OnlineStatusPayload schema
const ConnectionStatusPayloadSchema = t.Object({
  sender_id: t.Number(),
  status: t.Enum(Object.fromEntries(CONNECTION_STATUS_CONST.map(x => [x, x]))),
});

// JoinLeavePayload schema
const JoinLeavePayloadSchema = t.Object({
  conv_id: t.Number(),
  conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
  user_id: t.Number(),
  user_name: t.Optional(t.String()),
});

// ChatMessagePayload schema
const ChatMessagePayloadSchema = t.Object({
  id: t.String(), // Accept as string, convert to bigint after validation
  sender_id: t.Number(),
  sender_name: t.Optional(t.String()),
  conv_id: t.Number(),
  conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
  msg_type: t.Enum(Object.fromEntries(MESSAGE_TYPE_CONSTS.map(x => [x, x]))),
  body: t.Optional(t.String()),
  attachments: t.Optional(t.Any()),
  metadata: t.Optional(t.Any()),
  reply_to_message_id: t.Optional(t.String()), // Accept as string, convert to bigint after validation
  sent_at: FlexDate(),
});

// ChatMessageAckPayload schema
const ChatMessageAckPayloadSchema = t.Object({
  id: t.String(), // Accept as string, convert to bigint after validation
  conv_id: t.Number(),
  sender_id: t.Number(),
  delivered_at: FlexDate(),
  delivered_to: t.Optional(t.Array(t.Number())),
  read_by: t.Optional(t.Array(t.Number())),
  offline_users: t.Optional(t.Array(t.Number())),
  is_failed: t.Optional(t.Boolean()),
  error_code: t.Optional(t.Number()),
  new_id: t.Optional(t.String()),  // Accept as string, convert to bigint after validation
});

// TypingPayload schema
const TypingPayloadSchema = t.Object({
  conv_id: t.Number(),
  sender_id: t.Number(),
  sender_name: t.Optional(t.String()),
  sender_pfp: t.Optional(t.String()),
  is_typing: t.Boolean(),
});

// DeleteMessagePayload schema
const DeleteMessagePayloadSchema = t.Object({
  conv_id: t.Number(),
  sender_id: t.Number(),
  message_ids: t.Array(t.String()), // Accept as string array, convert to bigint array after validation
});

// MembersType schema
const MembersTypeSchema = t.Object({
  user_id: t.Number(),
  user_name: t.String(),
  user_pfp: t.Optional(t.String()),
  role: t.Enum(Object.fromEntries(CHAT_ROLE_CONST.map(x => [x, x]))),
  joined_at: FlexDate()
});

// NewConversationPayload schema
const NewConversationPayloadSchema = t.Object({
  conv_id: t.Number(),
  conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
  title: t.Optional(t.String()),
  creater_id: t.Number(),
  creater_name: t.String(),
  creater_phone: t.String(),
  creater_pfp: t.Optional(t.String()),
  members: t.Optional(t.Array(MembersTypeSchema)),
  joined_at: FlexDate()
});

// MiscPayload schema
const MiscPayloadSchema = t.Object({
  message: t.String(),
  data: t.Optional(t.Any()),
  code: t.Optional(t.Number()),
  error: t.Optional(t.Any()),
});

// CallPayload schema
const CallPayloadSchema = t.Object({
  call_id: t.Optional(t.Number()),
  caller_id: t.Number(),
  caller_name: t.Optional(t.String()),
  caller_pfp: t.Optional(t.String()),
  callee_id: t.Number(),
  callee_name: t.Optional(t.String()),
  callee_pfp: t.Optional(t.String()),
  callType: t.Optional(t.Enum({ audio: "audio", video: "video", })),
  data: t.Optional(t.Any()),
  error: t.Optional(t.Any()),
  timestamp: t.Optional(FlexDate()),
});

// MessagePinPayload schema
const MessagePinPayloadSchema = t.Object({
  conv_id: t.Number(),
  message_id: t.String(), // Accept as string, convert to bigint after validation
  message_type: t.Enum(Object.fromEntries(MESSAGE_TYPE_CONSTS.map(x => [x, x]))),
  sender_id: t.Number(),
  sender_name: t.Optional(t.String()),
  sender_pfp: t.Optional(t.String()),
  pin: t.Boolean(),
});

// // MessageReplyPayload schema (extends ChatMessagePayload)
// const MessageReplyPayloadSchema = t.Object({
//   optimistic_id: t.Number(),
//   canonical_id: t.Optional(t.Number()),
//   sender_id: t.Number(),
//   sender_name: t.Optional(t.String()),
//   conv_id: t.Number(),
//   conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
//   msg_type: t.Enum(Object.fromEntries(MESSAGE_TYPE_CONSTS.map(x => [x, x]))),
//   body: t.Optional(t.String()),
//   attachments: t.Optional(t.Any()),
//   metadata: t.Optional(t.Any()),
//   sent_at: t.String(),
//   reply_to_message_id: t.Number(),
// });

// MessageForwardPayload schema
const MessageForwardPayloadSchema = t.Object({
  source_conv_id: t.Number(),
  forwarder_id: t.Number(),
  forwarder_name: t.Optional(t.String()),
  forwarded_message_ids: t.Array(t.String()), // Accept as string array, convert to bigint array after validation
  target_conv_ids: t.Array(t.Number()),
});

// ConversationActionPayload schema
const ConversationActionPayloadSchema = t.Object({
  event_id: t.Number(),
  conv_id: t.Number(),
  conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
  action: t.Enum({
    member_added: "member_added",
    member_removed: "member_removed",
    member_promoted: "member_promoted",
    member_demoted: "member_demoted",
  }),
  members: t.Array(MembersTypeSchema),
  actor_id: t.Optional(t.Number()),
  actor_name: t.Optional(t.String()),
  actor_pfp: t.Optional(t.String()),
  message: t.String(),
  action_at: FlexDate(),
});

// MessageDeliveredPayload schema - for delivery receipts from FCM messages
const MessageDeliveredPayloadSchema = t.Object({
  message_id: t.String(), // Accept as string, convert to bigint after validation
  conv_id: t.Number(),
  sender_id: t.Number(),
  recipient_id: t.Number(),
  delivered_at: FlexDate(),
});

// // Ping message schema (for heartbeat)
// const PingMessageSchema = t.Object({
//   type: t.Literal('ping'),
//   ws_timestamp: t.String(),
// });
//
// // Pong message schema (for heartbeat response)
// const PongMessageSchema = t.Object({
//   type: t.Literal('pong'),
//   ws_timestamp: t.String(),
// });

// Union schema for payload
const WSPayloadSchema = t.Union([
  ConnectionStatusPayloadSchema,
  JoinLeavePayloadSchema,
  ChatMessagePayloadSchema,
  ChatMessageAckPayloadSchema,
  TypingPayloadSchema,
  DeleteMessagePayloadSchema,
  MiscPayloadSchema,
  CallPayloadSchema,
  NewConversationPayloadSchema,
  MessagePinPayloadSchema,
  MessageForwardPayloadSchema,
  ConversationActionPayloadSchema,
  MessageDeliveredPayloadSchema,
  // PingMessageSchema,
  // PongMessageSchema,
]);

// Regular WSMessage schema (for messages with payload)
const WSMessageSchema = t.Object({
  type: t.Enum(Object.fromEntries(WS_MESSAGE_EVENTS_CONST.map(x => [x, x]))),
  payload: t.Optional(WSPayloadSchema),
  ws_timestamp: t.Optional(t.String()),
});

const VitalWSPayloadSchema = t.Union([
  NewConversationPayloadSchema,
  ChatMessagePayloadSchema,
  DeleteMessagePayloadSchema,
  MessagePinPayloadSchema,
  MessageForwardPayloadSchema,
  ConversationActionPayloadSchema,
  MessageDeliveredPayloadSchema,
]);

const VitalWSMessageSchema = t.Object({
  type: t.Enum(Object.fromEntries(VITAL_WS_EVENTS_CONST.map(x => [x, x]))),
  payload: VitalWSPayloadSchema,
  ws_timestamp: t.Optional(t.String()),
});

export {
  ConnectionStatusPayloadSchema,
  JoinLeavePayloadSchema,
  ChatMessagePayloadSchema,
  ChatMessageAckPayloadSchema,
  TypingPayloadSchema,
  DeleteMessagePayloadSchema,
  MembersTypeSchema,
  NewConversationPayloadSchema,
  MiscPayloadSchema,
  CallPayloadSchema,
  MessagePinPayloadSchema,
  MessageForwardPayloadSchema,
  ConversationActionPayloadSchema,
  MessageDeliveredPayloadSchema,
  // PingMessageSchema,
  // PongMessageSchema,
  WSPayloadSchema,
  WSMessageSchema,
  VitalWSPayloadSchema,
  VitalWSMessageSchema,
};
