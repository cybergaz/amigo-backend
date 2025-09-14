import { Elysia, t } from "elysia";
import { get_user_details, update_user_details } from "@/services/user.service";

const user_routes = new Elysia({ prefix: "/user" })
  .state({ id: 0, role: "" })
  .get("/get-user", async ({ set, store }) => {
    const user_Details = await get_user_details(store.id);
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
  );

export default user_routes;
