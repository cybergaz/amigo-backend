import type Redis from "ioredis";
import { k } from "./keys";
import {
  LOOKUP_CHUNK,
  LUA_PRESENCE_CLAIM,
  LUA_PRESENCE_RELEASE,
  LUA_PRESENCE_REFRESH,
  LUA_PRESENCE_SET_BG,
  LUA_PRESENCE_TOUCH_POLL,
  PRESENCE_BY_WORKER_TTL_S,
  PRESENCE_HINT_TTL_S,
  PRESENCE_POLL_TTL_S,
  PRESENCE_WS_TTL_S,
  format_poll_value,
  format_ws_value,
  parse_poll_value,
  parse_waiter_value,
  parse_ws_value,
  worker_prefix,
  ws_prefix,
  type PollPresence,
  type Presence,
  type WsPresence,
} from "./presence-core";
import { encode_deliver, encode_evict, type Liveness } from "./router-core";

// =============================================================================
// Presence registry bound to one ioredis connection (SYNC_V2 §13.3 presence)
// =============================================================================
// A factory, not a singleton, so tests can run the real Lua against an
// ephemeral redis-server (tests/rc2-presence-lua.test.ts). presence.ts binds
// it to rfast + WORKER_ID for the server.
//
// Every method throws on a Redis error; callers wrap them in deadline() and
// decide what failure means (§13.6.3: degrade to local-only + FCM).
// Each call is ONE round trip (a single command or one pipeline).

type KeyBuilders = Pick<typeof k, "presence_ws" | "presence_poll" | "presence_hint" | "presence_by_worker"> &
  Partial<Pick<typeof k, "poll_waiter">>;

type RefreshEntry = { uid: string; cid: string; bg: boolean };

type ClaimResult = { old_ws: WsPresence | null; old_poll: PollPresence | null };

type PipelineResult = [Error | null, unknown][] | null;

const SCRIPTS = {
  amigo_presence_claim: { numberOfKeys: 2, lua: LUA_PRESENCE_CLAIM },
  amigo_presence_release: { numberOfKeys: 1, lua: LUA_PRESENCE_RELEASE },
  amigo_presence_refresh: { numberOfKeys: 1, lua: LUA_PRESENCE_REFRESH },
  amigo_presence_set_bg: { numberOfKeys: 1, lua: LUA_PRESENCE_SET_BG },
  amigo_presence_touch_poll: { numberOfKeys: 2, lua: LUA_PRESENCE_TOUCH_POLL },
} as const;

// ioredis adds defined commands as methods at runtime (EVALSHA, falling back
// to EVAL on NOSCRIPT; pipelines load missing scripts first). Typed loosely.
type ScriptClient = Record<string, (...args: (string | number)[]) => Promise<unknown>>;

const define_scripts = (client: Redis) => {
  for (const [name, def] of Object.entries(SCRIPTS)) {
    if (typeof (client as unknown as ScriptClient)[name] !== "function") {
      client.defineCommand(name, def);
    }
  }
};

const results_or_throw = (res: PipelineResult, label: string): [Error | null, unknown][] => {
  if (!res) throw new Error(`${label}: pipeline returned no result`);
  return res;
};

