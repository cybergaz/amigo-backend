import { t } from "elysia";
import { ROLE_CONST } from "./user.types";

const VerifySignupSchema = t.Object({
  name: t.String(),
  password: t.Optional(t.String()),
  phone: t.String(),
  role: t.Enum(Object.fromEntries(ROLE_CONST.map(area => [area, area]))),
  otp: t.Number(),
});

export { VerifySignupSchema };
