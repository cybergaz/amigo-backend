import { user_model } from "@/models/user.model";
import db from "@/config/db";
import {
  compare_password,
  generate_jwt,
  generate_refresh_jwt,
} from "@/utils/general.utils";
import { eq } from "drizzle-orm";

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

    const access_token = generate_jwt(user.id, user.role || false);
    const refresh_token = generate_refresh_jwt(user.id, user.role);

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

export { handle_login };
