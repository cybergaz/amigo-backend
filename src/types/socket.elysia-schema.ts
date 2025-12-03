import { t } from "elysia";
import { CONNECTION_STATUS_CONST, WS_MESSAGE_TYPE_CONST } from "./socket.types";
import { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS, CHAT_ROLE_CONST, MESSAGE_STATUS_CONSTS } from "./chat.types";

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
  optimistic_id: t.Number(),
  canonical_id: t.Optional(t.Number()),
  sender_id: t.Number(),
  sender_name: t.Optional(t.String()),
  conv_id: t.Number(),
  conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
  msg_type: t.Enum(Object.fromEntries(MESSAGE_TYPE_CONSTS.map(x => [x, x]))),
  body: t.Optional(t.String()),
  attachments: t.Optional(t.Any()),
  metadata: t.Optional(t.Any()),
  reply_to_message_id: t.Optional(t.Number()),
  sent_at: t.Date(),
});

// ChatMessageAckPayload schema
const ChatMessageAckPayloadSchema = t.Object({
  optimistic_id: t.Number(),
  canonical_id: t.Number(),
  conv_id: t.Number(),
  sender_id: t.Number(),
  delivered_at: t.Date(),
  delivered_to: t.Optional(t.Array(t.Number())),
  read_by: t.Optional(t.Array(t.Number())),
  offline_users: t.Optional(t.Array(t.Number())),
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
  message_ids: t.Array(t.Number()),
});

// MembersType schema
const MembersTypeSchema = t.Object({
  user_id: t.Number(),
  user_name: t.String(),
  user_pfp: t.Optional(t.String()),
  role: t.Enum(Object.fromEntries(CHAT_ROLE_CONST.map(x => [x, x]))),
  joined_at: t.Date()
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
  joined_at: t.Date()
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
  data: t.Optional(t.Any()),
  error: t.Optional(t.Any()),
  timestamp: t.Optional(
    t.Transform(t.String())
      .Decode((value) => new Date(value))
      .Encode((value) => (value instanceof Date ? value.toISOString() : value))
  ),
});

// MessagePinPayload schema
const MessagePinPayloadSchema = t.Object({
  conv_id: t.Number(),
  message_id: t.Number(),
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
  forwarded_message_ids: t.Array(t.Number()),
  target_conv_ids: t.Array(t.Number()),
});

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
]);

// WSMessage schema
const WSMessageSchema = t.Object({
  type: t.Enum(Object.fromEntries(WS_MESSAGE_TYPE_CONST.map(x => [x, x]))),
  payload: t.Optional(WSPayloadSchema),
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
  WSPayloadSchema,
  WSMessageSchema,
};
