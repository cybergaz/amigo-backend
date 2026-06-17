import { signup_request_model, UpdateSignupRequestType, user_model } from "@/models/user.model";
import db from "@/config/db";
import {
  compare_password,
  generate_jwt,
} from "@/utils/general.utils";
import { eq, desc } from "drizzle-orm";
import { socket_connections } from "@/sockets/socket.server";
import { MiscPayload } from "@/types/socket.types";
import { create_user } from "./user.services";
import {
  create_session,
  revoke_user_sessions,
  rotate_refresh_token,
  validate_session,
} from "./session.service";

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

    // Single-device: WS-kick the live socket, drop every other session, then mint a
    // fresh session-bound refresh token. Clear the legacy column too, so any stale
    // pre-sessions token for this user can't be replayed via the refresh fallback.
    await force_logout_other_devices(user.id);
    await revoke_user_sessions(user.id);
    const refresh_token = await create_session(user.id, user.role, "90d");
    await db
      .update(user_model)
      .set({ refresh_token: null })
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

// Web refresh: short-lived access (1d) + 7d refresh, grace-aware rotation.
const handle_refresh_token = (token: string) =>
  rotate_refresh_token(token, { access: "1d", refresh: "7d" });

// Mobile refresh: 1d access + 30d refresh, grace-aware rotation.
const handle_refresh_token_mobile = (token: string) =>
  rotate_refresh_token(token, { access: "1d", refresh: "30d" });

// Validate if a refresh token still maps to a live session (or a legacy column
// token). Lightweight, read-only.
const validate_refresh_token = (token: string) => validate_session(token);

// Force logout all other devices when a user logs in on a new device
// This sends a WebSocket message to all active connections for the user
// and closes those connections
const force_logout_other_devices = async (user_id: string): Promise<void> => {
  try {
    const connection = socket_connections.get(user_id);

    if (connection && connection.ws.readyState === 1) {
      // Send force logout message to the existing connection
      const force_logout_message = {
        type: 'auth:force_logout' as const,
        payload: {
          message: 'You have been logged out because you logged in on another device',
          code: 499,
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

const create_signup_request = async ({ first_name, last_name, phone }: { first_name: string; last_name: string; phone: string; }) => {
  try {
    const signup_request = await db
      .insert(signup_request_model)
      .values({
        first_name,
        last_name,
        phone,
      })
      .returning();
    if (!signup_request) {
      return {
        success: false,
        code: 404,
        message: "Signup request not created"
      };
    }

    // ---------------------------------------------------------
    // temporarily auto-accepting all signup requests
    // ---------------------------------------------------------
    await update_signup_request_status({
      phone,
      first_name,
      last_name,
      status: "accepted",
    });

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

const DEMO_USER_PHONE = '+10000000000';
const DEMO_USER_NAME = 'Demo User';

const demo_login = async () => {
  try {
    // Find existing demo user
    let demo_user = await db
      .select()
      .from(user_model)
      .where(eq(user_model.phone, DEMO_USER_PHONE))
      .then((res) => res[0]);

    // Create demo user if doesn't exist
    if (!demo_user) {
      const create_res = await create_user({
        name: DEMO_USER_NAME,
        password: null,
        role: 'user',
        phone: DEMO_USER_PHONE,
      });

      if (!create_res.success) {
        return { success: false, code: 500, message: 'Failed to create demo account' };
      }

      demo_user = await db
        .select()
        .from(user_model)
        .where(eq(user_model.phone, DEMO_USER_PHONE))
        .then((res) => res[0]);
    }

    if (!demo_user) {
      return { success: false, code: 500, message: 'Demo account unavailable' };
    }

    const access_token = generate_jwt(demo_user.id, demo_user.role || false, '7d');

    // Demo accounts intentionally allow concurrent sessions — create a session
    // without revoking the others.
    const refresh_token = await create_session(demo_user.id, demo_user.role, '30d');

    return {
      success: true,
      code: 200,
      message: 'Demo login successful',
      data: {
        id: demo_user.id,
        name: demo_user.name,
        role: demo_user.role,
        phone: demo_user.phone,
        email: demo_user.email,
        profile_pic: demo_user.profile_pic,
        call_access: demo_user.call_access,
        created_at: demo_user.created_at,
        refresh_token,
        access_token,
      },
    };
  } catch (error: any) {
    console.error('Demo login error:', error);
    return {
      success: false,
      code: 500,
      message: 'Internal server error during demo login',
    };
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
  update_signup_request_status,
  demo_login,
};
