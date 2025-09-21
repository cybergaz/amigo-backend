import db from "@/config/db";
import { UpdateUserType, user_model } from "@/models/user.model";
import { RoleType } from "@/types/user.types";
import {
  create_unique_id,
  generate_jwt,
  generate_refresh_jwt,
  hash_password,
  parse_phone,
} from "@/utils/general.utils";
import { upload_image_to_s3, delete_image_from_s3, generate_profile_image_key } from "@/services/s3.service";
import { eq, and, inArray, ne } from "drizzle-orm";

type CreateUserParams = {
  name: string;
  password: string | undefined | null;
  role: RoleType;
  phone: string;
};

export const create_user = async ({
  name,
  password,
  role,
  phone,
}: CreateUserParams) => {
  try {
    let user_id;
    do {
      user_id = create_unique_id();
    } while ((await find_user_by_id(user_id)).success);

    let hashed_password;
    if (!password || password === null) {
      hashed_password = undefined;
    } else {
      hashed_password = await hash_password(password);
    }

    const access_token = generate_jwt(user_id, role);
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
    };
  } catch (error: any) {
    if (error?.cause?.code === "23505") {
      return {
        success: false,
        code: 409,
        message: "Phone number already exists",
      };
    }

    return {
      success: false,
      code: 500,
      message: "Internal Server Error",
    };
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
      await db
        .select()
        .from(user_model)
        .where(eq(user_model.phone, phone))
        .limit(1)
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
    console.log("error ->", error)
    return { success: false, code: 500, message: "ERROR : find_user_by_phone" };
  }
};

export const get_user_details = async (id: number) => {
  try {
    if (!id) {
      return {
        success: false,
        code: 400,
        message: "Invalid request",
        data: null,
      };
    }
    const user_details = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        role: user_model.role,
        profile_pic: user_model.profile_pic,
      })
      .from(user_model)
      .where(eq(user_model.id, id));

    return {
      success: true,
      code: 200,
      message: "User details fetched successfully",
      data: user_details[0],
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to get user details",
      data: null,
    };
  }
};

export const update_user_details = async (id: number, body: UpdateUserType) => {
  try {
    const user_details = await db
      .update(user_model)
      .set(body)
      .where(eq(user_model.id, id));

    return {
      success: true,
      code: 200,
      message: "User details updated successfully",
      data: user_details[0],
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to update user details",
      data: null,
    };
  }
};

export const get_all_users = async () => {
  try {
    const users = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        role: user_model.role,
        profile_pic: user_model.profile_pic,
      })
      .from(user_model);
    return {
      success: true,
      code: 200,
      message: "Users fetched successfully",
      data: users[0],
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to fetch users",
      data: null,
    };
  }
};

export const get_available_users = async (self_id: number, phone_numbers: string[]) => {
  // console.log("phone_numbers ->", phone_numbers)

  if (phone_numbers.length === 0) {
    return {
      success: false,
      code: 404,
      message: "No phone numbers provided",
    };
  }
  // console.log("phone_numbers ->", phone_numbers)
  const cleaned_phone_numbers = phone_numbers.map((phone) => phone.replace(" ", ""));
  // console.log("cleaned_phone_numbers ->", cleaned_phone_numbers)
  // console.log("parsed_phone_numbers ->", parsed_phone_numbers)


  try {
    const users = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        profile_pic: user_model.profile_pic,
      })
      .from(user_model)
      .where(and(
        inArray(user_model.phone, cleaned_phone_numbers),
        ne(user_model.id, self_id)
      ));

    if (users.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No users found",
        data: [],
      };
    }

    return {
      success: true,
      code: 200,
      message: "Users fetched successfully",
      data: users,
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to fetch users",
      data: null,
    };
  }
};

export const update_profile_image = async (id: number, file: File) => {
  try {
    if (!id) {
      return {
        success: false,
        code: 400,
        message: "Invalid request",
        data: null,
      };
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      return {
        success: false,
        code: 400,
        message: "Invalid file type. Only JPEG, PNG, and WebP images are allowed.",
        data: null,
      };
    }

    // Validate file size (5MB limit)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return {
        success: false,
        code: 400,
        message: "File size too large. Maximum size is 5MB.",
        data: null,
      };
    }

    // Get current user to check for existing profile image
    const currentUser = await find_user_by_id(id);
    if (!currentUser.success) {
      return currentUser;
    }

    // Generate new image key
    const imageKey = generate_profile_image_key(id, file.name);

    // Upload new image to S3
    const uploadResult = await upload_image_to_s3(file, imageKey);
    if (!uploadResult.success) {
      return {
        success: false,
        code: 500,
        message: uploadResult.error || "Failed to upload image",
        data: null,
      };
    }

    // Delete old profile image if it exists
    if (currentUser.data?.profile_pic) {
      const oldImageKey = currentUser.data.profile_pic.split('/').slice(-2).join('/'); // Extract key from URL
      await delete_image_from_s3(oldImageKey);
    }

    // Update user profile with new image URL
    await db
      .update(user_model)
      .set({ profile_pic: uploadResult.url })
      .where(eq(user_model.id, id));

    return {
      success: true,
      code: 200,
      message: "Profile image updated successfully",
      data: {
        profile_pic: uploadResult.url,
      },
    };
  } catch (error: any) {
    console.error("Error updating profile image:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to update profile image",
      data: null,
    };
  }
};
