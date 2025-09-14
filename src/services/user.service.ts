import db from "@/config/db";
import { user_model } from "@/models/user.model";
import { eq } from "drizzle-orm";

const get_user_details = async (id: number) => {
  try {
    if (!id) {
      return {
        success: false,
        code: 400,
        message: "Invalid request",
        data: null
      };
    }
    const user_details = await db.select({
      id: user_model.id,
      name: user_model.name,
      phone: user_model.phone,
      role: user_model.role,
      profile_pic: user_model.profile_pic,
    }).from(user_model).where(eq(user_model.id, id));
    
    return {
        success: true,
        code: 200,
        message: "User details fetched successfully",
        data: user_details[0]
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to get user details",
      data: null
    };
  }
};


const update_user_details = async (id: number, body: any) => {
  try {
    if (!id) {
      return {
        success: false,
        code: 400,
        message: "Invalid request",
        data: null
      };
    }
    const user_details = await db.update(user_model).set(body).where((eq(user_model.id, id)));
    return {
        success: true,
        code: 200,
        message: "User details updated successfully",
        data: user_details[0]
    };
  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "Failed to update user details",
      data: null
    };
  }
};

export { get_user_details, update_user_details };