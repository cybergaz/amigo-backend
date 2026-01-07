import { signup_request_model, UpdateSignupRequestType, user_model } from "@/models/user.model";
import db from "@/config/db";
import {
  compare_password,
  generate_jwt,
  generate_refresh_jwt,
} from "@/utils/general.utils";
import { eq, desc } from "drizzle-orm";
import { socket_connections } from "@/sockets/socket.server";
import { MiscPayload } from "@/types/socket.types";
import { RequestStatusType } from "@/types/user.types";
import { create_user } from "./user.services";

const handle_login = async ({
  phone,
  email,
  password,
}: {
  phone?: string;
  email?: string;
  password?: string;
}) => {
  try {
    const user = await db
      .select()
      .from(user_model)
      .where(
        phone ? eq(user_model.phone, phone) : eq(user_model.email, email!)
      )
      .then((res) => res[0]);

    if (!user) {
      return {
        success: false,
        code: 404,
        message: "User not found",
      };
    }

    if (password) {
      if (!user.hashed_password) {
        return {
          success: false,
          code: 403,
          message: "Account is not password protected",
          help: {
            message: "Login via OTP!",
            link: `${process.env.FRONTEND_URL}/otp-login`,
          },
        };
      }

      const isPasswordCorrect = await compare_password(
        password,
        user.hashed_password
      );
      if (!isPasswordCorrect) {
        return {
          success: false,
          code: 401,
          message: "Incorrect password",
        };
      }
    }

    const access_token = generate_jwt(user.id, user.role || false, "7d");
    const refresh_token = generate_refresh_jwt(user.id, user.role, "90d");

    // Force logout all other devices before updating the refresh token
    await force_logout_other_devices(user.id);

    await db
      .update(user_model)
      .set({ refresh_token })
      .where(eq(user_model.id, user.id));

    return {
      success: true,
      code: 200,
      message: "Login successful",
      data: {
        id: user.id,
        name: user.name,
        role: user.role,
        phone: user.phone,
        email: user.email,
        profile_pic: user.profile_pic,
        call_access: user.call_access,
        created_at: user.created_at,
        refresh_token,
        access_token,
      },
    };
  } catch (error: any) {
    console.error("Login error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during login",
    };
  }
};

const handle_refresh_token = async (token: string) => {
  try {
    const [user] = await db
      .select()
      .from(user_model)
      .where(eq(user_model.refresh_token, token))
      .limit(1)

    if (!user) {
      return {
        success: false,
        code: 404,
        message: "Invalid refresh token",
      };
    }

    const access_token = generate_jwt(user.id, user.role || false);
    const refresh_token = generate_refresh_jwt(user.id, user.role);

    await db
      .update(user_model)
      .set({ refresh_token })
      .where(eq(user_model.id, user.id));

    return {
      success: true,
      code: 200,
      message: "Token refreshed successfully",
      data: {
        access_token,
        refresh_token,
      },
    };
  } catch (error: any) {
    console.error("Refresh token error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during token refresh",
    };
  }
};

const handle_refresh_token_mobile = async (token: string) => {
  try {
    const [user] = await db
      .select()
      .from(user_model)
      .where(eq(user_model.refresh_token, token))
      .limit(1)

    if (!user) {
      return {
        success: false,
        code: 404,
        message: "Invalid refresh token",
      };
    }

    const access_token = generate_jwt(user.id, user.role || false, "7d");
    const refresh_token = generate_refresh_jwt(user.id, user.role, "90d");

    await db
      .update(user_model)
      .set({ refresh_token })
      .where(eq(user_model.id, user.id));

    return {
      success: true,
      code: 200,
      message: "Token refreshed successfully",
      data: {
        access_token,
        refresh_token,
      },
    };
  } catch (error: any) {
    console.error("Refresh token error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during token refresh",
    };
  }
};

/**
 * Validate if a refresh token is still valid (matches what's in the database)
 * This is a lightweight check to verify if the token was invalidated by a new login
 */
const validate_refresh_token = async (token: string) => {
  try {
    const [user] = await db
      .select({ id: user_model.id })
      .from(user_model)
      .where(eq(user_model.refresh_token, token))
      .limit(1);

    if (!user) {
      return {
        success: false,
        code: 404,
        message: "Invalid refresh token",
      };
    }

    return {
      success: true,
      code: 200,
      message: "Refresh token is valid",
    };
  } catch (error: any) {
    console.error("Token validation error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during token validation",
    };
  }
};

