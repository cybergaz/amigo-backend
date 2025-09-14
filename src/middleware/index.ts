import jwt from "jsonwebtoken";
import { ElysiaMiddlewareType } from "@/types/elysia.types";
import { RoleType } from "../types/user.types";

const secretKey = process.env.ACCESS_KEY || "heymama";

export const authenticate_jwt = (access_token: string) => {
  try {
    const decoded = jwt.verify(access_token, secretKey);
    return {
      success: true,
      code: 200,
      message: "Valid Access Token",
      data: decoded as { id: number; role: RoleType },
    };
  } catch (err) {
    return {
      success: false,
      code: 401,
      message: "Inalid Access Token",
    };
  }
};

export const app_middleware = ({ cookie, headers, allowed }: ElysiaMiddlewareType) => {
  let access_token = String(cookie.access_token) || String(headers["authorization"]?.replace("Bearer ", "") ?? "");

  if (!access_token) {
    return {
      success: false,
      code: 404,
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

