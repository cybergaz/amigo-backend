import db from "@/config/db";
import { chat_member_model } from "@/models/chat.model";
import { UpdateUserType, user_model } from "@/models/user.model";
import { pin_reset_request_model } from "@/models/pin-reset-request.model";
import { RoleType } from "@/types/user.types";
import {
  compare_pin,
  generate_jwt,
  hash_password,
  hash_pin,
  is_valid_pin,
  parse_phone,
  to_e164,
} from "@/utils/general.utils";
import { clear_pin_attempts } from "./pin-lockout.service";
import { create_session, login_device } from "./session.service";
import { upload_image_to_s3, delete_image_from_s3, generate_profile_image_key } from "@/services/s3.service";
import { eq, and, inArray, isNull, ne, sql, or, ilike } from "drizzle-orm";
import { store_fcm_token } from "@/cache-management/fcm-token.cache";
import { remove_member, get_conversation_members, get_user_conversations, invalidate_user_conversations } from "@/cache-management/conv.cache";
import { polling_connections, socket_connections } from "@/sockets/socket.server";
import { broadcast_message } from "@/sockets/socket.handlers";
import type { UserUpdatePayload } from "@/types/socket.types";

type CreateUserParams = {
  name: string;
  password: string | undefined | null;
  role: RoleType;
  phone: string;
  // Mobile signup sets the login (password) PIN here. Hashed into password_pin_hash,
  // kept separate from `password`/hashed_password (that's the web/email password).
  password_pin?: string | null;
  // Mobile signup: presence routes to the device-JWT mint (see create_user).
  device?: { device_id: string; platform?: string; device_name?: string };
};

