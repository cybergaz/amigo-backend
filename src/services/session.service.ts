import db from "@/config/db";
import { refresh_session_model } from "@/models/session.model";
import { auth_device_model } from "@/models/auth-device.model";
import { user_model } from "@/models/user.model";
import { generate_jwt, generate_refresh_jwt, generate_device_jwt } from "@/utils/general.utils";
import { and, eq, gt, ne, or, sql } from "drizzle-orm";
import { redis } from "@/config/redis";
import type { StringValue } from "ms";

// How long the previous refresh token stays valid after a rotation. This is what
// rescues a client whose rotation response was lost (dropped connection, server
// restart mid-deploy): it can retry with the old token within this window and
// re-sync instead of being force-logged-out.
const REFRESH_GRACE_MS = 2 * 60 * 1000;

// `grace_token`, when given, seeds the new session's previous-token slot so that an
// already-issued token stays briefly valid against the new session. Used to make the
// one-time legacy migration grace-safe (a lost migration response can still re-sync).
type SessionMeta = {
  user_agent?: string;
  ip_address?: string;
  grace_token?: string;
};

// Create a fresh session row and return its signed refresh token. The session id
// (sid) is embedded in the JWT so the token is self-identifying for the future
// "manage devices" feature. Does NOT revoke other sessions — callers that want
// single-device behaviour must call `revoke_user_sessions` first.
const create_session = async (
  user_id: string,
  role: string,
  refresh_ttl: StringValue,
  meta?: SessionMeta
): Promise<string> => {
  const sid = crypto.randomUUID();
  const refresh_token = generate_refresh_jwt(user_id, role, refresh_ttl, sid);
  await db.insert(refresh_session_model).values({
    id: sid,
    user_id,
    refresh_token,
    user_agent: meta?.user_agent,
    ip_address: meta?.ip_address,
    prev_refresh_token: meta?.grace_token,
    prev_expires_at: meta?.grace_token
      ? new Date(Date.now() + REFRESH_GRACE_MS)
      : undefined,
  });
  return refresh_token;
};

// Drop every session for a user. Used to enforce single-device on login/signup and
// to fully kill sessions on logout.
const revoke_user_sessions = async (user_id: string): Promise<void> => {
  await db
    .delete(refresh_session_model)
    .where(eq(refresh_session_model.user_id, user_id));
};

// Locate the session a refresh token belongs to: either it is the current token,
// or it is the immediately-previous token still inside its grace window.
const find_session_for_token = async (token: string, now: Date) => {
  const [session] = await db
    .select()
    .from(refresh_session_model)
    .where(
      or(
        eq(refresh_session_model.refresh_token, token),
        and(
          eq(refresh_session_model.prev_refresh_token, token),
          gt(refresh_session_model.prev_expires_at, now)
        )
      )
    )
    .limit(1);
  return session ?? null;
};

type RotateResult =
  | {
      success: true;
      code: 200;
      message: string;
      data: { access_token: string; refresh_token: string };
    }
  | { success: false; code: number; message: string };

// Grace-aware refresh-token rotation, shared by web and mobile (they differ only in
// TTLs). Resolution order:
//   1. Token matches a known session (current OR within-grace previous).
//   2. Legacy fallback: token matches the old users.refresh_token column — migrate
//      that user to a session on the fly so a pre-sessions deploy doesn't log anyone
//      out. After one refresh the user is fully session-based.
const rotate_refresh_token = async (
  token: string,
  ttls: { access: StringValue; refresh: StringValue }
): Promise<RotateResult> => {
  try {
    const now = new Date();
    const session = await find_session_for_token(token, now);

    if (session) {
      const [user] = await db
        .select({ id: user_model.id, role: user_model.role })
        .from(user_model)
        .where(eq(user_model.id, session.user_id))
        .limit(1);

      if (!user) {
        // Orphaned session (user deleted) — clean up and reject.
        await db
          .delete(refresh_session_model)
          .where(eq(refresh_session_model.id, session.id));
        return { success: false, code: 404, message: "Invalid refresh token" };
      }

      const access_token = generate_jwt(user.id, user.role || false, ttls.access);

      // Grace hit: caller presented the PREVIOUS token (its rotation response was
      // lost). Do NOT rotate again — return the current refresh token so the client
      // re-syncs, plus a fresh access token. This is the core post-deploy fix.
      if (session.refresh_token !== token) {
        return {
          success: true,
          code: 200,
          message: "Token refreshed successfully",
          data: { access_token, refresh_token: session.refresh_token },
        };
      }

      // Normal rotation. Guard the UPDATE on the current token value so two
      // concurrent rotations of the same token can't both "win" and strand a token.
      const new_refresh = generate_refresh_jwt(
        user.id,
        user.role,
        ttls.refresh,
        session.id
      );
      const updated = await db
        .update(refresh_session_model)
        .set({
          prev_refresh_token: session.refresh_token,
          prev_expires_at: new Date(now.getTime() + REFRESH_GRACE_MS),
          refresh_token: new_refresh,
          last_used_at: now,
        })
        .where(
          and(
            eq(refresh_session_model.id, session.id),
            eq(refresh_session_model.refresh_token, token)
          )
        )
        .returning({ id: refresh_session_model.id });

      if (updated.length === 0) {
        // A concurrent refresh rotated first; return the now-current token instead.
        const [fresh] = await db
          .select({ refresh_token: refresh_session_model.refresh_token })
          .from(refresh_session_model)
          .where(eq(refresh_session_model.id, session.id))
          .limit(1);
        return {
          success: true,
          code: 200,
          message: "Token refreshed successfully",
          data: {
            access_token,
            refresh_token: fresh?.refresh_token ?? new_refresh,
          },
        };
      }

      return {
        success: true,
        code: 200,
        message: "Token refreshed successfully",
        data: { access_token, refresh_token: new_refresh },
      };
    }

    // Legacy fallback (one-time, transparent migration for pre-sessions clients).
    const [legacy_user] = await db
      .select()
      .from(user_model)
      .where(eq(user_model.refresh_token, token))
      .limit(1);

    if (legacy_user) {
      await revoke_user_sessions(legacy_user.id); // single-device
      // Seed the legacy token into the grace slot so a lost migration response can
      // still be retried (closes the post-deploy race for pre-sessions clients too).
      const new_refresh = await create_session(
        legacy_user.id,
        legacy_user.role,
        ttls.refresh,
        { grace_token: token }
      );
      // Burn the legacy column so the old token can't be replayed via this path.
      await db
        .update(user_model)
        .set({ refresh_token: null })
        .where(eq(user_model.id, legacy_user.id));
      const access_token = generate_jwt(
        legacy_user.id,
        legacy_user.role || false,
        ttls.access
      );
      return {
        success: true,
        code: 200,
        message: "Token refreshed successfully",
        data: { access_token, refresh_token: new_refresh },
      };
    }

    return { success: false, code: 404, message: "Invalid refresh token" };
  } catch (error: any) {
    console.error("Refresh token error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during token refresh",
    };
  }
};

