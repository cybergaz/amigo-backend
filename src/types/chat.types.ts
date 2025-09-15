const CHAT_TYPE_CONSTS = ["dm", "group"] as const;
type ChatType = typeof CHAT_TYPE_CONSTS[number];

const MESSAGE_TYPE_CONSTS = ["text", "system", "attachment", "reaction"] as const;
type MessageType = typeof MESSAGE_TYPE_CONSTS[number];

export { CHAT_TYPE_CONSTS, MESSAGE_TYPE_CONSTS };
export type { ChatType, MessageType };
