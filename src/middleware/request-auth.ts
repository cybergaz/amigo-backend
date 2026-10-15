// =============================================================================
// Per-request identity for the route plugins
// =============================================================================
// Every authenticated route plugin used to do
//   .state({ id: "", role: "" })
//   .guard({ beforeHandle({ store }) { ...; store.id = data.id } })
// and read store.id / store.role in its handlers. Elysia's `store` is ONE
// object for the whole app, not one per request: any await between a
// request's write and its read (an async guard such as enforce_device_token,
// or the handler's own first DB call) let another request overwrite it, and
// the first request then ran as the second user. tests/store-identity.test.ts
// reproduces that with the old pattern.
//
// The identity now lives on the request's own context. Each plugin's
// `.resolve()` authenticates and returns { auth }, which Elysia merges into
// that request's context only; handlers destructure `{ auth }` (auth.id,
// auth.role). A failed check ends the request from the resolve with the same
// status + body the old guard returned (set.status = body.code, body as-is).
// `.resolve()` is local-scoped: it covers the routes registered AFTER it in
// that plugin, never the parent app or sibling plugins.
//
// No db / redis imports here, so the helpers stay unit-testable.
// =============================================================================
import { status } from "elysia";
import type { RoleType } from "@/types/user.types";

export type RequestAuth<Role extends string = RoleType> = { id: string; role: Role };

type SetLike = { status?: number | string };
type AuthData = { id: string; role: string };

/** End the request from a `.resolve()`: status = body.code, body unchanged. */
export const deny_request = <T extends { code: number }>(set: SetLike, body: T) => {
  set.status = body.code;
  return status(body.code, body);
};

/**
 * The `.resolve()` result for an app_middleware-shaped auth result: the
 * failure body as an early response, or `{ auth }` for this request only.
 * Only id + role are exposed, exactly what the old store carried.
 */
export const request_auth = <D extends AuthData, R extends { code: number; data?: D | null }>(
  set: SetLike,
  result: R & { data?: D | null },
) => {
  set.status = result.code;
  if (!result.data) return status(result.code, result);
  return { auth: { id: result.data.id, role: result.data.role as D["role"] } };
};