/**
 * Force logout all other devices when a user logs in on a new device
 * This sends a WebSocket message to all active connections for the user
 * and closes those connections
 */
const force_logout_other_devices = async (user_id: number): Promise<void> => {
  try {
    const connection = socket_connections.get(user_id);

    if (connection && connection.ws.readyState === 1) {
      // Send force logout message to the existing connection
      const force_logout_message = {
        type: 'auth:force_logout' as const,
        payload: {
          message: 'You have been logged out because you logged in on another device',
          code: 401,
        } as MiscPayload,
        ws_timestamp: new Date(),
      };

      try {
        connection.ws.send(force_logout_message, true);
        console.log(`[AUTH] Sent force logout message to user ${user_id}`);

        // Close the WebSocket connection after a short delay to allow message delivery
        setTimeout(() => {
          if (connection.ws.readyState === 1) {
            connection.ws.close(4003, "Logged out due to new login on another device");
            socket_connections.delete(user_id);
            console.log(`[AUTH] Closed WebSocket connection for user ${user_id}`);
          }
        }, 100);
      } catch (error) {
        console.error(`[AUTH] Error sending force logout to user ${user_id}:`, error);
        // Still try to close the connection
        try {
          if (connection.ws.readyState === 1) {
            connection.ws.close(4003, "Logged out due to new login on another device");
          }
          socket_connections.delete(user_id);
        } catch (closeError) {
          console.error(`[AUTH] Error closing connection for user ${user_id}:`, closeError);
        }
      }
    }
  } catch (error) {
    console.error(`[AUTH] Error in force_logout_other_devices for user ${user_id}:`, error);
  }
};

const create_signup_request = async ({ first_name, last_name, phone }: { first_name: string; last_name: string; phone: string }) => {
  try {
    const signup_request = await db.insert(signup_request_model).values({ first_name, last_name, phone }).returning();
    if (!signup_request) {
      return { success: false, code: 404, message: "Signup request not created" };
    }
    return {
      success: true,
      code: 200,
      message: "Signup request created successfully",
      data: signup_request,
    };
  } catch (error) {
    console.error("Signup request error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during signup request"
    };
  }
};

const get_signup_request_status = async (phone: string) => {
  try {
    const signup_request = await db
      .select()
      .from(signup_request_model)
      .where(eq(signup_request_model.phone, phone))
      .limit(1);

    if (!signup_request || signup_request.length === 0) {
      return {
        success: false,
        code: 404,
        message: "Signup request not found for this phone number"
      };
    }
    return {
      success: true,
      code: 200,
      message: "Signup request status fetched successfully",
      data: signup_request[0]
    };
  } catch (error) {
    console.error("Signup request status error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during signup request status"
    };
  }
};

const get_all_signup_requests = async () => {
  try {
    const signup_requests = await db
      .select()
      .from(signup_request_model)
      .orderBy(desc(signup_request_model.created_at));

    return {
      success: true,
      code: 200,
      message: "Signup requests fetched successfully",
      data: signup_requests
    };
  } catch (error) {
    console.error("Get all signup requests error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during fetching signup requests"
    };
  }
};

const update_signup_request_status = async (payload: UpdateSignupRequestType) => {
  try {

    const signup_request = await db
      .update(signup_request_model)
      .set(payload)
      .where(eq(signup_request_model.phone, payload.phone!))
      .returning();

      

    if (!signup_request) {
      return { success: false, code: 404, message: "Signup request not updated" };
    }

    // Only create user if status is accepted
    if (payload.status === "accepted") {
      const create_user_res = await create_user({
        name: signup_request[0].first_name + " " + signup_request[0].last_name,
        password: null,
        role: "user",
        phone: signup_request[0].phone,
      });
      
      if (!create_user_res?.success) {
        return { success: false, code: create_user_res.code, message: create_user_res.message };
      }
    }
    
    return {
      success: true,
      code: 200,
      message: "Signup request status updated successfully",
      data: signup_request[0]
    };
  } catch (error) {
    console.error("Signup request status update error:", error);
    return { success: false, code: 500, message: "Internal server error during signup request status update" };
  }
};

export {
  handle_login,
  handle_refresh_token,
  handle_refresh_token_mobile,
  force_logout_other_devices,
  validate_refresh_token,
  create_signup_request,
  get_signup_request_status,
  get_all_signup_requests,
  update_signup_request_status
};