const create_user = async ({
  name,
  password,
  role,
  phone,
  password_pin,
  device,
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

    // Login PIN set at signup (mobile). Peppered + bcrypt via hash_pin.
    const password_pin_hash =
      password_pin ? await hash_pin(password_pin) : undefined;

    // Persist the canonical E.164 form so the stored number always matches what
    // OTP generation/verification used (and never a doubled "+9191…" string).
    const canonical_phone = to_e164(phone);

    const [new_user] = await db
      .insert(user_model)
      .values({
        name,
        role,
        phone: canonical_phone,
        hashed_password,
        password_pin_hash,
        call_access: true,
      })
      .returning();

    // Mobile device signup → single long-lived device JWT (no cookies/refresh).
    if (device) {
      const { token } = await login_device(new_user.id, role, device);
      return {
        success: true,
        code: 200,
        message: "User Created Successfully",
        data: {
          id: new_user.id,
          name,
          role,
          phone: canonical_phone,
          has_password_pin: new_user.password_pin_hash != null,
          has_admin_pin: new_user.admin_pin_hash != null,
          token,
        },
      };
    }

    const access_token = generate_jwt(new_user.id, role, "7d");
    // Brand-new account → first session. No other sessions to revoke.
    const refresh_token = await create_session(new_user.id, role, "90d");

    return {
      success: true,
      code: 200,
      message: "User Created Successfully",
      data: {
        id: new_user.id,
        name,
        role,
        phone: canonical_phone,
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
        // PIN-auth flags: booleans only (never the hashes). Drive the app's
        // create-PIN enforcement gate + the Settings "PIN set / not set" state.
        has_password_pin: sql<boolean>`(${user_model.password_pin_hash} IS NOT NULL)`,
        has_admin_pin: sql<boolean>`(${user_model.admin_pin_hash} IS NOT NULL)`,
        // Drives the app's forced create-PIN gate for admin-provisioned / admin-reset
        // accounts (coalesce so a legacy NULL row reads false, never blocks).
        must_reset_pin: sql<boolean>`COALESCE(${user_model.must_reset_pin}, false)`,
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

    // Capture pre-update profile pic so we can include it in the WS broadcast
    // — clients use it as the cache key to evict the old asset.
    let previous_profile_pic: string | null | undefined;
    if (body.profile_pic !== undefined) {
      const existing = await find_user_by_id(id);
      previous_profile_pic = existing.success ? (existing.data?.profile_pic ?? null) : undefined;
    }

    // Explicit projection — NEVER a bare .returning() here: that would ship
    // hashed_password / password_pin_hash / admin_pin_hash back to the client.
    const user_details = await db
      .update(user_model)
      .set(body)
      .where(eq(user_model.id, id))
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
        app_version: user_model.app_version,
      });

    if (user_details.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No Such User",
        data: null,
      };
    }

    // Broadcast a user:update only when something visible to peers changed
    // (name or profile pic). Other fields like fcm_token / location are
    // private and don't need a fanout.
    if (body.name !== undefined || body.profile_pic !== undefined) {
      // fire-and-forget — don't fail the route if fanout misses
      broadcast_user_update({
        user_id: id,
        name: body.name,
        profile_pic: body.profile_pic,
        previous_profile_pic,
      }).catch((err) => console.error("[USER:UPDATE] broadcast failed:", err));
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

// Broadcast a user:update to every distinct peer that shares a conversation
// with this user. Self is excluded by default — the updater already has the
// latest data from their own API response. Set `include_self` for cases like
// role changes pushed from the admin panel, where the target user themselves
// needs the new role on their device without having to log out.
const broadcast_user_update = async (args: {
  user_id: string;
  name?: string;
  profile_pic?: string | null;
  previous_profile_pic?: string | null;
  role?: string;
  include_self?: boolean;
}) => {
  const conv_ids = Array.from(await get_user_conversations(args.user_id));

  const recipient_ids = new Set<string>();
  await Promise.all(
    conv_ids.map(async (conv_id) => {
      const members = await get_conversation_members(conv_id);
      for (const member_id of members) {
        if (member_id !== args.user_id) recipient_ids.add(member_id);
      }
    })
  );

  if (args.include_self) recipient_ids.add(args.user_id);

  if (recipient_ids.size === 0) return;

  const payload: UserUpdatePayload = {
    user_id: args.user_id,
    name: args.name,
    profile_pic: args.profile_pic,
    previous_profile_pic: args.previous_profile_pic ?? null,
    role: args.role,
    updated_at: new Date(),
  };

  await broadcast_message({
    to: "users",
    user_ids: Array.from(recipient_ids),
    message: {
      type: "user:update",
      payload,
      ws_timestamp: new Date(),
    },
  });
};

const batch_update_users_details = async (ids: string[], body: UpdateUserType) => {
  try {
    const users_details = await db
      .update(user_model)
      .set(body)
      .where(inArray(user_model.id, ids))
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
        app_version: user_model.app_version,
      });

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

  // Normalize every raw device number to canonical E.164 for the lookup, while
  // remembering which original raw string produced each normalized number.
  // Multiple raw formats can collapse to the same E.164 — keep the first one.
  // The client re-uses `matched_input` to re-link a returned user back to the
  // exact device-contact string it sent, so it can resolve the saved name
  // (the canonical phone we store rarely matches the raw on-device format).
  const norm_to_raw = new Map<string, string>();
  for (const raw of phone_numbers) {
    const normalized = parse_phone(raw, default_country_code).concatinated;
    if (!norm_to_raw.has(normalized)) norm_to_raw.set(normalized, raw);
  }
  // Deduped keys keep the `IN (...)` list as small as the distinct number set.
  const parsed_phone_numbers = [...norm_to_raw.keys()];


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

    // Echo back the original raw input each user matched on so the client can
    // map this canonical phone back to a device contact and read its name.
    const data = users.map((u) => ({
      ...u,
      matched_input: norm_to_raw.get(u.phone!) ?? u.phone,
    }));

    return {
      success: true,
      code: 200,
      message: "Users fetched successfully",
      data,
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

    // Push the new role to the target user (self) AND all peers via the vital
    // `user:update` channel so role-gated UI updates without a re-login. The
    // event is already in VITAL_WS_EVENTS_CONST, so offline users will pick it
    // up via the polling/missed-message cache on their next reconnect.
    broadcast_user_update({
      user_id: id,
      role,
      include_self: true,
    }).catch((err) => console.error("[USER:UPDATE] role broadcast failed:", err));

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

    // Notify peers so they can refresh cached PFPs in their UI.
    broadcast_user_update({
      user_id: id,
      profile_pic: uploadResult.url ?? null,
      previous_profile_pic: currentUser.data?.profile_pic ?? null,
    }).catch((err) => console.error("[USER:UPDATE] broadcast failed:", err));

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
    // New admin → first session (7d refresh, matching the prior default).
    const refresh_token = await create_session(new_admin.id, "sub_admin", "7d");

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

// Admin provisions a brand-new user with a phone + a starter password PIN. The
// user has NO admin PIN yet and is flagged `must_reset_pin` so that on first login
// the app forces them to set their OWN password PIN (+ the admin PIN). No token is
// minted — the user logs in themselves via phone + PIN afterwards.
const admin_create_user = async ({
  name,
  phone,
  password_pin,
  role = "user",
}: {
  name: string;
  phone: string;
  password_pin: string;
  role?: RoleType;
}) => {
  try {
    const trimmed_name = (name ?? "").trim();
    if (!trimmed_name) {
      return { success: false, code: 400, message: "Name is required", data: null };
    }
    if (!phone || !phone.trim()) {
      return { success: false, code: 400, message: "Phone number is required", data: null };
    }
    if (!is_valid_pin(password_pin)) {
      return { success: false, code: 400, message: "PIN must be exactly 4 digits", data: null };
    }

    const canonical_phone = to_e164(phone);
    const password_pin_hash = await hash_pin(password_pin);

    const [new_user] = await db
      .insert(user_model)
      .values({
        name: trimmed_name.slice(0, 60),
        role,
        phone: canonical_phone,
        password_pin_hash,
        must_reset_pin: true,
        call_access: true,
      })
      .returning({
        id: user_model.id,
        name: user_model.name,
        phone: user_model.phone,
        role: user_model.role,
        created_at: user_model.created_at,
      });

    return {
      success: true,
      code: 201,
      message: "User created successfully",
      data: new_user,
    };
  } catch (error: any) {
    if (error?.cause?.code === "23505") {
      return { success: false, code: 409, message: "A user with this phone number already exists", data: null };
    }
    console.error("admin_create_user error:", error);
    return { success: false, code: 500, message: "Failed to create user", data: null };
  }
};

// Admin sets/overwrites a user's LOGIN (password) PIN — e.g. fulfilling a forgot-PIN
// request. Re-flags `must_reset_pin` (the admin now knows the PIN, so the user must
// set their own on next login), clears any brute-force lock so they can log straight
// in, and auto-resolves the user's pending reset request(s). Never touches the admin
// PIN. `admin_id` is recorded as the resolver.
// `restrict_to_unprivileged` is set by the sub-admin path (mobile): a sub-admin may
// only reset PINs for ordinary accounts, never for an admin/sub_admin — otherwise a
// sub-admin could set a super-admin's login PIN to a known value and take the account
// over. The super-admin panel path leaves it false (top authority, any target).
const admin_set_user_password_pin = async (
  user_id: string,
  pin: string,
  admin_id: string,
  restrict_to_unprivileged = false,
) => {
  try {
    if (!is_valid_pin(pin)) {
      return { success: false, code: 400, message: "PIN must be exactly 4 digits", data: null };
    }

    const [user] = await db
      .select({
        id: user_model.id,
        phone: user_model.phone,
        role: user_model.role,
        admin_pin_hash: user_model.admin_pin_hash,
      })
      .from(user_model)
      .where(eq(user_model.id, user_id))
      .limit(1);

    if (!user) {
      return { success: false, code: 404, message: "User not found", data: null };
    }

    if (restrict_to_unprivileged && (user.role === "admin" || user.role === "sub_admin")) {
      return { success: false, code: 403, message: "You can't change an admin's PIN", data: null };
    }

    // The new login PIN must differ from the user's admin PIN (if they have one),
    // mirroring the "two PINs must differ" rule enforced everywhere else.
    if (user.admin_pin_hash && (await compare_pin(pin, user.admin_pin_hash))) {
      return { success: false, code: 409, message: "This PIN matches the user's admin PIN — choose a different one", data: null };
    }

    const new_hash = await hash_pin(pin);
    await db
      .update(user_model)
      .set({ password_pin_hash: new_hash, must_reset_pin: true })
      .where(eq(user_model.id, user_id));

    // Let them log in immediately with the new PIN.
    if (user.phone) await clear_pin_attempts(user.phone);

    // Fulfil any pending reset request(s) for this user.
    await db
      .update(pin_reset_request_model)
      .set({ status: "accepted", resolved_by: admin_id, resolved_at: new Date() })
      .where(and(
        eq(pin_reset_request_model.user_id, user_id),
        eq(pin_reset_request_model.status, "pending"),
      ));

    return { success: true, code: 200, message: "User's password PIN updated", data: { id: user_id } };
  } catch (error) {
    console.error("admin_set_user_password_pin error:", error);
    return { success: false, code: 500, message: "Failed to update the user's PIN", data: null };
  }
};

// Admin sets/overrides a user's ADMIN PIN (the app-lock camouflage/duress PIN),
// mirroring the password-PIN override but WITHOUT the login-reset semantics: no
// must_reset_pin (the admin PIN isn't a login gate), no lockout clear, no reset-
// request resolution. Only the "two PINs must differ" rule applies.
const admin_set_user_admin_pin = async (user_id: string, pin: string) => {
  try {
    if (!is_valid_pin(pin)) {
      return { success: false, code: 400, message: "PIN must be exactly 4 digits", data: null };
    }

    const [user] = await db
      .select({
        id: user_model.id,
        password_pin_hash: user_model.password_pin_hash,
      })
      .from(user_model)
      .where(eq(user_model.id, user_id))
      .limit(1);

    if (!user) {
      return { success: false, code: 404, message: "User not found", data: null };
    }

    // The admin PIN must differ from the user's login (password) PIN.
    if (user.password_pin_hash && (await compare_pin(pin, user.password_pin_hash))) {
      return { success: false, code: 409, message: "This PIN matches the user's login PIN — choose a different one", data: null };
    }

    const new_hash = await hash_pin(pin);
    await db
      .update(user_model)
      .set({ admin_pin_hash: new_hash })
      .where(eq(user_model.id, user_id));

    return { success: true, code: 200, message: "User's admin PIN updated", data: { id: user_id } };
  } catch (error) {
    console.error("admin_set_user_admin_pin error:", error);
    return { success: false, code: 500, message: "Failed to update the user's admin PIN", data: null };
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
  admin_create_user,
  admin_set_user_password_pin,
  admin_set_user_admin_pin,
};
