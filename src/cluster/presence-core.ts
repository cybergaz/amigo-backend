// =============================================================================
// Presence registry — pure parts (SYNC_V2 §13.4, §13.5)
// =============================================================================
// Value formats, TTLs and the Lua sources. No Redis client here so the codec
// is unit-testable and presence-store.ts can bind the scripts to any ioredis
// connection (rfast in prod, an ephemeral server in tests).
//
//   presence:{uid}:ws   = "wid|cid|bg"   EX 45, refreshed every 15 s
//   presence:{uid}:poll = "wid|bg"       EX 12 (v1 poll lease)
//   presence:{uid}:hint = "bg"           EX 7 d (last announced state)
//
// bg is "1" / "0". A wid is host:slot:boot and never contains "|"; a cid is
// 12 hex. Prefix compares ("wid|cid|" for one socket, "wid|" for everything a
// worker owned) are what make every write a compare-and-set: a worker can
// only ever overwrite or delete what it itself wrote.

const PRESENCE_WS_TTL_S = 45;
const PRESENCE_REFRESH_MS = 15_000;
// v1 lease: the old in-process lease counted a poll as "fresh" for 10 s; the
// key outlives that by 2 s so a poll that lands just before a fan-out is
// never missed because of clock rounding between the two.
const PRESENCE_POLL_TTL_S = 12;
const PRESENCE_BY_WORKER_TTL_S = 60;
// Same lifetime as presence-flags.ts's in-process hint.
const PRESENCE_HINT_TTL_S = 7 * 24 * 60 * 60;
// Hard deadline for any presence / router Redis call on a hot path (§13.6.3;
// V13 may raise it to 800 ms if prod Redis turns out to be far away).
const PRESENCE_DEADLINE_MS = Math.max(
  100,
  parseInt(process.env.CLUSTER_PRESENCE_DEADLINE_MS || "500") || 500,
);
// lookup() pipelines GETs in chunks of this many users (§13.5 "Lookups").
const LOOKUP_CHUNK = 250;

type WsPresence = { wid: string; cid: string; bg: boolean };
type PollPresence = { wid: string; bg: boolean };
// A parked poll v2 request (R3): which worker holds it. Only filled by
// lookup(…, { waiters: true }).
type WaiterPresence = { wid: string; req_id: string };
type Presence = { ws: WsPresence | null; poll: PollPresence | null; waiter?: WaiterPresence | null };

const bg_flag = (bg: boolean) => (bg ? "1" : "0");

const format_ws_value = (wid: string, cid: string, bg: boolean): string =>
  `${wid}|${cid}|${bg_flag(bg)}`;
// Prefix that matches exactly one socket's value whatever its bg flag.
const ws_prefix = (wid: string, cid: string): string => `${wid}|${cid}|`;
// Prefix that matches every value a worker wrote (reaper / dead worker).
const worker_prefix = (wid: string): string => `${wid}|`;
const format_poll_value = (wid: string, bg: boolean): string => `${wid}|${bg_flag(bg)}`;

