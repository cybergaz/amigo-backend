import Elysia, { t } from "elysia";

const auth_routes = new Elysia({ prefix: "/auth" })
  .state({ id: 0, role: "" })
  // .guard({
  //   beforeHandle({ cookie, set, store, headers }) {
  //     const state_result = app_middleware({ cookie, headers });
  //
  //     set.status = state_result.code;
  //     if (!state_result.data) return state_result
  //
  //     store.id = state_result.data.id;
  //     store.role = state_result.data.role;
  //   }
  // })
  .get("/", async ({ set, store }) => {
    // const user_details = await get_user_details(store.id, store.role as RoleType);

    set.status = 200
    return "Hello Elysia";
  })

export default auth_routes;
