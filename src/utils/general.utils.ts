import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";

function extractCountryCode(phone: string): string | null {
  // Remove spaces and non-digit/non-plus characters
  const normalized = phone.replace(/[^\d+]/g, "");

  // If number starts with +
  if (normalized.startsWith("+")) {
    const match = normalized.match(/^\+(\d{1,3})/); // capture 1–3 digit country code
    return match ? match[1] : null;
  }

  // If no +, assume default country code (e.g. "91" for India)
  // You can change "91" to your preferred default
  return "91";
}

const create_unique_id = () => {
  const nanoid = customAlphabet("0123456789", 10);
  return Number(nanoid());
};

const hash_password = async (password: string): Promise<string> => {
  const SALT = 10;
  const hashed_password = await bcrypt.hash(password, SALT);
  return hashed_password;
};

const generate_jwt = (id: number, role: string, is_profile_complete?: boolean) => {
  return jwt.sign({
    id,
    role,
    is_profile_complete: is_profile_complete || false
  },
    process.env.ACCESS_KEY || "heymama", {
    expiresIn: "1d",
  });
};

const generate_refresh_jwt = (id: number, role: string) => {
  return jwt.sign({ id, role }, process.env.ACCESS_KEY || "heymama", {
    expiresIn: "7d",
  });
};

export { extractCountryCode, create_unique_id, hash_password, generate_jwt, generate_refresh_jwt };
