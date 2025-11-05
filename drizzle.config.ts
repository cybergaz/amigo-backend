import { defineConfig } from "drizzle-kit";
import "dotenv/config";
import fs from "fs";

if (!process.env.DB_URL) {
  throw new Error("DB_URL is not set in .env");
}

const sslCert = fs.readFileSync("./rds-combined-ca-bundle.pem");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/models/**/*.ts",
  dbCredentials: {
    url: process.env.DB_URL!,
    ssl: { rejectUnauthorized: false }
  },
});
