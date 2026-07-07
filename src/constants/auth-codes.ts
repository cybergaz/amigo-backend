// ─────────────────────────────────────────────────────────────────────────────
// AUTH-FAILURE CODE REGISTRY — single source of truth.
// Mirrored in the app at amigo-app/lib/constants/auth_codes.dart. KEEP IN LOCKSTEP.
//
// RULES (for humans AND AI agents — READ before adding any error anywhere):
//   1. `auth_error` (a value from AuthError below) is the ONLY signal that a
//      request or socket failed for an AUTHENTICATION reason.
//   2. ONLY the auth layer may set `auth_error`:
//        - src/middleware/index.ts (HTTP)
//        - src/sockets/socket.server.ts (WS open auth)
//        - src/sockets/ws-broadcast.ts (the single-device force-logout frame)
//      NOTHING ELSE. Business/domain errors — wrong password (401), "not a
//      member" (403), call "busy"/"unreachable" (401/409), not-found (404),
//      role gate (403), etc. — MUST NOT carry `auth_error`. That omission is
//      exactly what makes a business error structurally incapable of logging a
//      user out.
//   3. Do NOT overload traditional HTTP status codes to mean "session dead".
//      The HTTP status stays for transport/proxies; `auth_error` carries meaning.
//   4. The mobile client decides logout from `auth_error` (see auth_codes.dart /
//      AuthFatal), NEVER from a raw HTTP status and NEVER by matching a message.
// ─────────────────────────────────────────────────────────────────────────────

export const AuthError = {
  TOKEN_MISSING: "TOKEN_MISSING", // no token presented         (HTTP 499 / WS 4001 AUTH_REQUIRED)
  TOKEN_INVALID: "TOKEN_INVALID", // malformed / bad signature  (HTTP 498 / WS 4001 AUTH_INVALID)
  TOKEN_EXPIRED: "TOKEN_EXPIRED", // well-formed but expired     (HTTP 498 / WS 4001 AUTH_INVALID)
  DEVICE_SUPERSEDED: "DEVICE_SUPERSEDED", // single-device kick (newer login)  (WS 4003)
  SESSION_REVOKED: "SESSION_REVOKED",     // server-initiated kill / admin     (WS 4003 / auth:force_logout)
  ROLE_FORBIDDEN: "ROLE_FORBIDDEN",       // valid session, wrong role — NOT fatal (HTTP 403)
} as const;

export type AuthErrorCode = (typeof AuthError)[keyof typeof AuthError];

// REST-fatal: the token itself is dead. (ROLE_FORBIDDEN excluded — the token is
// valid, only the route is off-limits.) Used for telemetry/labeling.
export const AUTH_FATAL_REST: ReadonlySet<AuthErrorCode> = new Set([
  AuthError.TOKEN_MISSING,
  AuthError.TOKEN_INVALID,
  AuthError.TOKEN_EXPIRED,
  AuthError.DEVICE_SUPERSEDED,
  AuthError.SESSION_REVOKED,
]);

// WS-terminal: the ONLY reasons that end the session over the socket. TOKEN_* are
// deliberately NOT here — a socket 4001 (token racing a hair late / a momentary
// verify blip) must RECONNECT, not log out. Only a real supersede/revoke is
// terminal on the socket. This is the fix for the transient-blip → logout class.
export const WS_TERMINAL: ReadonlySet<AuthErrorCode> = new Set([
  AuthError.DEVICE_SUPERSEDED,
  AuthError.SESSION_REVOKED,
]);

// WS close codes owned by the auth layer (single source for both ends).
export const AuthWsClose = {
  MISSING_OR_INVALID_TOKEN: 4001, // socket:error frame carries auth_error; client RECONNECTS
  FORCE_LOGOUT: 4003, // DEVICE_SUPERSEDED / SESSION_REVOKED; client LOGS OUT
} as const;

export const isAuthFatalRest = (c?: string | null): c is AuthErrorCode =>
  !!c && AUTH_FATAL_REST.has(c as AuthErrorCode);

export const isWsTerminal = (c?: string | null): c is AuthErrorCode =>
  !!c && WS_TERMINAL.has(c as AuthErrorCode);
