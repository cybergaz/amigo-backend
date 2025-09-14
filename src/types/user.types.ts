const ROLE_CONST = ["user", "admin", "sub_admin"] as const;
type RoleType = typeof ROLE_CONST[number];

export { ROLE_CONST };
export type { RoleType };
