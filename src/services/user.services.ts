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
import { eq, and, inArray, ne, sql, or, ilike } from "drizzle-orm";

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

    const [user_details] = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        email: user_model.email,
        role: user_model.role,
        profile_pic: user_model.profile_pic,
        created_at: user_model.created_at,
        last_seen: user_model.last_seen,
        call_access: user_model.call_access,
        online_status: user_model.online_status,
        location: user_model.location,
        ip_address: user_model.ip_address,
      })
      .from(user_model)
      .where(eq(user_model.id, id))
      .limit(1);

    return {
      success: true,
      code: 200,
      message: "User details fetched successfully",
      data: user_details,
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
      .where(eq(user_model.id, id))
      .returning()

    if (user_details.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No Such User",
        data: null,
      };
    }

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

export const get_all_users_paginated = async (page: number = 1, limit: number = 10, search: string = '') => {
  try {
    const offset = (page - 1) * limit;

    // Build search condition
    const searchCondition = search
      ? or(
        ilike(user_model.name, `%${search}%`),
        ilike(user_model.phone, `%${search}%`)
      )
      : undefined;

    // Get total count with search filter
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(user_model)
      .where(searchCondition);

    const totalCount = Number(totalCountResult[0].count);

    // Get paginated users with search filter
    const users = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        email: user_model.email,
        role: user_model.role,
        profile_pic: user_model.profile_pic,
        created_at: user_model.created_at,
        last_seen: user_model.last_seen,
        call_access: user_model.call_access,
        online_status: user_model.online_status,
        location: user_model.location,
        ip_address: user_model.ip_address,
      })
      .from(user_model)
      .where(searchCondition)
      .orderBy(user_model.created_at)
      .limit(limit)
      .offset(offset);

    const totalPages = Math.ceil(totalCount / limit);

    return {
      success: true,
      code: 200,
      message: "Users fetched successfully",
      data: {
        users,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    };
  } catch (error) {
    console.error("Error fetching paginated users:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to fetch users",
      data: null,
    };
  }
};

export const update_user_role = async (id: number, role: RoleType) => {
  try {
    await db
      .update(user_model)
      .set({ role })
      .where(eq(user_model.id, id));

    return {
      success: true,
      code: 200,
      message: "User role updated successfully",
      data: { id, role },
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to update user role",
      data: null,
    };
  }
};

export const update_user_call_access = async (id: number, call_access: boolean) => {
  try {
    await db
      .update(user_model)
      .set({ call_access })
      .where(eq(user_model.id, id));

    return {
      success: true,
      code: 200,
      message: "User call access updated successfully",
      data: { id, call_access },
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to update user call access",
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

export const get_dashboard_stats = async () => {
  try {
    // Get total users count
    const totalUsersResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(user_model);

    // Get online users count
    const onlineUsersResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(user_model)
      .where(eq(user_model.online_status, true));

    // Get sub admins count
    const subAdminsResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(user_model)
      .where(eq(user_model.role, 'sub_admin'));

    // Get users with call access count
    const callAccessResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(user_model)
      .where(eq(user_model.call_access, true));

    return {
      success: true,
      code: 200,
      message: "Dashboard statistics fetched successfully",
      data: {
        totalUsers: Number(totalUsersResult[0].count),
        onlineUsers: Number(onlineUsersResult[0].count),
        subAdmins: Number(subAdminsResult[0].count),
        callAccess: Number(callAccessResult[0].count),
      },
    };
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to fetch dashboard statistics",
      data: null,
    };
  }
};

export const get_all_admins = async () => {
  try {
    const admins = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        email: user_model.email,
        role: user_model.role,
        permissions: user_model.permissions,
        created_at: user_model.created_at,
        online_status: user_model.online_status,
      })
      .from(user_model)
      .where(or(eq(user_model.role, "admin"), eq(user_model.role, "sub_admin")));

    return {
      success: true,
      code: 200,
      data: admins,
    };
  } catch (error: any) {
    console.error("Error fetching admins:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to fetch admins",
      data: null,
    };
  }
};