const parse_ws_value = (raw: unknown): WsPresence | null => {
  if (typeof raw !== "string" || !raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  return { wid: parts[0], cid: parts[1], bg: parts[2] === "1" };
};

const parse_poll_value = (raw: unknown): PollPresence | null => {
  if (typeof raw !== "string" || !raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 2 || !parts[0]) return null;
  return { wid: parts[0], bg: parts[1] === "1" };
};

// "wid|req_id" (poll:waiter). req_id is validated by the poll route to
// [A-Za-z0-9_.:-] (no "|", no newline: it travels in inbox headers too).
const format_waiter_value = (wid: string, req_id: string): string => `${wid}|${req_id}`;
const parse_waiter_value = (raw: unknown): WaiterPresence | null => {
  if (typeof raw !== "string" || !raw) return null;
  const i = raw.lastIndexOf("|");
  if (i <= 0 || i === raw.length - 1) return null;
  return { wid: raw.slice(0, i), req_id: raw.slice(i + 1) };
};

// ---- Lua (§13.5, verbatim semantics) -----------------------------------------

// KEYS[1]=presence:{uid}:ws KEYS[2]=presence:{uid}:poll ARGV[1]="wid|cid|bg"
// ARGV[2]=ttl → {old_ws or false, old_poll or false}. Taking the ws key also
// ends a poll lease: the user moved to a socket.
const LUA_PRESENCE_CLAIM = `
local old = redis.call('GET', KEYS[1])
local oldp = redis.call('GET', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('DEL', KEYS[2])
return {old or false, oldp or false}
`;

// KEYS[1] ARGV[1]=prefix "wid|cid|" (or "wid|") → 1 deleted / 0 not ours.
const LUA_PRESENCE_RELEASE = `
local cur = redis.call('GET', KEYS[1])
if cur and string.sub(cur, 1, #ARGV[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// KEYS[1] ARGV[1]=prefix ARGV[2]=full value (current local bg) ARGV[3]=ttl
// → 2 self-heal (key was gone), 3 value repaired (a lost SET_BG), 1 ttl
// extended, 0 someone else owns it (ghost → the caller closes 4009).
const LUA_PRESENCE_REFRESH = `
local cur = redis.call('GET', KEYS[1])
if not cur then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 2 end
if string.sub(cur, 1, #ARGV[1]) == ARGV[1] then
  if cur ~= ARGV[2] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 3 end
  redis.call('EXPIRE', KEYS[1], ARGV[3]) return 1
end
return 0
`;

// KEYS[1] ARGV[1]=prefix ARGV[2]=new full value → 1 set / 0 not ours.
// KEEPTTL: a bg flip must not extend a lease the owner stopped refreshing.
const LUA_PRESENCE_SET_BG = `
local cur = redis.call('GET', KEYS[1])
if cur and string.sub(cur, 1, #ARGV[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL') return 1 end
return 0
`;

// v1 poll / send-message touched the lease (A4). KEYS[1]=poll KEYS[2]=hint
// ARGV[1]=wid ARGV[2]=client flag "1" | "0" | "" (none sent) ARGV[3]=this
// worker's fallback "1" | "0" ARGV[4]=poll ttl ARGV[5]=hint ttl → the bg
// written. The registry is the source of truth for a poller's bg: a request
// WITHOUT a flag (every 4.2.2 poll) keeps the stored bg instead of
// overwriting it with whatever the worker that happened to get this request
// believes — nginx spreads one user's polls and POSTs over the workers, and
// a stale 'online' there used to cost the backgrounded phone its FCM. A new
// lease starts from the announced hint, else from the worker's fallback.
const LUA_PRESENCE_TOUCH_POLL = `
local bg = ARGV[2]
if bg == '1' or bg == '0' then
  redis.call('SET', KEYS[2], bg, 'EX', ARGV[5])
else
  local cur = redis.call('GET', KEYS[1])
  if cur then bg = string.sub(cur, -1) else bg = redis.call('GET', KEYS[2]) or ARGV[3] end
end
if bg ~= '1' then bg = '0' end
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. bg, 'EX', ARGV[4])
return bg
`;

const REFRESH_GHOST = 0;
const REFRESH_OK = 1;
const REFRESH_SELFHEAL = 2;
const REFRESH_BG_REPAIR = 3;

export {
  PRESENCE_WS_TTL_S,
  PRESENCE_REFRESH_MS,
  PRESENCE_POLL_TTL_S,
  PRESENCE_BY_WORKER_TTL_S,
  PRESENCE_HINT_TTL_S,
  PRESENCE_DEADLINE_MS,
  LOOKUP_CHUNK,
  format_ws_value,
  ws_prefix,
  worker_prefix,
  format_poll_value,
  parse_ws_value,
  parse_poll_value,
  format_waiter_value,
  parse_waiter_value,
  LUA_PRESENCE_CLAIM,
  LUA_PRESENCE_RELEASE,
  LUA_PRESENCE_REFRESH,
  LUA_PRESENCE_SET_BG,
  LUA_PRESENCE_TOUCH_POLL,
  REFRESH_GHOST,
  REFRESH_OK,
  REFRESH_SELFHEAL,
  REFRESH_BG_REPAIR,
};
export type { WsPresence, PollPresence, WaiterPresence, Presence };
