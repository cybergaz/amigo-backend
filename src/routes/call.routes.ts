import { Elysia, t } from "elysia";
import { CallService } from "@/services/call.service";
import { app_middleware } from "@/middleware";

const call_routes = new Elysia({ prefix: "/call" })
  .state({ id: 0, role: "" })
  .guard({
    beforeHandle({ cookie, set, store, headers }) {
      const state_result = app_middleware({ cookie, headers });

      set.status = state_result.code;
      if (!state_result.data) return state_result;

      store.id = state_result.data.id;
      store.role = state_result.data.role;
    }
  })

  .get("/history", async ({ set, store, query }) => {
    try {
      const limit = Math.min(parseInt(query.limit as string) || 20, 100); // Max 100 calls
      
      const result = await CallService.get_call_history(store.id, limit);
      
      if (result.success) {
        set.status = 200;
        return {
          success: true,
          data: result.data,
          message: "Call history retrieved successfully"
        };
      } else {
        set.status = 500;
        return {
          success: false,
          message: result.error || "Failed to get call history"
        };
      }
    } catch (error) {
      console.error('[CALL ROUTES] Error getting call history:', error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error"
      };
    }
  }, {
    query: t.Object({
      limit: t.Optional(t.String())
    })
  })

  .get("/active", async ({ set, store }) => {
    try {
      const activeCall = CallService.get_user_active_call(store.id);
      
      set.status = 200;
      return {
        success: true,
        data: activeCall || null,
        message: activeCall ? "Active call found" : "No active call"
      };
    } catch (error) {
      console.error('[CALL ROUTES] Error getting active call:', error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error"
      };
    }
  });

export default call_routes;
