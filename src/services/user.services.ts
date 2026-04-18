import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { UpdateUserType, user_model } from "@/models/user.model";
import { RoleType } from "@/types/user.types";
import {
  generate_jwt,
  generate_refresh_jwt,
  hash_password,
  parse_phone,
} from "@/utils/general.utils";
import { upload_image_to_s3, delete_image_from_s3, generate_profile_image_key } from "@/services/s3.service";
import { eq, and, inArray, isNull, ne, sql, or, ilike } from "drizzle-orm";
import { store_fcm_token } from "@/cache-management/fcm-token.cache";
import { remove_member, invalidate_user_conversations } from "@/cache-management/conv.cache";
import { polling_connections, socket_connections } from "@/sockets/socket.server";

type CreateUserParams = {
  name: string;
  password: string | undefined | null;
  role: RoleType;
  phone: string;
};

const create_user = async ({
  name,
  password,
  role,
  phone,
}: CreateUserParams) => {
  try {
    // let user_id;
    // do {
    //   user_id = create_unique_id();
    // } while ((await find_user_by_id(user_id)).success);

    let hashed_password;
    if (!password || password === null) {
      hashed_password = undefined;
    } else {
      hashed_password = await hash_password(password);
    }

    const [new_user] = await db
      .insert(user_model)
      .values({
        name,
        role,
        phone: phone.replace(" ", ""),
        hashed_password,
        call_access: true,
      })
      .returning();

    const access_token = generate_jwt(new_user.id, role, "7d");
    const refresh_token = generate_refresh_jwt(new_user.id, role, "90d");

    await db
      .update(user_model)
      .set({ refresh_token })
      .where(eq(user_model.id, new_user.id));

    return {
      success: true,
      code: 200,
      message: "User Created Successfully",
      data: {
        id: new_user.id,
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
      message: "Failed to create user, Please try again.",
    };
  }
};

const find_user_by_id = async (id: string) => {
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

const find_user_by_phone = async (phone: string) => {
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
    return { success: false, code: 500, message: "ERROR : find_user_by_phone" };
  }
};

const get_user_details = async (id: string) => {
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
        // online_status: user_model.online_status,
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

const update_user_details = async (id: string, body: UpdateUserType) => {
  try {
    // If fcm_token is being updated, update the cache first
    if (body.fcm_token !== undefined) {
      await store_fcm_token(id, body.fcm_token || null);
    }

    const user_details = await db
      .update(user_model)
      .set(body)
      .where(eq(user_model.id, id))
      .returning();

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

const batch_update_users_details = async (ids: string[], body: UpdateUserType) => {
  try {
    const users_details = await db
      .update(user_model)
      .set(body)
      .where(inArray(user_model.id, ids))
      .returning();

    if (users_details.length === 0) {
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
      data: users_details,
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

const get_all_users = async () => {
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

const get_available_users = async (self_id: string, phone_numbers: string[]) => {
  // console.log("phone_numbers ->", phone_numbers)

  const [self] = await db
    .select()
    .from(user_model)
    .where(eq(user_model.id, self_id))
    .limit(1);

  if (!self) {
    return {
      success: false,
      code: 404,
      message: "User not found",
      data: null,
    };
  }

  if (phone_numbers.length === 0) {
    return {
      success: false,
      code: 404,
      message: "No phone numbers provided",
    };
  }

  const default_country_code = parse_phone(self.phone!).code;

  // console.log("phone_numbers ->", phone_numbers)
  // const cleaned_phone_numbers = phone_numbers.map((phone) => phone.replace(" ", ""));
  const parsed_phone_numbers = phone_numbers.map((phone) => parse_phone(phone, default_country_code).concatinated);
  // console.log("cleaned_phone_numbers ->", cleaned_phone_numbers)
  // console.log("parsed_phone_numbers ->", parsed_phone_numbers)


  try {
    const users = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        role: user_model.role,
        phone: user_model.phone,
        profile_pic: user_model.profile_pic,
      })
      .from(user_model)
      .where(and(
        inArray(user_model.phone, parsed_phone_numbers),
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

const get_all_users_paginated = async (page: number = 1, limit: number = 10, search: string = '', role: string) => {
  try {
    const offset = (page - 1) * limit;

    // Build search condition
    const searchCondition = search
      ? or(
        ilike(user_model.name, `%${search}%`),
        ilike(user_model.phone, `%${search}%`),
      )
      : role !== "all" ? eq(user_model.role, role as RoleType) : undefined;

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
        location: user_model.location,
        ip_address: user_model.ip_address,
        app_version: user_model.app_version,
      })
      .from(user_model)
      .where(searchCondition)
      .orderBy(user_model.created_at)
      .limit(limit)
      .offset(offset);
    // console.log("users ->", users)
    // console.log("role ->", role)

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

const update_user_role = async (id: string, role: RoleType) => {
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

// const update_user_connection_status = async (_id: string, _status: string) => {
//   // online_status and connection_status columns removed from user model
//   // Connection status is now tracked only in-memory via socket_connections map
//   return { success: true, code: 200, message: "No-op: connection status tracked in-memory only" };
// };

const update_user_call_access = async (id: string, call_access: boolean) => {
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

const update_profile_image = async (id: string, file: File) => {
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

const get_dashboard_stats = async () => {
  try {
    // Get total users count
    const totalUsersResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(user_model);

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
        onlineUsers: socket_connections.size + polling_connections.size,
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

const get_all_admins = async () => {
  try {
    const admins = await db
      .select({
        id: user_model.id,
        name: user_model.name,
        email: user_model.email,
        role: user_model.role,
        permissions: user_model.permissions,
        created_at: user_model.created_at,
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

const create_admin_user = async (email: string, password: string, permissions: string[]) => {
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
    // let user_id;
    // do {
    //   user_id = create_unique_id();
    // } while ((await find_user_by_id(user_id)).success);

    const hashed_password = await hash_password(password);

    // Create the admin user
    const [new_admin] = await db
      .insert(user_model)
      .values({
        name: email.split("@")[0], // Use email prefix as name
        email: email,
        role: "sub_admin" as RoleType,
        call_access: true,
        hashed_password,
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

    const access_token = generate_jwt(new_admin.id, "sub_admin");
    const refresh_token = generate_refresh_jwt(new_admin.id, "sub_admin");

    // store refresh token in database
    await db
      .update(user_model)
      .set({ refresh_token })
      .where(eq(user_model.id, new_admin.id));

    return {
      success: true,
      code: 201,
      message: "Admin user created successfully",
      data: new_admin
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

const update_admin_permissions = async (id: string, permissions: string[]) => {
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

const update_admin_status = async (_id: string, _active: boolean) => {
  // online_status column removed from user model
  // Admin active/inactive status needs a dedicated column if required
  return { success: true, code: 200, message: "No-op: online_status column removed", data: null };
};

const get_user_permissions = async (id: string) => {
  try {
    const user = await db
      .select({
        id: user_model.id,
        role: user_model.role,
        permissions: user_model.permissions,
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

const delete_user_permanently = async (user_id: string) => {
  try {
    // Check if user exists
    const existingUser = await db
      .select()
      .from(user_model)
      .where(eq(user_model.id, user_id));

    if (existingUser.length === 0) {
      return {
        success: false,
        code: 404,
        message: "User not found",
        data: null,
      };
    }

    const user = existingUser[0];

    // Prevent deletion of admin users
    if (user.role === "admin" || user.role === "sub_admin") {
      return {
        success: false,
        code: 403,
        message: "Cannot delete admin or sub-admin users. Please change their role first.",
        data: null,
      };
    }

    // Delete user's profile image from S3 if exists
    if (user.profile_pic) {
      try {
        await delete_image_from_s3(user.profile_pic);
      } catch (error) {
        console.error("Error deleting profile image from S3:", error);
        // Continue with user deletion even if S3 deletion fails
      }
    }

    // Remove user from redis conversation member sets to avoid stale cache
    try {
      const conversations = await db
        .select({ chat_id: chat_member_model.chat_id })
        .from(chat_member_model)
        .where(
          and(
            eq(chat_member_model.user_id, user_id),
            isNull(chat_member_model.removed_at),
          ),
        );

      const convIds = Array.from(
        new Set(conversations.map((row) => row.chat_id)),
      );

      for (const convId of convIds) {
        await remove_member(user_id, convId);
      }
      await invalidate_user_conversations(user_id);
    } catch (error) {
      console.error("Error removing user from redis conversations:", error);
    }

    // Delete the user permanently from database
    const deletedUser = await db
      .delete(user_model)
      .where(eq(user_model.id, user_id))
      .returning();

    if (deletedUser.length === 0) {
      return {
        success: false,
        code: 500,
        message: "Failed to delete user",
        data: null,
      };
    }

    return {
      success: true,
      code: 200,
      message: "User deleted permanently and successfully",
      data: { id: user_id, name: user.name },
    };
  } catch (error: any) {
    console.error("Error deleting user:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to delete user",
      data: null,
    };
  }
};

const admin_update_user_phone_number = async (user_id: string, new_phone: string) => {
  // const parsed_new_phone = parse_phone(new_phone)
  try {
    const [existingUser] = await db
      .select()
      .from(user_model)
      .where(eq(user_model.id, user_id))
      .limit(1);

    if (!existingUser || existingUser.phone === null) {
      return {
        success: false,
        code: 404,
        message: "Either user or phone number for user not found",
        data: null,
      };
    }


    // Check if new phone number already exists for another user
    const phoneExists = await db
      .select()
      .from(user_model)
      .where(
        and(
          eq(user_model.phone, new_phone.replace(" ", "")),
          ne(user_model.id, user_id),
        ),
      )
      .limit(1);

    if (phoneExists.length > 0) {
      return {
        success: false,
        code: 409,
        message: "Phone number already in use by another user",
        data: null,
      };
    }

    // Update user's phone number
    const updatedUser = await db
      .update(user_model)
      .set({ phone: new_phone.replace(" ", "") })
      .where(eq(user_model.id, user_id))
      .returning({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        email: user_model.email,
        role: user_model.role,
        profile_pic: user_model.profile_pic,
        created_at: user_model.created_at,
        last_seen: user_model.last_seen,
        call_access: user_model.call_access,
        location: user_model.location,
        ip_address: user_model.ip_address,
      });

    return {
      success: true,
      code: 200,
      message: "User phone number updated successfully",
      data: updatedUser[0],
    };
  }
  catch (error) {
    console.error("Error changing user phone number:", error);
    return {
      success: false,
      code: 500,
      message: "Failed to change user phone number",
      data: null,
    };
  }
};

export {
  create_user,
  find_user_by_id,
  find_user_by_phone,
  get_user_details,
  update_user_details,
  batch_update_users_details,
  get_all_users,
  get_available_users,
  get_all_users_paginated,
  update_user_role,
  // update_user_connection_status,
  update_user_call_access,
  update_profile_image,
  get_dashboard_stats,
  get_all_admins,
  create_admin_user,
  update_admin_permissions,
  update_admin_status,
  get_user_permissions,
  delete_user_permanently,
  admin_update_user_phone_number,
};
