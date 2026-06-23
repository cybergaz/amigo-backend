import db from "@/config/db";
import { otp_model } from "@/models/otp.model";
import { create_otp, parse_phone, to_e164 } from "@/utils/general.utils";
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
    // Parse phone number to get country code
    // -----------------------------------------------------------
    const parsed_phone = parse_phone(phone);

    // Reject anything that isn't a valid number for its country. This is the hard
    // stop for a doubled country code (e.g. a "+91"-prefixing field that also receives
    // a number the user already typed "91" into → "+9191…"): libphonenumber resolves
    // the country from the leading "+91", but the over-long national number fails
    // validation, so it never gets OTP'd or persisted.
    if (!parsed_phone.country || !parsed_phone.valid) {
      return {
        success: false,
        code: 400,
        message:
          "Invalid phone number. Please enter your number without the country code in the number field.",
      };
    }

    // Canonical E.164 is the single source of truth for storage + lookup, so the
    // number we OTP, store, and later match at verify/login are always identical.
    const canonical_phone = parsed_phone.e164;

    // -----------------------------------------------------------
    // Generate OTP using Nanoid
    // -----------------------------------------------------------
    // const otp = create_otp();
    const otp = 123456
    console.log(`otp for ${parsed_phone.phone}-> `, otp)

    // -----------------------------------------------------------
    // Send OTP via JaipurSMS API
    // -----------------------------------------------------------
    const api_key = process.env.JAIPUR_SMS_API_KEY;
    const api_url = process.env.SMS_URL;
    if (!api_key || !api_url) {
      return {
        success: false,
        code: 500,
        message: "SMS service configuration error. Please contact support.",
      };
    }


    // Prepare form data
    const form_data = new URLSearchParams();
    form_data.append("type", "broadcast");
    form_data.append("country_code", parsed_phone.country);
    form_data.append("wa_number", "");
    form_data.append("mobile_numbers", parsed_phone.phone);
    form_data.append("content", `Your AmigoChats OTP is *${otp}*. Please do not share this OTP with anyone.\n\n_This is an automated message, please do not reply or call back to this number._`);
    form_data.append("image_1", "");
    form_data.append("pdf_1", "");
    form_data.append("video_1", "");
    form_data.append("audio_1", "");
    form_data.append("media_url_1", "");

    // Make API request
    const response = await fetch(api_url, {
      method: "POST",
      headers: {
        "AuthorizationKey": `Bearer ${api_key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form_data.toString(),
    });

    const response_data = await response.json();
    // console.log("response_data", response_data);

    // Handle API response
    if (!response_data.success) {
      // Handle specific error cases
      if (response_data.error?.includes("Invalid API Key")) {
        return {
          success: false,
          code: 500,
          message: "SMS service authentication error. Please contact support.",
        };
      }

      if (response_data.error?.includes("Invalid Country Code") ||
        response_data.error?.includes("WhatsApp is Disabled")) {
        return {
          success: false,
          code: 400,
          message: `SMS service not available for country code: ${parsed_phone.country}. Please contact support.`,
        };
      }

      return {
        success: false,
        code: 500,
        message: response_data.error || "Failed to send OTP. Please try again.",
      };
    }

    // -----------------------------------------------------------
    // Store OTP in database only if SMS was sent successfully
    // -----------------------------------------------------------
    await db
      .insert(otp_model)
      .values({
        phone: canonical_phone,
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
      message: `OTP sent to ${canonical_phone}`,
      data: {
        phone: canonical_phone,
        otp: otp,
      }
    };

  }
  catch (error) {
    console.error("Error in generate_otp:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR generate_otp",
    };
  }
};

const verify_otp = async (otp: number, phone: string) => {
  try {
    // Normalise to the same canonical E.164 that generate_otp stored, so a
    // differently-formatted-but-equivalent number still resolves to its OTP row.
    const lookup_phone = to_e164(phone);

    // Fetch OTP from DB and compare
    const db_res = await db
      .select()
      .from(otp_model)
      .where(eq(otp_model.phone, lookup_phone));

    if (db_res.length === 0) {
      return {
        success: false,
        code: 404,
        message: "No OTP found for this phone number",
      };
    }

    const stored_otp = db_res[0].otp;

    // Verify OTP
    if (otp === stored_otp) {
      // OTP is correct; delete it
      await db
        .delete(otp_model)
        .where(eq(otp_model.phone, lookup_phone));

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
    console.error("Error in verify_otp:", error);
    return {
      success: false,
      code: 500,
      message: "ERROR : verify_otp"
    };
  }
};




export { generate_otp, verify_otp };
