import jwt from "jsonwebtoken";
import { ElysiaMiddlewareType } from "@/types/elysia.types";
import { RoleType } from "../types/user.types";
import { user_model } from "@/models/user.model";
import db from "@/config/db";
import { eq } from "drizzle-orm";
import { getAccessKey } from "@/utils/general.utils";
import { AuthError } from "@/constants/auth-codes";

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