const create_presence = (client: Redis, wid: string, keys: KeyBuilders = k) => {
  define_scripts(client);
  const pipe = () => client.pipeline() as unknown as ScriptClient & {
    exec: () => Promise<PipelineResult>;
    sadd: (key: string, ...m: string[]) => unknown;
    srem: (key: string, ...m: string[]) => unknown;
    expire: (key: string, s: number) => unknown;
    get: (key: string) => unknown;
    set: (...args: (string | number)[]) => unknown;
    del: (key: string) => unknown;
  };

  // §13.6.5 step 5. Takes the ws key, ends any poll lease, returns the
  // previous owners (both null when this is a fresh "online" edge).
  const claim = async (uid: string, cid: string, bg: boolean): Promise<ClaimResult> => {
    const p = pipe();
    p.amigo_presence_claim(
      keys.presence_ws(uid),
      keys.presence_poll(uid),
      format_ws_value(wid, cid, bg),
      PRESENCE_WS_TTL_S,
    );
    // The open's bg is an announcement too (presence_hint). Same pipeline.
    p.set(keys.presence_hint(uid), bg ? "1" : "0", "EX", PRESENCE_HINT_TTL_S);
    // Index for the RC-3 reaper. Same pipeline: no extra round trip.
    p.sadd(keys.presence_by_worker(wid), uid);
    p.expire(keys.presence_by_worker(wid), PRESENCE_BY_WORKER_TTL_S);
    const res = results_or_throw(await p.exec(), "presence claim");
    const [err, val] = res[0];
    if (err) throw err;
    const [old_ws, old_poll] = Array.isArray(val) ? val : [null, null];
    return { old_ws: parse_ws_value(old_ws), old_poll: parse_poll_value(old_poll) };
  };

  // One pipelined PRESENCE_REFRESH per entry (§13.7 A7). Returns the script
  // reply per entry (REFRESH_* in presence-core), -1 where that one command
  // failed. Chunked so a 2.6k-socket worker never sends one giant pipeline.
  const refresh_many = async (entries: RefreshEntry[]): Promise<number[]> => {
    const out: number[] = new Array(entries.length).fill(-1);
    const chunks: Promise<void>[] = [];
    for (let start = 0; start < entries.length; start += LOOKUP_CHUNK) {
      const slice = entries.slice(start, start + LOOKUP_CHUNK);
      const p = pipe();
      for (const e of slice) {
        p.amigo_presence_refresh(
          keys.presence_ws(e.uid),
          ws_prefix(wid, e.cid),
          format_ws_value(wid, e.cid, e.bg),
          PRESENCE_WS_TTL_S,
        );
      }
      // Re-index every refreshed user (after the scripts: replies stay
      // aligned). The index is otherwise only filled by claims, so one that
      // expired or was deleted (a Redis blip, a false reap) would leave
      // long-lived sockets out of it for good, and a later real death would
      // never release or announce them. Ghosts are harmless here: the
      // reaper releases by this wid's prefix only.
      p.sadd(keys.presence_by_worker(wid), ...slice.map((e) => e.uid));
      p.expire(keys.presence_by_worker(wid), PRESENCE_BY_WORKER_TTL_S);
      chunks.push(
        p.exec().then((res) => {
          const rows = results_or_throw(res, "presence refresh");
          slice.forEach((_, i) => {
            const [err, val] = rows[i] ?? [null, null];
            if (!err && typeof val === "number") out[start + i] = val;
          });
        }),
      );
    }
    await Promise.all(chunks);
    return out;
  };

  // Compare-delete this socket's key (close, heartbeat eviction, force
  // logout, drain). A newer socket's key is never touched.
  const release = async (uid: string, cid: string): Promise<boolean> => {
    const p = pipe();
    p.amigo_presence_release(keys.presence_ws(uid), ws_prefix(wid, cid));
    p.srem(keys.presence_by_worker(wid), uid);
    const res = results_or_throw(await p.exec(), "presence release");
    const [err, val] = res[0];
    if (err) throw err;
    return val === 1;
  };

  // Release everything a (dead) worker owned for these users: prefix
  // "owner_wid|" (§13.6.3 dead-worker branch, §13.6.6 reaper).
  const release_owned_by = async (owner_wid: string, uids: string[]): Promise<number> =>
    (await release_owned_by_uids(owner_wid, uids)).length;

  // Same, returning WHICH users lost a key (the reaper announces only those
  // offline). Chunked like refresh_many: a dead worker can own ~2.6k users.
  const release_owned_by_uids = async (owner_wid: string, uids: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (let start = 0; start < uids.length; start += LOOKUP_CHUNK) {
      const slice = uids.slice(start, start + LOOKUP_CHUNK);
      const p = pipe();
      for (const uid of slice) {
        p.amigo_presence_release(keys.presence_ws(uid), worker_prefix(owner_wid));
      }
      const rows = results_or_throw(await p.exec(), "presence release_owned_by");
      slice.forEach((uid, i) => {
        const [err, val] = rows[i] ?? [null, null];
        if (!err && val === 1) out.push(uid);
      });
    }
    return out;
  };

  // A2: the client announced background/foreground on this socket.
  const set_bg = async (uid: string, cid: string, bg: boolean): Promise<boolean> => {
    const r = await (client as unknown as ScriptClient).amigo_presence_set_bg(
      keys.presence_ws(uid),
      ws_prefix(wid, cid),
      format_ws_value(wid, cid, bg),
    );
    return r === 1;
  };

  // A4: v1 poll / send-message refreshed the lease on this worker.
  // `flag` = what the client sent (bg=1 → true, bg=0 → false, nothing →
  // null); `fallback_bg` = this worker's own belief, used only for a new
  // lease with no announced hint. See LUA_PRESENCE_TOUCH_POLL. Returns the
  // bg the registry now holds.
  // `ttl_s`: the v1 lease lives PRESENCE_POLL_TTL_S; a poll v2 long-poll
  // passes wait + 15 s (§13.17.2) so the key outlives the parked request.
  const touch_poll = async (
    uid: string,
    flag: boolean | null,
    fallback_bg: boolean,
    ttl_s: number = PRESENCE_POLL_TTL_S,
  ): Promise<boolean> => {
    const r = await (client as unknown as ScriptClient).amigo_presence_touch_poll(
      keys.presence_poll(uid),
      keys.presence_hint(uid),
      wid,
      flag === null ? "" : flag ? "1" : "0",
      fallback_bg ? "1" : "0",
      ttl_s,
      PRESENCE_HINT_TTL_S,
    );
    return r === "1";
  };

  // connection:status, on whichever worker the frame landed: remember it
  // (hint, so a lease created later on ANY worker starts from it) and flip bg
  // on an existing poll lease only (XX), without extending it (KEEPTTL) — a
  // status frame is not a poll. One round trip.
  const set_poll_bg = async (uid: string, bg: boolean): Promise<void> => {
    const res = await client
      .pipeline()
      .set(keys.presence_hint(uid), bg ? "1" : "0", "EX", PRESENCE_HINT_TTL_S)
      .set(keys.presence_poll(uid), format_poll_value(wid, bg), "KEEPTTL", "XX")
      .exec();
    for (const [err] of results_or_throw(res as PipelineResult, "presence set_poll_bg")) if (err) throw err;
  };

  const del_poll = async (uid: string): Promise<void> => {
    await client.del(keys.presence_poll(uid));
  };

  // §13.5 "Lookups": GET ws + GET poll per user, chunks of 250 sent
  // concurrently (one round trip of wall time). Aligned with `uids`.
  // `waiters` (R3, §13.17.3): also GET poll:waiter in the same pipeline, so
  // a fan-out finds the worker holding a recipient's long-poll without a
  // second round trip.
  const lookup = async (uids: string[], opts: { waiters?: boolean } = {}): Promise<Presence[]> => {
    const with_waiters = opts.waiters === true && typeof keys.poll_waiter === "function";
    const per = with_waiters ? 3 : 2;
    const out: Presence[] = new Array(uids.length);
    const chunks: Promise<void>[] = [];
    for (let start = 0; start < uids.length; start += LOOKUP_CHUNK) {
      const slice = uids.slice(start, start + LOOKUP_CHUNK);
      const p = pipe();
      for (const uid of slice) {
        p.get(keys.presence_ws(uid));
        p.get(keys.presence_poll(uid));
        if (with_waiters) p.get(keys.poll_waiter!(uid));
      }
      chunks.push(
        p.exec().then((res) => {
          const rows = results_or_throw(res, "presence lookup");
          slice.forEach((_, i) => {
            const [ws_err, ws_raw] = rows[i * per] ?? [null, null];
            const [poll_err, poll_raw] = rows[i * per + 1] ?? [null, null];
            if (ws_err) throw ws_err;
            if (poll_err) throw poll_err;
            const pres: Presence = { ws: parse_ws_value(ws_raw), poll: parse_poll_value(poll_raw) };
            if (with_waiters) {
              // A failed waiter GET only costs a nudge (the waiter times out),
              // never the delivery: no throw.
              const [w_err, w_raw] = rows[i * per + 2] ?? [null, null];
              pres.waiter = w_err ? null : parse_waiter_value(w_raw);
            }
            out[start + i] = pres;
          });
        }),
      );
    }
    await Promise.all(chunks);
    return out;
  };

  return {
    wid,
    claim,
    refresh_many,
    release,
    release_owned_by,
    release_owned_by_uids,
    set_bg,
    touch_poll,
    set_poll_bg,
    del_poll,
    lookup,
  };
};

