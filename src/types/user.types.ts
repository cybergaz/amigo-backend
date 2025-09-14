const ROLE_CONST = ["user", "admin", "sub_admin"] as const;
type RoleType = typeof ROLE_CONST[number];

const CHAT_ROLE_CONST = ["member", "admin"] as const;
type ChatRoleType = typeof CHAT_ROLE_CONST[number];

export { ROLE_CONST, CHAT_ROLE_CONST };
export type { RoleType, ChatRoleType };