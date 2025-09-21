import { Elysia, t } from "elysia";
import { get_available_users, get_user_details, update_user_details, update_profile_image } from "@/services/user.services";
import { get_all_users } from "@/services/user.services";
import { app_middleware } from "@/middleware";
import { ROLE_CONST } from "@/types/user.types";

const user_routes = new Elysia({ prefix: "/user" })
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  .get("/get-user", async ({ set, store }) => {
    const user_Details = await get_user_details(store.id);
    set.status = user_Details.code;
    return user_Details;
  })

  .post("/update-user", async ({ set, store, body }) => {
    const user_Details = await update_user_details(store.id, body);
    set.status = user_Details.code;
    return user_Details;
  },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        phone: t.Optional(t.String()),
        role: t.Optional(t.Enum(Object.fromEntries(ROLE_CONST.map(x => [x, x])))),
        profile_pic: t.Optional(t.String()),
        location: t.Optional(t.Object({
          latitude: t.Number(),
          longitude: t.Number(),
        })),
        ip_address: t.Optional(t.String()),
      }),
    }
  )

  .get("/all-users", async ({ set }) => {
    try {
      const users = await get_all_users();
      set.status = users.code
      return users;
    } catch (error) {
      set.status = 500
      return {
        success: false,
      }
    }
  })

  .post("/get-available-users", async ({ set, store, body }) => {
    const user_Details = await get_available_users(store.id, body.phone_numbers);
    set.status = user_Details.code;
    return user_Details;
  },
    {
      body: t.Object({
        phone_numbers: t.Array(t.String()),
      }),
    }
  )

  .post("/update-profile-image", async ({ set, store, body }) => {
    try {
      if (!body.image) {
        set.status = 400;
        return {
          success: false,
          message: "No image file provided",
        };
      }

      const result = await update_profile_image(store.id, body.image);
      set.status = result.code;
      return result;
    } catch (error: any) {
      console.error("Error in profile image upload route:", error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error",
      };
    }
  },
    {
      body: t.Object({
        image: t.File({
          type: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
          maxSize: 5 * 1024 * 1024, // 5MB
        }),
      }),
    }
  )

export default user_routes;