type PresenceStore = ReturnType<typeof create_presence>;

// =============================================================================
// Inbox publishing (SYNC_V2 §13.6.2–§13.6.3), bound to one connection
// =============================================================================
// Per remote worker: PUBLISH the deliver frame to its inbox + EXISTS on its
// beat key, all in ONE pipeline. The router decides from (receivers, alive)
// via apply_liveness(). Same connection as every other router write, so
// frames from one worker to one recipient stay in order (§13.6.4).

type InboxKeyBuilders = Pick<typeof k, "inbox" | "worker">;

const create_inbox_publisher = (client: Redis, keys: InboxKeyBuilders = k) => {
  const publish_and_check = async (
    remote: Map<string, string[]>,
    frame: string,
  ): Promise<Map<string, Liveness>> => {
    const wids = Array.from(remote.keys());
    const p = client.pipeline();
    for (const wid of wids) {
      p.publish(keys.inbox(wid), encode_deliver(remote.get(wid)!, frame));
      p.exists(keys.worker(wid));
    }
    const rows = results_or_throw(await p.exec(), "inbox publish");
    const out = new Map<string, Liveness>();
    wids.forEach((wid, i) => {
      const [pub_err, receivers] = rows[i * 2] ?? [new Error("missing"), null];
      const [ex_err, exists] = rows[i * 2 + 1] ?? [new Error("missing"), null];
      if (pub_err || ex_err) return; // unknown → apply_liveness: offline
      out.set(wid, { receivers: Number(receivers) || 0, alive: Number(exists) === 1 });
    });
    return out;
  };

  const publish_evict = (owner_wid: string, uid: string, old_cid: string, new_cid: string) =>
    client.publish(keys.inbox(owner_wid), encode_evict(uid, old_cid, new_cid));

  return { publish_and_check, publish_evict };
};

type InboxPublisher = ReturnType<typeof create_inbox_publisher>;

export { create_presence, create_inbox_publisher };
export type { PresenceStore, InboxPublisher, RefreshEntry, ClaimResult, KeyBuilders };
