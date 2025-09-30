import { Elysia, t } from "elysia";
import { CallService } from "@/services/call.service";
import { WebSocketNotificationService } from "@/services/websocket-notification.service";
import { app_middleware } from "@/middleware";
import db from "@/config/db";
import { call_model } from "@/models/call.model";
import { eq } from "drizzle-orm";

const unprotected_call_routes = new Elysia({ prefix: "/call" })

  .post("/decline/:call_id", async ({ params, body }) => {
    const [call_info] = await db.select().from(call_model).where(eq(call_model.id, Number(params.call_id))).limit(1);
    
    if (!call_info) {
      return { success: false, error: 'Call not found' };
    }

    const result = await CallService.decline_call(Number(params.call_id), call_info.callee_id, "declined");

    if (result.success) {
      // Send WebSocket notifications
      await WebSocketNotificationService.sendCallDeclineNotification(
        Number(params.call_id), 
        call_info.callee_id, 
        "declined"
      );
    }

    return result;
  },)

export default unprotected_call_routes;
