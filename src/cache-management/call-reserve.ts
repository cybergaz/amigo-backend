import type Redis from "ioredis";

// =============================================================================
// Call "busy" reservation (SYNC_V2 §13.5 "Calls", §13.7 G1)
// =============================================================================
// initiate_call used to GET calls:user:{caller} and calls:user:{callee}, then
// insert the call, then SET both keys. Two calls placed at the same moment
// (A→B while C→B, or A→B while B→A) both saw "free" and both went through:
// B rang twice, and the second SET silently re-pointed B's key, so ending
// one call later released B from the other. At N>1 the two initiates also
// run on different workers, so no in-process ordering can save it.
//
// Now the key IS the reservation, taken atomically with SET NX:
//   1. SET calls:user:{caller} call_id NX EX ttl — taken → self_busy
//   2. SET calls:user:{callee} call_id NX EX ttl — taken → give back the
//      caller key (compare-delete) → callee_busy
//   3. any later failure (callee missing, DB insert, cache write) → give back
//      both (compare-delete).
// Two single-key commands, not one multi-key script, so it stays legal on a
// sharded Redis (the keys are not hash-tagged and must keep their names).
// Sequential, not pipelined: a caller who is busy never reserves (and so
// never briefly blocks) the callee. Same two round trips as the old GETs.
//
// Compare-delete everywhere a key is given back: a key that now names a
// DIFFERENT call (a later call of that user) is never touched.

const LUA_COMPARE_DEL = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

type ReserveOutcome = "ok" | "self_busy" | "callee_busy";

const user_call_key = (user_id: string): string => `calls:user:${user_id}`;

type ScriptClient = { amigo_compare_del: (key: string, value: string) => Promise<number> };

const create_call_reservations = (client: Redis, ttl_s: number) => {
  if (typeof (client as unknown as Partial<ScriptClient>).amigo_compare_del !== "function") {
    client.defineCommand("amigo_compare_del", { numberOfKeys: 1, lua: LUA_COMPARE_DEL });
  }
  const sc = client as unknown as ScriptClient;

  /** Give back `user_id`'s busy key if it still names `call_id`. */
  const release = async (user_id: string, call_id: string): Promise<boolean> =>
    (await sc.amigo_compare_del(user_call_key(user_id), call_id)) === 1;

  /** Best effort, never throws: compensation paths must not fail louder. */
  const release_all = async (user_ids: (string | null | undefined)[], call_id: string): Promise<number> => {
    let n = 0;
    await Promise.all(
      user_ids.map(async (u) => {
        if (!u) return;
        try {
          if (await release(u, call_id)) n++;
        } catch (err: any) {
          console.error(`[CALL] busy key release failed for ${u} (${call_id}); it expires in ≤${ttl_s}s: ${err?.message ?? err}`);
        }
      }),
    );
    return n;
  };

  /**
   * Reserve both parties for `call_id`. Throws on a Redis error, after giving
   * back whatever it had already taken.
   */
  const reserve = async (caller_id: string, callee_id: string, call_id: string): Promise<ReserveOutcome> => {
    const got_caller = await client.set(user_call_key(caller_id), call_id, "EX", ttl_s, "NX");
    if (got_caller !== "OK") return "self_busy";
    let got_callee: string | null;
    try {
      got_callee = await client.set(user_call_key(callee_id), call_id, "EX", ttl_s, "NX");
    } catch (err) {
      await release_all([caller_id], call_id);
      throw err;
    }
    if (got_callee !== "OK") {
      await release_all([caller_id], call_id);
      return "callee_busy";
    }
    return "ok";
  };

  return { reserve, release, release_all };
};

type CallReservations = ReturnType<typeof create_call_reservations>;

export { create_call_reservations, user_call_key, LUA_COMPARE_DEL };
export type { ReserveOutcome, CallReservations };
