import { t } from "elysia";
import { CONNECTION_STATUS_CONST, VITAL_WS_EVENTS_CONST, WS_MESSAGE_EVENTS_CONST } from "./socket.types";
import { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS, CHAT_ROLE_CONST } from "./chat.types";

// Flexible date type that accepts Date objects, ISO date-time strings (with or without timezone),
// and numeric timestamps. Dart's DateTime.toIso8601String() omits the timezone suffix,
// which fails TypeBox's strict RFC 3339 date-time validation. This helper avoids that.
const FlexDate = () => t.Union([t.Date(), t.String(), t.Number()]);

// OnlineStatusPayload schema
const ConnectionStatusPayloadSchema = t.Object({
  sender_id: t.String(),
  status: t.Enum(Object.fromEntries(CONNECTION_STATUS_CONST.map(x => [x, x]))),
});

// ConvJoinPayload schema
const ConvJoinPayloadSchema = t.Object({
  conv_id: t.String(),
  user_id: t.String(),
  last_read_msg_id: t.String(),
});

// ChatMessagePayload schema
const ChatMessagePayloadSchema = t.Object({
  id: t.String(),
  conv_id: t.String(),
  sender_id: t.String(),
  msg_type: t.Enum(Object.fromEntries(MESSAGE_TYPE_CONSTS.map(x => [x, x]))),
  body: t.Optional(t.String()),
  attachments: t.Optional(t.Any()),
  replied_to: t.Optional(t.String()),
  sent_at: FlexDate(),
  // sender_name: t.Optional(t.String()),
  // conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
});

// MessageSentAckPayload schema
const MessageSentAckPayloadSchema = t.Object({
  msg_id: t.String(),
  conv_id: t.String(),
  is_sent: t.Boolean(),
  error_code: t.Optional(t.Number()),
  new_id: t.Optional(t.String()),
});

// MessageStatusAckPayload schema
const MessageStatusAckPayloadSchema = t.Object({
  recipient_id: t.String(),
  at: FlexDate(),
  acks: t.Array(t.Object({
    chat_id: t.String(),
    msg_ids: t.Array(t.String()),
    status: t.Array(t.Union([t.Literal('delivered'), t.Literal('read')])),
  })),
});

// TypingPayload schema
const TypingPayloadSchema = t.Object({
  conv_id: t.String(),
  sender_id: t.String(),
  // is_typing: t.Boolean(),
  // sender_name: t.Optional(t.String()),
  // sender_pfp: t.Optional(t.String()),
});

// DeleteMessagePayload schema
const DeleteMessagePayloadSchema = t.Object({
  conv_id: t.String(),
  sender_id: t.String(),
  message_ids: t.Array(t.String()),
});

// MembersType schema
const MembersTypeSchema = t.Object({
  user_id: t.String(),
  user_name: t.String(),
  user_pfp: t.Optional(t.String()),
  role: t.Enum(Object.fromEntries(CHAT_ROLE_CONST.map(x => [x, x]))),
  joined_at: FlexDate()
});

// NewConversationPayload schema
const NewConversationPayloadSchema = t.Object({
  conv_id: t.String(),
  conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
  title: t.Optional(t.String()),
  creater_id: t.String(),
  creater_name: t.String(),
  creater_phone: t.String(),
  creater_pfp: t.Optional(t.String()),
  members: t.Optional(t.Array(MembersTypeSchema)),
  joined_at: FlexDate()
});

// MiscPayload schema
const MiscPayloadSchema = t.Object({
  message: t.Optional(t.String()),
  data: t.Optional(t.Any()),
  code: t.Optional(t.Number()),
  error: t.Optional(t.Any()),
});

// CallPayload schema
const CallPayloadSchema = t.Object({
  call_id: t.Optional(t.String()),
  caller_id: t.String(),
  caller_name: t.Optional(t.String()),
  caller_pfp: t.Optional(t.String()),
  callee_id: t.String(),
  callee_name: t.Optional(t.String()),
  callee_pfp: t.Optional(t.String()),
  callType: t.Optional(t.Enum({ audio: "audio", video: "video", })),
  data: t.Optional(t.Any()),
  error: t.Optional(t.Any()),
  timestamp: t.Optional(FlexDate()),
});

// MessagePinPayload schema
const MessagePinPayloadSchema = t.Object({
  conv_id: t.String(),
  message_id: t.String(),
  message_type: t.Enum(Object.fromEntries(MESSAGE_TYPE_CONSTS.map(x => [x, x]))),
  sender_id: t.String(),
  pin: t.Boolean(),
  // sender_name: t.Optional(t.String()),
  // sender_pfp: t.Optional(t.String()),
});

