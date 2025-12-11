import { Elysia, t } from "elysia";
import { CallService } from "@/services/call.service";
import { app_middleware } from "@/middleware";
import db from "@/config/db";
import { call_model } from "@/models/call.model";
import { eq } from "drizzle-orm";
// import { connections, conversation_connections, broadcast_to_all } from "@/sockets/web-socket";


function mapToObject(map: Map<any, any>) {
  const obj: Record<string, any> = {};
  for (const [key, value] of map.entries()) {
    if (value instanceof Set) {
      obj[key] = Array.from(value);
    } else if (value instanceof Map) {
      obj[key] = mapToObject(value);
    } else {
      obj[key] = value;
    }
  }
  return obj;
}

const unprotected_call_routes = new Elysia({ prefix: "/call" })

  .post("/decline/:call_id", async ({ set, params }) => {
    try {
      const callId = Number(params.call_id);
      
      // Get call info from database
      const [call_info] = await db.select().from(call_model).where(eq(call_model.id, callId)).limit(1);
      
      if (!call_info) {
        set.status = 404;
        return {
          success: false,
          message: "Call not found"
        };
      }

      // Decline the call
      await CallService.decline_call(callId, call_info.callee_id);

      set.status = 200;
      return {
        success: true,
        message: "Call declined successfully"
      };
    } catch (error) {
      console.error('[UNPROTECTED CALL ROUTES] Error declining call:', error);
      set.status = 500;
      return {
        success: false,
        message: "Internal server error"
      };
    }
  })

  .get("/status/:call_id", async ({ set, params }) => {
    const [call_info] = await db.select().from(call_model).where(eq(call_model.id, Number(params.call_id))).limit(1);

    if (!call_info) {
      set.status = 404;
      return {
        success: false,
        data: null,
        message: "Call not found"
      };
    }

    set.status = 200;
    return {
      success: true,
      data: call_info,
      message: "Call status retrieved successfully"
    };
  })

// .get("/socket/status", async ({ set, params }) => {
//   console.log("testing socket status endpoint");
//   console.log("conversation_connections ->", conversation_connections)
//   broadcast_to_all({
//     type: "socket_health_check",
//     data: {
//       time: new Date().toLocaleString(),
//       message: "Socket is healthy"
//     }
//   });
//   set.status = 200;
//   console.log("2nd conversation_connections ->", conversation_connections)
//   return {
//     success: true,
//     data: {
//       connections: mapToObject(connections),
//       conversation_connections: mapToObject(conversation_connections)
//     },
//     message: "Socket status retrieved successfully"
//   };
// })



export default unprotected_call_routes;