export const create_admin_user = async (email: string, password: string, permissions: string[]) => {
  try {
    // Check if email already exists
    const existingUser = await db
      .select()
      .from(user_model)
      .where(eq(user_model.email, email))
      .limit(1);

    if (existingUser.length > 0) {
      return {
        success: false,
        code: 400,
        message: "Email already exists",
        data: null,
      };
    }

    // Generate unique ID
    let user_id;
    do {
      user_id = create_unique_id();
    } while ((await find_user_by_id(user_id)).success);

    const hashed_password = await hash_password(password);
    const access_token = generate_jwt(user_id, "sub_admin");
    const refresh_token = generate_refresh_jwt(user_id, "sub_admin");

    // Create the admin user
    const newAdmin = await db
      .insert(user_model)
      .values({
        id: user_id,
        name: email.split("@")[0], // Use email prefix as name
        email: email,
        role: "sub_admin" as RoleType,
        hashed_password,
        refresh_token,
        permissions: permissions,
      })
      .returning({
        id: user_model.id,
        name: user_model.name,
        email: user_model.email,
        role: user_model.role,
        permissions: user_model.permissions,
        created_at: user_model.created_at,
      });

    return {
      success: true,
      code: 201,
      message: "Admin user created successfully",
      data: newAdmin[0],
    };
  } catch (error: any) {
    console.error("Error creating admin user:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to create admin user",
      data: null,
    };
  }
};

export const update_admin_permissions = async (id: number, permissions: string[]) => {
  try {
    // Check if user exists and is an admin
    const user = await db
      .select()
      .from(user_model)
      .where(eq(user_model.id, id))
      .limit(1);

    if (user.length === 0) {
      return {
        success: false,
        code: 404,
        message: "User not found",
        data: null,
      };
    }

    if (user[0].role !== "sub_admin") {
      return {
        success: false,
        code: 400,
        message: "Can only update permissions for sub-admins",
        data: null,
      };
    }

    // Update permissions
    const updatedAdmin = await db
      .update(user_model)
      .set({ permissions: permissions })
      .where(eq(user_model.id, id))
      .returning({
        id: user_model.id,
        name: user_model.name,
        email: user_model.email,
        role: user_model.role,
        permissions: user_model.permissions,
      });

    return {
      success: true,
      code: 200,
      message: "Admin permissions updated successfully",
      data: updatedAdmin[0],
    };
  } catch (error: any) {
    console.error("Error updating admin permissions:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to update admin permissions",
      data: null,
    };
  }
};

export const update_admin_status = async (id: number, active: boolean) => {
  try {
    // Check if user exists and is an admin
    const user = await db
      .select()
      .from(user_model)
      .where(eq(user_model.id, id))
      .limit(1);

    if (user.length === 0) {
      return {
        success: false,
        code: 404,
        message: "User not found",
        data: null,
      };
    }

    if (user[0].role !== "sub_admin") {
      return {
        success: false,
        code: 400,
        message: "Can only update status for sub-admins",
        data: null,
      };
    }

    // Update status by updating online_status field (using it as active/inactive status)
    const updatedAdmin = await db
      .update(user_model)
      .set({ online_status: active })
      .where(eq(user_model.id, id))
      .returning({
        id: user_model.id,
        name: user_model.name,
        email: user_model.email,
        role: user_model.role,
        online_status: user_model.online_status,
      });

    return {
      success: true,
      code: 200,
      message: `Admin ${active ? 'activated' : 'deactivated'} successfully`,
      data: updatedAdmin[0],
    };
  } catch (error: any) {
    console.error("Error updating admin status:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to update admin status",
      data: null,
    };
  }
};

export const get_user_permissions = async (id: number) => {
  try {
    const user = await db
      .select({
        id: user_model.id,
        role: user_model.role,
        permissions: user_model.permissions,
        online_status: user_model.online_status,
      })
      .from(user_model)
      .where(eq(user_model.id, id))
      .limit(1);

    if (user.length === 0) {
      return {
        success: false,
        code: 404,
        message: "User not found",
        data: null,
      };
    }

    const userData = user[0];

    // Super admin has all permissions
    if (userData.role === "admin") {
      return {
        success: true,
        code: 200,
        data: {
          role: userData.role,
          permissions: ["dashboard", "manage-chats", "manage-groups", "admin-management"],
          active: true,
        },
      };
    }

    // Sub-admin permissions
    if (userData.role === "sub_admin") {
      return {
        success: true,
        code: 200,
        data: {
          role: userData.role,
          permissions: userData.permissions || [],
          active: userData.online_status,
        },
      };
    }

    return {
      success: false,
      code: 403,
      message: "User is not an admin",
      data: null,
    };
  } catch (error: any) {
    console.error("Error fetching user permissions:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to fetch user permissions",
      data: null,
    };
  }
};
