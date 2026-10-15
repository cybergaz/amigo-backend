#!/usr/bin/env bun
/**
 * Create the super admin for the admin panel.
 *
 *   bun db:admin:seed [--email <e>] [--name <n>] [--reset-password]
 *
 * Password: env ADMIN_SEED_PASSWORD, else a hidden prompt when stdin is a TTY.
 * With neither, the script refuses to run. The password and its hash are never
 * printed.
 *
 * Idempotent: if a user with that email exists nothing is written. With
 * --reset-password an existing ADMIN (role 'admin' only) gets the new hash and
 * its sessions are revoked (as on logout) in the same transaction.
 *
 * Replaces the old unauthenticated GET /admin/seed-admin-for-admin-panel route.
 * Uses the same DB_URL (.env) as the server — check which DB it points at.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_NAME,
  describe_seed_error,
  seed_admin,
  validate_email,
  validate_name,
  validate_password,
  type SeedAdminStore,
} from "./lib/seed-admin";

const usage = () => {
  console.log(
    `Usage: bun db:admin:seed [--email <email>] [--name <name>] [--reset-password]\n\n` +
    `  --email <email>     admin email (default ${DEFAULT_ADMIN_EMAIL})\n` +
    `  --name <name>       display name for a NEW admin (default "${DEFAULT_ADMIN_NAME}")\n` +
    `  --reset-password    if the email already belongs to a role 'admin' user, replace its password\n` +
    `  --help              show this help\n\n` +
    `Password comes from env ADMIN_SEED_PASSWORD, or a hidden prompt when run in a terminal.\n` +
    `Writes to the DB that DB_URL in .env points at.`,
  );
};

type Flags = { email: string; name?: string; reset_password: boolean; help: boolean };

const parse_flags = (argv: string[]): Flags => {
  const out: Flags = { email: DEFAULT_ADMIN_EMAIL, reset_password: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Accept both `--email x` and `--email=x`.
    const [key, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${key} needs a value`);
      return v;
    };
    if (key === "--help" || key === "-h") out.help = true;
    else if (key === "--reset-password") out.reset_password = true;
    else if (key === "--email") out.email = value();
    else if (key === "--name") out.name = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
};

// Reads one line from a TTY without echoing it.
const prompt_hidden = (label: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", on_data);
      process.stdout.write("\n");
      err ? reject(err) : resolve(buf);
    };
    const on_data = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("aborted")); // Ctrl-C
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", on_data);
  });

const read_password = async (): Promise<string | null> => {
  const from_env = process.env.ADMIN_SEED_PASSWORD;
  if (from_env) return from_env;
  if (!process.stdin.isTTY) return null;
  const first = await prompt_hidden("Admin password: ");
  const second = await prompt_hidden("Repeat password: ");
  if (first !== second) throw new Error("passwords do not match");
  return first;
};

const main = async () => {
  const flags = parse_flags(process.argv.slice(2));
  if (flags.help) {
    usage();
    return;
  }

  const password = await read_password();
  if (!password) {
    console.error("No password: set ADMIN_SEED_PASSWORD or run in a terminal to be prompted.");
    usage();
    process.exitCode = 1;
    return;
  }

  const input_err = validate_email(flags.email.trim()) ?? validate_password(password) ?? validate_name(flags.name);
  if (input_err) throw new Error(input_err);

  // Imported only after the arguments are valid, so --help and a missing
  // password never need DB_URL and never open a connection.
  const { default: db, close_db } = await import("@/config/db");
  const { user_model } = await import("@/models/user.model");
  const { refresh_session_model } = await import("@/models/session.model");

  const store: SeedAdminStore = {
    find_by_email: async (email) => {
      const rows = await db
        .select({ id: user_model.id, role: user_model.role })
        .from(user_model)
        .where(eq(user_model.email, email))
        .limit(1);
      return rows[0] ?? null;
    },
    insert_admin: async (values) => {
      const rows = await db
        .insert(user_model)
        .values({ ...values, role: "admin" })
        .onConflictDoNothing({ target: user_model.email })
        .returning({ id: user_model.id });
      return rows[0] ?? null;
    },
    // New hash + session kill in ONE transaction: never a new password with
    // the old sessions still refreshable, nor revoked sessions with the old
    // password. The revoke is what logout / login do (revoke_user_sessions in
    // src/services/session.service.ts, plus clearing the legacy
    // users.refresh_token) — inlined because that module opens Redis on import
    // and revoke_user_sessions cannot join this transaction.
    reset_password: async (id, hashed_password) =>
      db.transaction(async (tx) => {
        await tx
          .update(user_model)
          .set({ hashed_password, refresh_token: null })
          .where(eq(user_model.id, id));
        const revoked = await tx
          .delete(refresh_session_model)
          .where(eq(refresh_session_model.user_id, id))
          .returning({ id: refresh_session_model.id });
        return { sessions_revoked: revoked.length };
      }),
  };

  try {
    const result = await seed_admin(store, {
      email: flags.email,
      password,
      name: flags.name,
      reset_password: flags.reset_password,
    });
    const email = flags.email.trim();
    switch (result.status) {
      case "created":
        console.log(`Created admin ${email} (id ${result.id}).`);
        break;
      case "exists":
        console.log(`A user with email ${email} already exists (role ${result.role}); nothing changed.` +
          (result.role === "admin" ? " Pass --reset-password to replace its password." : ""));
        break;
      case "password_reset":
        console.log(`Password replaced for admin ${email} (id ${result.id}).`);
        console.log(`Revoked ${result.sessions_revoked} session(s) of that admin: it must log in again ` +
          `with the new password (access tokens already issued stay valid until they expire).`);
        break;
      case "not_admin":
        console.error(`User ${email} has role ${result.role}, not admin; refusing to reset its password.`);
        process.exitCode = 1;
        break;
    }
  } finally {
    await close_db();
  }
};

// describe_seed_error, never err.message: a failed query's message lists its
// bound params, which include the password hash.
main().catch((err) => {
  console.error(`seed-admin failed: ${describe_seed_error(err)}`);
  process.exitCode = 1;
});
