import type Redis from "ioredis";

// =============================================================================
// redis_lease: a fenced Redis lease (SYNC_V2 §13.8 rules, §13.7 D3)
// =============================================================================
// For Redis-side or best-effort work only (§13.8): Postgres writers use the
// transaction-scoped advisory lock (jobs.ts), which dies with its
// transaction. A lease can be lost while its holder still runs (a GC pause or
// a slow FCM wave past the TTL); the FENCE makes that harmless for state the
// holder writes through the lease: each acquire takes a strictly larger
// fence, and fenced writes (set_fenced) succeed only while the lease still
// carries the writer's own token. A stale holder notices on its next fenced
// write or renew and stops.
//
// Keys (keys.ts): lease:{job} = "{holder}|{fence}" (PX ttl), lease:{job}:fence
// = counter, lease:{job}:cursor = fenced progress. `{job}` is a hash tag, so
// the two-key scripts stay single-slot.

// KEYS[1]=lease KEYS[2]=fence  ARGV[1]=holder ARGV[2]=ttl ms → fence | false
const LUA_LEASE_ACQUIRE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
local f = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. f, 'PX', ARGV[2])
return f
`;
// KEYS[1]=lease  ARGV[1]=token ARGV[2]=ttl ms → 1 renewed | 0 lost
const LUA_LEASE_RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
return 0
`;
// KEYS[1]=lease  ARGV[1]=token → 1 released | 0 not ours
const LUA_LEASE_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
// KEYS[1]=lease KEYS[2]=target  ARGV[1]=token ARGV[2]=value ("" = delete)
// ARGV[3]=ttl s → 1 written | 0 lease lost (nothing written)
const LUA_LEASE_FENCED_SET = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[2]) else redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]) end
return 1
`;

const SCRIPTS = {
  amigo_lease_acquire: { numberOfKeys: 2, lua: LUA_LEASE_ACQUIRE },
  amigo_lease_renew: { numberOfKeys: 1, lua: LUA_LEASE_RENEW },
  amigo_lease_release: { numberOfKeys: 1, lua: LUA_LEASE_RELEASE },
  amigo_lease_fenced_set: { numberOfKeys: 2, lua: LUA_LEASE_FENCED_SET },
} as const;

type ScriptClient = Record<string, (...args: (string | number)[]) => Promise<unknown>>;

type LeaseKeys = {
  lease: (job: string) => string;
  lease_fence: (job: string) => string;
  lease_cursor: (job: string) => string;
};

type Lease = {
  job: string;
  fence: number;
  token: string;
  /** Extend the TTL; false = the lease is gone (stop working). */
  renew: () => Promise<boolean>;
  /** Give it back (only if still ours). Never throws. */
  release: () => Promise<void>;
  /** The job's progress, readable by any later holder. */
  get_cursor: () => Promise<string | null>;
  /** Write progress only while still holding the lease. false = lost. */
  set_cursor: (value: string, ttl_s: number) => Promise<boolean>;
  clear_cursor: () => Promise<boolean>;
};

const create_lease_client = (client: Redis, holder: string, keys: LeaseKeys) => {
  for (const [name, def] of Object.entries(SCRIPTS)) {
    if (typeof (client as unknown as ScriptClient)[name] !== "function") client.defineCommand(name, def);
  }
  const sc = client as unknown as ScriptClient;

  /** Acquire `job` for `ttl_ms`; null when someone else holds it. */
  const acquire = async (job: string, ttl_ms: number): Promise<Lease | null> => {
    const f = await sc.amigo_lease_acquire(keys.lease(job), keys.lease_fence(job), holder, ttl_ms);
    if (f === null || f === undefined || (f as unknown) === false) return null;
    const fence = Number(f);
    const token = `${holder}|${fence}`;
    const fenced_set = async (value: string, ttl_s: number) =>
      (await sc.amigo_lease_fenced_set(keys.lease(job), keys.lease_cursor(job), token, value, ttl_s)) === 1;
    return {
      job,
      fence,
      token,
      renew: async () => (await sc.amigo_lease_renew(keys.lease(job), token, ttl_ms)) === 1,
      release: async () => {
        try {
          await sc.amigo_lease_release(keys.lease(job), token);
        } catch (err: any) {
          console.error(`[JOBS] lease ${job} release failed (expires in ≤${ttl_ms}ms): ${err?.message ?? err}`);
        }
      },
      get_cursor: () => client.get(keys.lease_cursor(job)),
      set_cursor: (value, ttl_s) => fenced_set(value, ttl_s),
      clear_cursor: () => fenced_set("", 1),
    };
  };

  return { acquire };
};

export { create_lease_client };
export type { Lease, LeaseKeys };
