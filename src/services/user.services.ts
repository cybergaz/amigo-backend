import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { RoleType } from "@/types/user.types";
import { create_unique_id, generate_jwt, generate_refresh_jwt, hash_password } from "@/utils/general.utils";
import { eq } from "drizzle-orm";

type CreateUserParams = {
  name: string;
  password: string | undefined | null;
  role: RoleType;
  phone: string;
};

export const create_user = async ({ name, password, role, phone }: CreateUserParams) => {
  try {
    let user_id;
    do { user_id = create_unique_id() } while ((await find_user_by_id(user_id)).success);

    let hashed_password;
    if (!password || password === null) {
      hashed_password = undefined;
    }
    else {
      hashed_password = await hash_password(password);
    }

    const access_token = generate_jwt(user_id, role, false);
    const refresh_token = generate_refresh_jwt(user_id, role);

    await db
      .insert(user_model)
      .values({
        id: user_id,
        name,
        role,
        phone,
        hashed_password,
        refresh_token,
      })
      .returning();

    return {
      success: true,
      code: 200,
      message: "User Created Successfully",
      data: {
        user_id,
        name,
        role,
        phone,
        refresh_token,
        access_token,
      },
    }

  }
  catch (error: any) {
    if (error?.cause?.code === "23505") {
      return {
        success: false,
        code: 409,
        message: "Phone number already exists",
      };
    };

    return {
      success: false,
      code: 500,
      message: "Internal Server Error",
    }
  }
};


export const find_user_by_id = async (id: number) => {
  try {
    const existing_user = (
      await db.select().from(user_model).where(eq(user_model.id, id)).limit(1)
    )[0];
    if (!existing_user) {
      return { success: false, code: 404, message: "No Such User" };
    }
    return {
      success: true,
      code: 200,
      message: "User Exists",
      data: existing_user,
    };
  } catch (error) {
    return { success: false, code: 500, message: "ERROR : find_user_by_id" };
  }
};

export const find_user_by_phone = async (phone: string) => {
  try {
    const existing_user = (
      await db.select().from(user_model).where(eq(user_model.phone, phone)).limit(1)
    )[0];
    if (!existing_user) {
      return { success: false, code: 404, message: "No Such User" };
    }
    return {
      success: true,
      code: 200,
      message: "User Exists",
      data: existing_user,
    };
  } catch (error) {
    return { success: false, code: 500, message: "ERROR : find_user_by_phone" };
  }
};



