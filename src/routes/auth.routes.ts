import db from "@/config/db";
import { authenticate_jwt } from "@/middleware";
import { user_model } from "@/models/user.model";
import { handle_login, handle_refresh_token } from "@/services/auth.service";
import { generate_otp, verify_otp } from "@/services/otp.services";
import { create_user, find_user_by_phone } from "@/services/user.services";
import { VerifySignupSchema } from "@/types/auth.types";
import { password } from "bun";
import Elysia, { t } from "elysia";
import { eq } from "drizzle-orm";

const auth_routes = new Elysia({ prefix: "/auth" })

  .post("/generate-signup-otp/:phone", async ({ set, params }) => {
    const existing_user_res = await find_user_by_phone(params.phone);
    if (existing_user_res.success) {
      set.status = 409;
      return {
        success: false,
        code: 409,
        message: "User already exists with this phone number.",
      };
    }

    const otp_res = await generate_otp(params.phone);

    set.status = otp_res.code;
    return otp_res;
  },
    {
      params: t.Object({
        phone: t.String(),
      }),
    }
  )

  .post("/generate-login-otp/:phone", async ({ set, params }) => {
    const existing_user_res = await find_user_by_phone(params.phone);
    if (!existing_user_res?.success) {
      set.status = existing_user_res?.code;
      return existing_user_res;
    }

    const otp_res = await generate_otp(params.phone);

    set.status = otp_res.code;
    return otp_res;
  },
    {
      params: t.Object({
        phone: t.String(),
      }),
    }
  )

  .post("/verify-signup-otp", async ({ body, set, cookie }) => {
    const { phone, name, password, role, otp } = body;

    const otpResponse = await verify_otp(otp, phone);
    if (otpResponse.success == false) {
      set.status = otpResponse.code;
      return otpResponse;
    }

    const create_user_res = await create_user({
      name,
      password,
      role,
      phone,
    });
    if (!create_user_res?.success) {
      set.status = create_user_res?.code;
      return create_user_res;
    }

    // on successful user creation
    set.status = create_user_res.code;
    if (
      create_user_res.success &&
      create_user_res.data?.refresh_token &&
      create_user_res.data?.access_token
    ) {
      cookie["refresh_token"].set({
        value: create_user_res.data.refresh_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
      });
      cookie["access_token"].set({
        value: create_user_res.data.access_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24,
        path: "/",
      });
      console.log(
        `[SERVER]   Set Tokens to Cookies : ${new Date().toLocaleString()}`
      );
    }

    console.log(
      `[SERVER]   User Created Success : ${new Date().toLocaleString()}`
    );
    return create_user_res;
  },
    { body: VerifySignupSchema }
  )

  .post("/verify-login-otp", async ({ body, set, cookie }) => {
    const otpResponse = await verify_otp(body.otp, body.phone);

    if (!otpResponse.success) {
      set.status = otpResponse.code;
      return otpResponse;
    }

    const login_res = await handle_login({ phone: body.phone });
    if (login_res.success == false) {
      set.status = login_res.code;
      return login_res;
    }

    if (
      login_res.success &&
      login_res.data?.refresh_token &&
      login_res.data?.access_token
    ) {
      cookie["refresh_token"].set({
        value: login_res.data.refresh_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
      });
      cookie["access_token"].set({
        value: login_res.data.access_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24,
        path: "/",
      });
      console.log(
        `[SERVER]   Set Tokens to Cookies : ${new Date().toLocaleString()}`
      );
    }

    set.status = login_res.code;

    return login_res
    // return {
    //   success: true,
    //   message: "Login Successful",
    //   data: {
    //     id: login_res.data?.id,
    //     name: login_res.data?.name,
    //     role: login_res.data?.role,
    //     phone: login_res.data?.phone,
    //   },
    // };
  },
    {
      body: t.Object({
        phone: t.String(),
        otp: t.Number(),
      }),
    }
  )


  .post("/verify-email-login", async ({ body, set, cookie, headers }) => {
    const login_res = await handle_login({ email: body.email, password: body.password });
    if (login_res.success == false) {
      set.status = login_res.code;
      return login_res;
    }

    if (
      login_res.success &&
      login_res.data?.refresh_token &&
      login_res.data?.access_token
    ) {
      cookie["refresh_token"].set({
        value: login_res.data.refresh_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
        // domain: "ui.gosecureserver.in",
        // partitioned: true,
      });

      cookie["access_token"].set({
        value: login_res.data.access_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24,
        path: "/",
        // domain: "ui.gosecureserver.in",
        // partitioned: true,
      });
      console.log(
        `[SERVER]   Set Tokens to Cookies : ${new Date().toLocaleString()}`
      );
    }

    set.status = login_res.code;

    return login_res
    // return {
    //   success: true,
    //   message: "Login Successful",
    //   data: {
    //     id: login_res.data?.id,
    //     name: login_res.data?.name,
    //     role: login_res.data?.role,
    //     phone: login_res.data?.phone,
    //   },
    // };
  },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    }
  )

  .post("/refresh", async ({ cookie, set }) => {
    const existing_token = cookie["refresh_token"].value;
    if (!existing_token) {
      set.status = 404;
      return {
        success: false,
        code: 404,
        message: "No Refresh Token in Cookies",
      };
    }

    const info = authenticate_jwt(existing_token as string);

    if (!info.success || !info.data?.id) {
      set.status = info.code;
      return info;
    }

    const refresh_res = await handle_refresh_token(existing_token as string);

    if (!refresh_res.success) {
      set.status = refresh_res.code;
      return refresh_res;
    }

    if (
      refresh_res.success &&
      refresh_res.data?.refresh_token &&
      refresh_res.data?.access_token
    ) {
      cookie["refresh_token"].set({
        value: refresh_res.data.refresh_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
      });
      cookie["access_token"].set({
        value: refresh_res.data.access_token,
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 60 * 60 * 24,
        path: "/",
      });
    }

    set.status = refresh_res.code;
    return refresh_res
  })

  .get("/logout", async ({ cookie, set }) => {
    console.log("got a logout request")
    const existing_token = cookie["refresh_token"].value;
    const access_token = cookie["access_token"].value;
    if (!existing_token && !access_token) {
      set.status = 404;
      console.log(
        `[SERVER]   Already Logged Out : ${new Date().toLocaleString()}`
      );
      return {
        success: true,
        message: "Already Logged Out",
      };
    }

    // clean up after logout
    const info = authenticate_jwt(cookie["refresh_token"].value as string);
    if (info.success && info.data?.id) {
      await db
        .update(user_model)
        .set({ fcm_token: null, online_status: false })
        .where(eq(user_model.id, info.data.id));
    }

    cookie["refresh_token"].remove();
    cookie["access_token"].remove();
    set.status = 200;
    console.log(`[SERVER]   Logged Out : ${new Date().toLocaleString()}`);
    return {
      success: true,
      message: "Logged Out Successfully",
    };
  })

export default auth_routes;
