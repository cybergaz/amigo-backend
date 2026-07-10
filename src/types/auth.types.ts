import { t } from "elysia";
import { ROLE_CONST } from "./user.types";

const VerifySignupSchema = t.Object({
  name: t.String(),
  password: t.Optional(t.String()),
  // Mobile signup sets the login (password) PIN — 4 digits, hashed into
  // password_pin_hash (separate from the web `password`).
  password_pin: t.Optional(t.String({ pattern: "^\\d{4}$" })),
  phone: t.String(),
  role: t.Enum(Object.fromEntries(ROLE_CONST.map(area => [area, area]))),
  otp: t.Number(),
  // Mobile single-token flow: presence of device_id routes signup to the
  // device-JWT mint (no cookies). Absent ⇒ legacy cookie/refresh path.
  device_id: t.Optional(t.String()),
  platform: t.Optional(t.String()),
  device_name: t.Optional(t.String()),
});

export { VerifySignupSchema };
