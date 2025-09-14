import Elysia from "elysia";
import { get_all_users } from "@/services/users.service";

const users_routes = new Elysia({ prefix: "/users" })
  .get("/all-users", async ({ set, store }) => {
    try{
        const users = await get_all_users();
        set.status = users.code
        return users;
    }catch(error){
        set.status = 500
        return {
            success: false,
        }
    }
  })

export default users_routes;