// MessageReactPayload schema
const MessageReactPayloadSchema = t.Object({
  message_id: t.String(),
  conv_id: t.String(),
  sender_id: t.String(),
  emoji: t.String(),
  action: t.Union([t.Literal('add'), t.Literal('remove')]),
  // sender_name: t.Optional(t.String()),
});

// MessageForwardPayload schema
const MessageForwardPayloadSchema = t.Object({
  source_conv_id: t.String(),
  forwarder_id: t.String(),
  forwarder_name: t.Optional(t.String()),
  forwarded_message_ids: t.Array(t.String()),
  target_conv_ids: t.Array(t.String()),
});

// ConversationActionPayload schema
const ConversationActionPayloadSchema = t.Object({
  event_id: t.String(),
  conv_id: t.String(),
  conv_type: t.Enum(Object.fromEntries(CHAT_TYPE_CONSTS.map(x => [x, x]))),
  action: t.Enum({
    member_added: "member_added",
    member_removed: "member_removed",
    member_promoted: "member_promoted",
    member_demoted: "member_demoted",
  }),
  members: t.Array(MembersTypeSchema),
  actor_id: t.Optional(t.String()),
  // actor_name: t.Optional(t.String()),
  // actor_pfp: t.Optional(t.String()),
  message: t.String(),
  action_at: FlexDate(),
});

// UserUpdatePayload schema — sent when a user updates their own name/profile pic
const UserUpdatePayloadSchema = t.Object({
  user_id: t.String(),
  name: t.Optional(t.String()),
  profile_pic: t.Optional(t.Union([t.String(), t.Null()])),
  previous_profile_pic: t.Optional(t.Union([t.String(), t.Null()])),
  updated_at: FlexDate(),
});

// // MessageDeliveredPayload schema - for delivery receipts from FCM messages
// const MessageDeliveredPayloadSchema = t.Object({
//   message_id: t.String(),
//   conv_id: t.String(),
//   sender_id: t.String(),
//   recipient_id: t.String(),
//   delivered_at: FlexDate(),
// });

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
  ConvJoinPayloadSchema,
  ChatMessagePayloadSchema,
  MessageSentAckPayloadSchema,
  MessageStatusAckPayloadSchema,
  TypingPayloadSchema,
  DeleteMessagePayloadSchema,
  MiscPayloadSchema,
  CallPayloadSchema,
  NewConversationPayloadSchema,
  MessagePinPayloadSchema,
  MessageForwardPayloadSchema,
  MessageReactPayloadSchema,
  ConversationActionPayloadSchema,
  UserUpdatePayloadSchema,
  // MessageDeliveredPayloadSchema,
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
  ConvJoinPayloadSchema,
  NewConversationPayloadSchema,
  ChatMessagePayloadSchema,
  MessageSentAckPayloadSchema,
  MessageStatusAckPayloadSchema,
  DeleteMessagePayloadSchema,
  MessagePinPayloadSchema,
  MessageForwardPayloadSchema,
  MessageReactPayloadSchema,
  ConversationActionPayloadSchema,
  UserUpdatePayloadSchema,
  // MessageDeliveredPayloadSchema,
]);

const VitalWSMessageSchema = t.Object({
  type: t.Enum(Object.fromEntries(VITAL_WS_EVENTS_CONST.map(x => [x, x]))),
  payload: VitalWSPayloadSchema,
  ws_timestamp: t.Optional(t.String()),
});

export {
  ConnectionStatusPayloadSchema,
  ConvJoinPayloadSchema,
  ChatMessagePayloadSchema,
  MessageSentAckPayloadSchema,
  MessageStatusAckPayloadSchema,
  TypingPayloadSchema,
  DeleteMessagePayloadSchema,
  MembersTypeSchema,
  NewConversationPayloadSchema,
  MiscPayloadSchema,
  CallPayloadSchema,
  MessagePinPayloadSchema,
  MessageForwardPayloadSchema,
  MessageReactPayloadSchema,
  ConversationActionPayloadSchema,
  UserUpdatePayloadSchema,
  // MessageDeliveredPayloadSchema,
  // PingMessageSchema,
  // PongMessageSchema,
  WSPayloadSchema,
  WSMessageSchema,
  VitalWSPayloadSchema,
  VitalWSMessageSchema,
};
