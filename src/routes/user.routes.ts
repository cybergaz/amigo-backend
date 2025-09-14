import { Elysia, t } from "elysia";
import { get_user_details, update_user_details } from "@/services/user.services";
import { get_all_users } from "@/services/user.services";

const user_routes = new Elysia({ prefix: "/user" })
  .state({ id: 0, role: "" })
  .get("/get-user", async ({ set, store }) => {
    const user_Details = await get_user_details(969408548814);
    set.status = user_Details.code;
    return user_Details;
  })
  
  .post(
    "/update-user",
    async ({ set, store, body }) => {
      const user_Details = await update_user_details(store.id, body);
      set.status = user_Details.code;
      return user_Details;
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        role: t.Optional(t.String()),
        profile_pic: t.Optional(t.String()),
      }),
    }
  )

  .get("/all-users", async ({ set }) => {
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

export default user_routes;
