import { Elysia, t } from "elysia";
import { CallService } from "@/services/call.service";
import { app_middleware } from "@/middleware";
import db from "@/config/db";
import { call_model } from "@/models/call.model";
import { eq } from "drizzle-orm";

const unprotected_call_routes = new Elysia({ prefix: "/call" })

  .post("/decline", async ({ body }) => {
    const [call_info] = await db.select().from(call_model).where(eq(call_model.id, body.call_id)).limit(1);
    await CallService.decline_call(body.call_id, call_info.callee_id);
  }, {
    body: t.Object({
      call_id: t.Number()
    })
  })

export default unprotected_call_routes;
