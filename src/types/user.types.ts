const ROLE_CONST = ["user", "admin", "sub_admin", "staff"] as const;
type RoleType = typeof ROLE_CONST[number];


const REQUEST_STATUS_CONST = ["pending", "accepted", "rejected"] as const;
type RequestStatusType = typeof REQUEST_STATUS_CONST[number];

export { ROLE_CONST, REQUEST_STATUS_CONST };
export type { RoleType, RequestStatusType };
