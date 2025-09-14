import db from "@/config/db";
import { user_model } from "@/models/user.model";

const get_all_users = async () => {
    try{
        const users = await db.select({
            id: user_model.id,
            name: user_model.name,
            phone: user_model.phone,
            role: user_model.role,
            profile_pic: user_model.profile_pic,
        }).from(user_model);
        return {
            success: true,
            code: 200,
            message: "Users fetched successfully",
            data: users[0]
        }
    }catch(error){
        return {
            success: false,
            code: 500,
            message: "Failed to fetch users",
            data: null
        }
    }
}

export { get_all_users };