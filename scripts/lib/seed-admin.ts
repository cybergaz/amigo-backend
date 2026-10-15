/**
 * Core of `bun db:admin:seed` (scripts/seed-admin.ts).
 *
 * Replaces the old unauthenticated `GET /admin/seed-admin-for-admin-panel`
 * route, which inserted a super admin with a hash hardcoded in source.
 *
 * The DB access is behind a tiny `SeedAdminStore` interface so this file never
 * imports @/config/db (which throws without DB_URL) and the logic can be unit
 * tested with an in-memory stub (tests/seed-admin.test.ts).
 *
 * The hash is made with hash_password() — the exact helper whose output
 * handle_login() checks via compare_password() (bcryptjs, cost 10).
 *
 * --reset-password also revokes the admin's sessions, the same way logout
 * does (revoke_user_sessions + clearing users.refresh_token): whoever held the
 * old password can no longer refresh. Already-issued access JWTs are not
 * revocable and stay valid until they expire.
 */
import { hash_password } from "@/utils/general.utils";

export const DEFAULT_ADMIN_EMAIL = "admin@gmail.com";
export const DEFAULT_ADMIN_NAME = "Super Admin";

// bcrypt only reads the first 72 BYTES of its input: anything after that is
// silently ignored, so refuse instead of storing a weaker password than typed.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72;

export type ExistingUser = { id: string; role: string };

export interface SeedAdminStore {
  find_by_email(email: string): Promise<ExistingUser | null>;
  // Must be race-safe: returns null when the email already exists (unique index).
  insert_admin(values: { name: string; email: string; hashed_password: string }): Promise<{ id: string } | null>;
  // Replace the hash AND revoke the user's sessions, atomically (one
  // transaction). Returns how many refresh sessions were revoked.
  reset_password(id: string, hashed_password: string): Promise<{ sessions_revoked: number }>;
}

export type SeedAdminResult =
  | { status: "created"; id: string }
  | { status: "exists"; id: string; role: string }
  | { status: "password_reset"; id: string; sessions_revoked: number }
  | { status: "not_admin"; id: string; role: string };

// Returns an error message, or null when the password is acceptable.
export const validate_password = (password: string): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return `password must be at most ${MAX_PASSWORD_BYTES} bytes (bcrypt ignores the rest)`;
  }
  return null;
};

// email varchar(50) on users; handle_login() matches it exactly, so only trim.
export const validate_email = (email: string): string | null => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return `invalid email: ${email}`;
  if (email.length > 50) return "email must be at most 50 characters";
  return null;
};

// name varchar(60) NOT NULL on users. Checked up front: an over-long name
// would otherwise only fail inside the INSERT (see describe_seed_error).
export const MAX_NAME_LENGTH = 60;
export const validate_name = (name: string | undefined): string | null => {
  // Missing / blank → DEFAULT_ADMIN_NAME (seed_admin), as before.
  const trimmed = (name ?? "").trim();
  // Postgres counts characters (code points), not UTF-16 units.
  if (Array.from(trimmed).length > MAX_NAME_LENGTH) return `name must be at most ${MAX_NAME_LENGTH} characters`;
  return null;
};

// A bcrypt hash anywhere in a message ($2a$/$2b$/$2y$, cost, 53-char salt+hash).
const BCRYPT_HASH_RE = /\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}/g;

// The one line the script prints for a failure. Never the password or its
// hash: a failed drizzle query throws DrizzleQueryError, whose message is
// "Failed query: <sql>\nparams: <every bound value>" — for insert_admin /
// reset_password that includes hashed_password. For those, print only the
// driver's own error (err.cause: the Postgres message, which carries no bound
// values). Any bcrypt hash left in whatever is printed is masked as well.
export const describe_seed_error = (err: unknown): string => {
  const e = err as { name?: unknown; message?: unknown; cause?: { message?: unknown } } | null | undefined;
  let text: string;
  if (e && typeof e === "object" && (e.name === "DrizzleQueryError" || "params" in e)) {
    const cause_msg = e.cause && typeof e.cause.message === "string" ? e.cause.message : "";
    text = cause_msg ? `database error: ${cause_msg}` : "database query failed";
  } else if (e && typeof e === "object" && typeof e.message === "string") {
    text = e.message;
  } else {
    text = String(err);
  }
  return text.replace(BCRYPT_HASH_RE, "<redacted>");
};

export const seed_admin = async (
  store: SeedAdminStore,
  opts: { email: string; password: string; name?: string; reset_password?: boolean },
): Promise<SeedAdminResult> => {
  const email = opts.email.trim();
  const email_err = validate_email(email);
  if (email_err) throw new Error(email_err);
  const password_err = validate_password(opts.password);
  if (password_err) throw new Error(password_err);
  const name_err = validate_name(opts.name);
  if (name_err) throw new Error(name_err);

  const existing = await store.find_by_email(email);
  if (existing) return on_existing(store, existing, opts);

  const hashed_password = await hash_password(opts.password);
  const created = await store.insert_admin({
    name: opts.name?.trim() || DEFAULT_ADMIN_NAME,
    email,
    hashed_password,
  });
  if (created) return { status: "created", id: created.id };

  // Lost a race with a concurrent insert of the same email: treat as existing.
  const raced = await store.find_by_email(email);
  if (!raced) throw new Error("insert skipped but no user found for that email");
  return on_existing(store, raced, opts);
};

const on_existing = async (
  store: SeedAdminStore,
  user: ExistingUser,
  opts: { password: string; reset_password?: boolean },
): Promise<SeedAdminResult> => {
  if (!opts.reset_password) return { status: "exists", id: user.id, role: user.role };
  // --reset-password only ever touches a super admin, never a user/sub_admin
  // that happens to own the email.
  if (user.role !== "admin") return { status: "not_admin", id: user.id, role: user.role };
  const { sessions_revoked } = await store.reset_password(user.id, await hash_password(opts.password));
  return { status: "password_reset", id: user.id, sessions_revoked };
};
