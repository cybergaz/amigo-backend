import jwt from "jsonwebtoken";
import { ElysiaMiddlewareType } from "@/types/elysia.types";
import { RoleType } from "../types/user.types";
import { user_model } from "@/models/user.model";
import db from "@/config/db";
import { eq } from "drizzle-orm";

const secretKey = process.env.ACCESS_KEY || "heymama";

export const authenticate_jwt = (token: string) => {
  try {
    const decoded = jwt.verify(token, secretKey);
    return {
      success: true,
      code: 200,
      message: "Valid Token",
      data: decoded as { id: number; role: RoleType },
    };
  } catch (err) {
    return {
      success: false,
      code: 401,
      message: "Inalid Token",
    };
  }
};

export const app_middleware = ({ cookie, headers, allowed }: ElysiaMiddlewareType) => {
  let access_token = String(cookie.access_token) || String(headers["authorization"]?.replace("Bearer ", "") ?? "");

  if (!access_token) {
    return {
      success: false,
      code: 401,
      message: "No Access Token in Cookies",
    };
  }

  const middleware_response = authenticate_jwt(access_token);

  if (!middleware_response.success || (!middleware_response.data?.id && !middleware_response.data?.role)) {
    return {
      success: middleware_response.success,
      code: middleware_response.code,
      message: middleware_response.message,
    };
  }

  if (allowed && !allowed.includes(middleware_response.data.role)) {
    return {
      success: false,
      code: 403,
      message: "Restricted Endpoint",
    };
  }

  return {
    success: middleware_response.success,
    code: middleware_response.code,
    message: middleware_response.message,
    data: middleware_response.data
  };
}

export const check_permission = async (userId: number, requiredPermission: string) => {
  try {
    const user = await db
      .select({
        role: user_model.role,
        permissions: user_model.permissions,
        online_status: user_model.online_status,
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

    // Check if sub-admin is active
    if (userData.role === "sub_admin" && !userData.online_status) {
      return {
        success: false,
        code: 403,
        message: "Account is inactive",
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

