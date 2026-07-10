-- PIN-auth: add password_pin_hash + admin_pin_hash to users (additive, nullable).
--
-- Both hold a bcrypt hash of an HMAC-peppered 4-digit PIN (see hash_pin in
-- general.utils.ts) — never plaintext. NULL = "PIN not set" (drives the app's
-- create-PIN enforcement gate). Kept separate from hashed_password (web/email
-- password). Nullable + no default ⇒ metadata-only ADD COLUMN, no table rewrite,
-- existing rows become NULL.
--
-- Idempotent — safe to re-run. Applied manually (drizzle-kit generate can't be used
-- here without reconciling unrelated pre-existing schema drift; see manual_add_auth_devices.sql).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_pin_hash" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_pin_hash" text;
