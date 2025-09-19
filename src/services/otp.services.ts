import db from "@/config/db";
import { otp_model } from "@/models/otp.model";
import { eq } from "drizzle-orm";

const generate_otp = async (phone: string) => {
  if (!phone) {
    return {
      success: false,
      code: 404,
      message: "phone number must be provided.",
    };
  }

  try {
    // -----------------------------------------------------------
    // Handle Send OTP Logic here
    // -----------------------------------------------------------


    // -----------------------------------------------------------
    // use Nanoid to generate_otp
    // -----------------------------------------------------------
    const otp = 123456

    // upsert user
    await db
      .insert(otp_model)
      .values({
        phone: phone,
        otp: otp,
      })
      .onConflictDoUpdate({
        target: otp_model.phone, // conflict column (unique/PK)
        set: {
          otp: otp,
        },
      });

    return {
      success: true,
      code: 200,
      message: `OTP sent to ${phone}`,
      // data: {
      //   phone: phone,
      //   otp: otp,
      // }
    };

  }
  catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR generate_otp",
    };
  }
};

const verify_otp = async (otp: number, phone: string) => {
  try {
    // In real scenario, fetch OTP from DB and compare
    // const db_res = await db
    //   .select()
    //   .from(otp_model)
    //   .where(eq(otp_model.phone, phone));
    //
    // if (db_res.length === 0) {
    //   return {
    //     success: false,
    //     code: 404,
    //     message: "No OTP found for this phone number",
    //   };
    // }
    //
    // const stored_otp = db_res[0].otp;

    // For demonstration, we assume OTP is always 123456
    if (otp === 123456) {
      // OTP is correct; delete it
      await db
        .delete(otp_model)
        .where(eq(otp_model.phone, phone));

      return {
        success: true,
        code: 200,
        message: "OTP verified and removed from db",
      };
    }

    return {
      success: false,
      code: 401,
      message: "Invalid OTP"
    };

  } catch (error) {
    return {
      success: false,
      code: 500,
      message: "ERROR : verify_otp"
    };
  }
};




export { generate_otp, verify_otp };
