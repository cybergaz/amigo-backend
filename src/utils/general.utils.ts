import jwt from "jsonwebtoken";
import type { StringValue } from "ms";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import { parsePhoneNumberFromString } from "libphonenumber-js";

const create_unique_id = () => {
  const nanoid = customAlphabet("0123456789", 10);
  return Number(nanoid());
};

const create_otp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const hash_password = async (password: string): Promise<string> => {
  const SALT = 10;
  const hashed_password = await bcrypt.hash(password, SALT);
  return hashed_password;
};


const generate_jwt = (id: number, role: string, time: StringValue = "1d") => {
  return jwt.sign({
    id,
    role,
  },
    process.env.ACCESS_KEY || "heymama", {
    expiresIn: time,
  });
};

const generate_refresh_jwt = (id: number, role: string, time: StringValue = "7d") => {
  return jwt.sign({ id, role }, process.env.ACCESS_KEY || "heymama", {
    expiresIn: time,
  });
};

const compare_password = async (password: string, hashed_password: string) => {
  return await bcrypt.compare(password, hashed_password);
};


function parse_phone(input: string, default_country_code?: string) {
  const phone = parsePhoneNumberFromString(input);
  console.log("phone -> ", phone)

  if (!phone) return {
    country: null,
    code: "",
    phone: input,
    concatinated: `+${default_country_code}${input.replace(" ", "")}`,
  };

  return {
    country: phone.country || null,
    code: phone.countryCallingCode, // e.g. "91"
    phone: phone.nationalNumber,     // e.g. "7777777777"
    concatinated: `+${phone.countryCallingCode || ""}${phone.nationalNumber}`.replace(" ", "") // e.g. "+917777777777"
  };
}

const create_dm_key = (user1: number, user2: number) => {
  return [user1, user2].sort().join("_");
}


export { parse_phone, create_unique_id, create_otp, hash_password, generate_jwt, generate_refresh_jwt, compare_password, create_dm_key };