// Lightweight check that a refresh token still maps to a live session (or a legacy
// column token). Mirrors the rotation lookup but does not mutate anything.
const validate_session = async (token: string) => {
  try {
    const now = new Date();
    const session = await find_session_for_token(token, now);
    if (session) {
      return { success: true, code: 200, message: "Refresh token is valid" };
    }

    const [legacy_user] = await db
      .select({ id: user_model.id })
      .from(user_model)
      .where(eq(user_model.refresh_token, token))
      .limit(1);
    if (legacy_user) {
      return { success: true, code: 200, message: "Refresh token is valid" };
    }

    return { success: false, code: 404, message: "Invalid refresh token" };
  } catch (error: any) {
    console.error("Token validation error:", error);
    return {
      success: false,
      code: 500,
      message: "Internal server error during token validation",
    };
  }
};

// ─── Mobile single-token auth (auth_devices) ────────────────────────────────
// Separate from the refresh_sessions machinery above (web/admin). login_device is
// the single-device engine + long-lived-token minter for the mobile app.

// Evict the user's OTHER device rows (and their Redis version keys), upsert THIS
// device with a bumped token_version, and mint the long-lived device JWT. The
// bumped version is what invalidates a superseded device on the WS open check.
const login_device = async (
  user_id: string,
  role: string,
  device: { device_id: string; platform?: string; device_name?: string }
): Promise<{ token: string; token_version: number }> => {
  // 1. Evict all OTHER devices; capture them so we can purge their Redis keys.
  const removed = await db
    .delete(auth_device_model)
    .where(
      and(
        eq(auth_device_model.user_id, user_id),
        ne(auth_device_model.device_id, device.device_id)
      )
    )
    .returning({ device_id: auth_device_model.device_id });

  // 2. Upsert THIS device; bump token_version when the same device re-logs in.
  const [row] = await db
    .insert(auth_device_model)
    .values({
      user_id,
      device_id: device.device_id,
      token_version: 1,
      platform: device.platform,
      device_name: device.device_name,
      last_seen_at: new Date(),
    })
    .onConflictDoUpdate({
      target: [auth_device_model.user_id, auth_device_model.device_id],
      set: {
        token_version: sql`${auth_device_model.token_version} + 1`,
        platform: device.platform,
        device_name: device.device_name,
        last_seen_at: new Date(),
      },
    })
    .returning({ token_version: auth_device_model.token_version });

  const token_version = row.token_version;
  const token = generate_device_jwt(user_id, role, device.device_id, token_version);

  // 3. Purge evicted devices' cached versions (else a stale token could still pass
  //    the WS check off a cached value — there's no TTL), then write-through this
  //    device's current version for the WS open fast-path.
  await Promise.all(
    removed.map((r) => redis.del(`authver:${user_id}:${r.device_id}`))
  );
  await redis.set(`authver:${user_id}:${device.device_id}`, String(token_version));

  return { token, token_version };
};

// Current token_version for a device (WS open falls back to this on a Redis miss).
const get_auth_device = async (user_id: string, device_id: string) => {
  const [row] = await db
    .select({ token_version: auth_device_model.token_version })
    .from(auth_device_model)
    .where(
      and(
        eq(auth_device_model.user_id, user_id),
        eq(auth_device_model.device_id, device_id)
      )
    )
    .limit(1);
  return row ?? null;
};

export {
  create_session,
  revoke_user_sessions,
  rotate_refresh_token,
  validate_session,
  login_device,
  get_auth_device,
};
