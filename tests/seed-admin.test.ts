// Unit tests for the `bun db:admin:seed` core (scripts/lib/seed-admin.ts).
// Pure — an in-memory store stands in for the users table, no database.
// Run: `bun test tests/seed-admin.test.ts`.
import { describe, expect, test } from "bun:test";
import { compare_password } from "@/utils/general.utils";
import { DrizzleQueryError } from "drizzle-orm";
import {
  DEFAULT_ADMIN_NAME,
  describe_seed_error,
  seed_admin,
  validate_name,
  validate_password,
  type SeedAdminStore,
} from "../scripts/lib/seed-admin";

type Row = { id: string; name: string; email: string; role: string; hashed_password: string | null };
// refresh_sessions rows (user_id per session).
type Session = { id: string; user_id: string };

const make_store = (rows: Row[] = [], sessions: Session[] = []) => {
  let next = 1;
  const calls = { insert: 0, update: 0 };
  const store: SeedAdminStore = {
    find_by_email: async (email) => {
      const r = rows.find((x) => x.email === email);
      return r ? { id: r.id, role: r.role } : null;
    },
    insert_admin: async (values) => {
      calls.insert++;
      if (rows.some((x) => x.email === values.email)) return null; // unique index
      const row = { id: `u${next++}`, role: "admin", ...values };
      rows.push(row);
      return { id: row.id };
    },
    // Hash + session revoke together, like the script's transaction.
    reset_password: async (id, hashed_password) => {
      calls.update++;
      rows.find((x) => x.id === id)!.hashed_password = hashed_password;
      const before = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i]!.user_id === id) sessions.splice(i, 1);
      }
      return { sessions_revoked: before - sessions.length };
    },
  };
  return { store, rows, sessions, calls };
};

const PASSWORD = "correct horse battery";

describe("seed_admin", () => {
  test("creates an admin whose hash passes the login check", async () => {
    const { store, rows } = make_store();
    const res = await seed_admin(store, { email: " admin@gmail.com ", password: PASSWORD });
    expect(res.status).toBe("created");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ email: "admin@gmail.com", role: "admin", name: DEFAULT_ADMIN_NAME });
    expect(row.hashed_password).not.toBe(PASSWORD);
    expect(row.hashed_password!.startsWith("$2")).toBe(true);
    // Same check handle_login() runs.
    expect(await compare_password(PASSWORD, row.hashed_password!)).toBe(true);
    expect(await compare_password("wrong password", row.hashed_password!)).toBe(false);
  });

  test("is idempotent: an existing email is left untouched", async () => {
    const { store, rows, calls } = make_store([
      { id: "a1", name: "X", email: "admin@gmail.com", role: "admin", hashed_password: "old" },
    ]);
    const res = await seed_admin(store, { email: "admin@gmail.com", password: PASSWORD });
    expect(res).toEqual({ status: "exists", id: "a1", role: "admin" });
    expect(rows[0]!.hashed_password).toBe("old");
    expect(calls).toEqual({ insert: 0, update: 0 });
  });

  test("--reset-password replaces the hash of an existing admin and revokes its sessions", async () => {
    const { store, rows, sessions } = make_store(
      [
        { id: "a1", name: "X", email: "admin@gmail.com", role: "admin", hashed_password: "old" },
        { id: "u2", name: "Y", email: "y@example.com", role: "user", hashed_password: "y" },
      ],
      [
        { id: "s1", user_id: "a1" },
        { id: "s2", user_id: "a1" },
        { id: "s3", user_id: "u2" },
      ],
    );
    const res = await seed_admin(store, { email: "admin@gmail.com", password: PASSWORD, reset_password: true });
    expect(res).toEqual({ status: "password_reset", id: "a1", sessions_revoked: 2 });
    expect(await compare_password(PASSWORD, rows[0]!.hashed_password!)).toBe(true);
    // Only that admin's sessions go; another user's survive.
    expect(sessions).toEqual([{ id: "s3", user_id: "u2" }]);
  });

  test("--reset-password with no live sessions reports 0 revoked", async () => {
    const { store } = make_store([
      { id: "a1", name: "X", email: "admin@gmail.com", role: "admin", hashed_password: "old" },
    ]);
    const res = await seed_admin(store, { email: "admin@gmail.com", password: PASSWORD, reset_password: true });
    expect(res).toEqual({ status: "password_reset", id: "a1", sessions_revoked: 0 });
  });

  test("--reset-password never touches a non-admin owner of the email (nor its sessions)", async () => {
    const { store, rows, sessions, calls } = make_store(
      [{ id: "s1", name: "Sub", email: "admin@gmail.com", role: "sub_admin", hashed_password: "old" }],
      [{ id: "x1", user_id: "s1" }],
    );
    const res = await seed_admin(store, { email: "admin@gmail.com", password: PASSWORD, reset_password: true });
    expect(res).toEqual({ status: "not_admin", id: "s1", role: "sub_admin" });
    expect(rows[0]!.hashed_password).toBe("old");
    expect(sessions).toHaveLength(1);
    expect(calls.update).toBe(0);
  });

  test("without --reset-password an existing admin's sessions are left alone", async () => {
    const { store, sessions } = make_store(
      [{ id: "a1", name: "X", email: "admin@gmail.com", role: "admin", hashed_password: "old" }],
      [{ id: "s1", user_id: "a1" }],
    );
    await seed_admin(store, { email: "admin@gmail.com", password: PASSWORD });
    expect(sessions).toHaveLength(1);
  });

  test("a lost insert race is reported as existing", async () => {
    const { store, rows } = make_store();
    const racy: SeedAdminStore = {
      ...store,
      find_by_email: (() => {
        let first = true;
        return async (email: string) => {
          if (first) {
            first = false;
            // Another process inserts between our lookup and our insert.
            rows.push({ id: "r1", name: "Other", email, role: "admin", hashed_password: "theirs" });
            return null;
          }
          return store.find_by_email(email);
        };
      })(),
    };
    const res = await seed_admin(racy, { email: "admin@gmail.com", password: PASSWORD });
    expect(res).toEqual({ status: "exists", id: "r1", role: "admin" });
    expect(rows).toHaveLength(1);
  });

  test("rejects bad input before touching the store", async () => {
    const { store, calls } = make_store();
    await expect(seed_admin(store, { email: "not-an-email", password: PASSWORD })).rejects.toThrow("invalid email");
    await expect(seed_admin(store, { email: "admin@gmail.com", password: "short" })).rejects.toThrow("at least");
    await expect(seed_admin(store, { email: "admin@gmail.com", password: PASSWORD, name: "n".repeat(61) }))
      .rejects.toThrow("at most 60");
    expect(calls).toEqual({ insert: 0, update: 0 });
  });
});

