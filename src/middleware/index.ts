import jwt from "jsonwebtoken";
import { ElysiaMiddlewareType } from "@/types/elysia.types";
import { RoleType } from "../types/user.types";
import { user_model } from "@/models/user.model";
import db from "@/config/db";
import { eq } from "drizzle-orm";
import { getAccessKey } from "@/utils/general.utils";
import { AuthError } from "@/constants/auth-codes";
import { is_device_token_current } from "@/services/session.service";

const secretKey = getAccessKey();

export const authenticate_jwt = (token: string) => {
  try {
    const decoded = jwt.verify(token, secretKey);
    return {
      success: true,
      code: 200,
      message: "Valid Token",
      data: decoded as { id: string; role: RoleType; device_id?: string; token_version?: number; },
    };
  } catch (err) {
    // Split expired vs invalid: both are REST-fatal, but the label distinguishes
    // natural expiry from a tampered/garbage token in logout telemetry.
    const expired = err instanceof jwt.TokenExpiredError;
    return {
      success: false,
      code: 498,
      message: expired ? "Token Expired" : "Invalid Token",
      auth_error: expired ? AuthError.TOKEN_EXPIRED : AuthError.TOKEN_INVALID,
    };
  }
};

export const app_middleware = ({ cookie, headers, allowed }: ElysiaMiddlewareType) => {
  // Read the cookie's ACTUAL value (like every route does via `.value`); the old
  // `String(cookie.access_token)` stringified the Cookie proxy to non-empty garbage
  // even when unset, which shadowed the Bearer header and 498'd Bearer-only mobile.
  const cookieToken = cookie.access_token?.value ? String(cookie.access_token.value) : "";
  const bearerToken = headers["authorization"]?.replace("Bearer ", "") ?? "";
  let access_token = cookieToken || bearerToken;
  // console.log("cookie refresh:", cookie.refresh_token.value);
  // console.log("cookie access:", cookie.access_token.value);

  if (!access_token) {
    return {
      success: false,
      code: 499,
      message: "No Access Token in Cookies",
      auth_error: AuthError.TOKEN_MISSING,
    };
  }

  const middleware_response = authenticate_jwt(access_token);

  if (!middleware_response.success || (!middleware_response.data?.id && !middleware_response.data?.role)) {
    return {
      success: middleware_response.success,
      code: middleware_response.code,
      message: middleware_response.message,
      auth_error: (middleware_response as { auth_error?: string }).auth_error,
    };
  }

  if (allowed && !allowed.includes(middleware_response.data.role)) {
    return {
      success: false,
      code: 403,
      message: "Restricted Endpoint",
      // Valid session, wrong role — NOT fatal; tagged so the client can positively
      // confirm "this 403 is not a session death" and logs/telemetry can tell a
      // role gate from a business membership 403.
      auth_error: AuthError.ROLE_FORBIDDEN,
    };
  }

  return {
    success: middleware_response.success,
    code: middleware_response.code,
    message: middleware_response.message,
    data: middleware_response.data
  };
};

// Single-device enforcement for HTTP routes that stand in for the WebSocket.
//
// The socket's `open` handler has always re-checked device_id + token_version, but
// long polling — the transport the app falls back to whenever the socket cannot be
// established — never did. A device superseded by a newer login therefore stayed
// fully alive on the fallback path: it kept polling for messages and posting sends
// with a token the socket would have rejected outright. This is the HTTP half of
// that check, and it lives here because `auth_error` may only be set by the auth
// layer (see constants/auth-codes.ts).
//
// Returns null when the caller may proceed, or the 401 body to return otherwise.
// Only MOBILE device tokens carry these claims; cookie/web/admin tokens skip the
// check exactly as they do on the socket.
export const enforce_device_token = async (data: {
  id: string;
  device_id?: string;
  token_version?: number;
}) => {
  if (data.device_id == null || data.token_version == null) return null;

  const current = await is_device_token_current(
    data.id,
    data.device_id,
    data.token_version,
  );
  if (current) return null;

  return {
    success: false,
    code: 401,
    message: "Session superseded on another device",
    auth_error: AuthError.DEVICE_SUPERSEDED,
  };
};

export const check_permission = async (userId: string, requiredPermission: string) => {
  try {
    const user = await db
      .select({
        role: user_model.role,
        permissions: user_model.permissions,
      })
      .from(user_model)
      .where(eq(user_model.id, userId))
      .limit(1);

    if (user.length === 0) {
      return {
        success: false,
        code: 404,
        message: "User not found",
      };
    }

    const userData = user[0];

    // Super admin has all permissions
    if (userData.role === "admin") {
      return {
        success: true,
        code: 200,
        message: "Permission granted",
      };
    }

    // Check if sub-admin has the required permission
    if (userData.role === "sub_admin") {
      const permissions = userData.permissions as string[] || [];
      if (permissions.includes(requiredPermission)) {
        return {
          success: true,
          code: 200,
          message: "Permission granted",
        };
      } else {
        return {
          success: false,
          code: 403,
          message: "Insufficient permissions",
        };
      }
    }

    return {
      success: false,
      code: 403,
      message: "Access denied",
    };
  } catch (error) {
    console.error("Error checking permission:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error",
    };
  }
};