describe("validate_password", () => {
  test("enforces the bcrypt 72-byte limit in bytes, not characters", () => {
    expect(validate_password("a".repeat(72))).toBeNull();
    expect(validate_password("a".repeat(73))).toContain("72 bytes");
    expect(validate_password("é".repeat(37))).toContain("72 bytes"); // 74 bytes
  });
});

describe("validate_name", () => {
  test("users.name is varchar(60): longer names are refused, blank falls back to the default", () => {
    expect(validate_name(undefined)).toBeNull();
    expect(validate_name("   ")).toBeNull();
    expect(validate_name("n".repeat(60))).toBeNull();
    expect(validate_name(` ${"n".repeat(60)} `)).toBeNull(); // trimmed
    expect(validate_name("n".repeat(61))).toContain("at most 60");
    expect(validate_name("😀".repeat(60))).toBeNull(); // 60 characters, 120 UTF-16 units
  });
});

describe("describe_seed_error", () => {
  // A failing query's error as drizzle-orm throws it: the message lists every
  // bound param, the hash included.
  const query_error = (hashed_password: string) =>
    new DrizzleQueryError(
      'insert into "users" ("name", "email", "hashed_password", "role") values ($1, $2, $3, $4)',
      ["Super Admin", "admin@gmail.com", hashed_password, "admin"],
      Object.assign(new Error("value too long for type character varying(60)"), { code: "22001" }),
    );

  test("a failed insert never prints the hash (stores that throw DrizzleQueryError)", async () => {
    let seen_hash = "";
    const store: SeedAdminStore = {
      find_by_email: async () => null,
      insert_admin: async (values) => {
        seen_hash = values.hashed_password;
        throw query_error(values.hashed_password);
      },
      reset_password: async () => ({ sessions_revoked: 0 }),
    };
    const err = await seed_admin(store, { email: "admin@gmail.com", password: PASSWORD }).catch((e) => e);
    expect(String(err.message)).toContain(seen_hash); // the raw message DOES leak it
    const printed = describe_seed_error(err);
    expect(printed).toBe("database error: value too long for type character varying(60)");
    expect(printed).not.toContain("$2");
    expect(printed).not.toContain(PASSWORD);
  });

  test("a failed reset transaction never prints the hash", async () => {
    const store: SeedAdminStore = {
      find_by_email: async () => ({ id: "u1", role: "admin" }),
      insert_admin: async () => null,
      reset_password: async (_id, hashed_password) => { throw query_error(hashed_password); },
    };
    const err = await seed_admin(store, { email: "admin@gmail.com", password: PASSWORD, reset_password: true }).catch((e) => e);
    expect(describe_seed_error(err)).not.toContain("$2");
  });

  test("a query error with no cause prints a generic line", () => {
    const e = new DrizzleQueryError("select 1", ["$2a$10$" + "a".repeat(53)]);
    expect(describe_seed_error(e)).toBe("database query failed");
  });

  test("plain errors keep their message; any stray bcrypt hash is masked", () => {
    expect(describe_seed_error(new Error("passwords do not match"))).toBe("passwords do not match");
    const hash = "$2b$10$" + "A".repeat(53);
    expect(describe_seed_error(new Error(`boom ${hash}`))).toBe("boom <redacted>");
    expect(describe_seed_error("x")).toBe("x");
  });
});
