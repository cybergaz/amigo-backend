# Running two backend processes (dev) — RC-2 cross-worker routing

How to run the backend as **two processes against one Redis and one DB**, so
the RC-2 code paths (presence registry, per-worker inbox, evict / 4009,
cross-worker presence) are exercised every day before prod ever runs N > 1
(SYNC_V2_PROTOCOL.md §13.13 item 13). Nothing here changes prod: with the
shipped defaults (`CLUSTER_MAX=1`, `CLUSTER_ROUTING` unset → `local`) every
worker behaves exactly like the single process of today.

## 1. Switches

| Env | Values | Default | What it does |
|---|---|---|---|
| `CLUSTER_ROUTING` | `local` / `shadow` / `on` | `local` if `CLUSTER_MAX=1`, else `on` | `local`: today's single-process behaviour, no presence writes. `shadow`: decisions stay local, but presence keys are written and a sample of fan-outs is compared (`[CLUSTER] presence_mismatch`). `on`: the registry is authoritative (router, inbox, evict, edge-triggered online, presence-aware debounce/snapshot, async `is_user_online`). |
| `CLUSTER_MAX` | integer | `1` | `>1` turns the boot guard off (it refuses a second live worker) and makes `on` the routing default. |
| `INSTANCE_ID` | `1`, `2`, … | HTTP port | Slot id; part of `WORKER_ID` (`host:slot:boot`). Must differ per process. |
| `SERVER_PORT` / `SOCKET_PORT` | ports | `5000` / `5002` | Must differ per process (`reusePort` is off; a clash is retried, never shared). |
| `REDIS_NS` | `p` / `d` | from `APP_ENV` | Namespace of every NEW key (`d:presence:{uid}:ws`, `d:ws:deliver:{wid}`, `d:worker:{wid}` …). Both processes of one deployment must use the same value. |
| `CLUSTER_PRESENCE_DEADLINE_MS` | ms | `500` | Hard deadline for presence lookups / inbox publish on a fan-out. Raise to 800 if Redis is far (V13). |
| `CLUSTER_SHADOW_SAMPLE` | 0–1 | `0.1` | Share of fan-outs compared in `shadow`. |
| `WS_CLOSE_REPLACED` | `1` / `0` | `1` | Close a user's previous socket with 4009 when a new one registers (§13.6.5). `0` = old behaviour (leave it open, unrouted). Damped per user: > 4 replacements in 60 s stop closing until the user is quiet. |
| `WS_OPEN_MAX_INFLIGHT` | integer | `64` with `on`, else `0` (off) | Open admission: more opens in flight → `close(1013)`. |

All processes of a deployment must run the **same** `CLUSTER_ROUTING`. A
`local` worker writes no presence, so `on` siblings would treat its users as
offline (they still get FCM + the pending store; nothing is lost, but live
delivery is not cross-worker).

## 2. Start two processes (dev box or laptop)

Same checkout, same `.env` (dev DB, **dev's own Redis**, `APP_ENV=dev`), two
terminals:

```bash
# terminal 1
INSTANCE_ID=1 SERVER_PORT=5008 SOCKET_PORT=5009 CLUSTER_MAX=2 CLUSTER_ROUTING=on bun run src/server.ts
# terminal 2
INSTANCE_ID=2 SERVER_PORT=5018 SOCKET_PORT=5019 CLUSTER_MAX=2 CLUSTER_ROUTING=on bun run src/server.ts
```

Each logs `[BOOT] wid=… ns=d cluster_max=2 routing=on … ready`. Port numbers
are examples: dev guest builds talk to `5008/5009` directly by IP
(`env.dart`), so slot 1 keeps those and slot 2 is reached by pointing a
second (debug) build at `5018/5019`, or through a dev nginx upstream like
`deploy/nginx/amigo-upstreams.conf` with the dev ports.

With systemd on the dev box, the same thing is two instances of a copy of
`amigo@.service` with `EnvironmentFile=` pointing at the dev env, the dev
ports, and `Environment=CLUSTER_MAX=2`, `Environment=CLUSTER_ROUTING=on`,
`Environment=REDIS_NS=d`.

## 3. Check it is really two workers

- `GET /api/admin/cluster/workers` (admin token) on either port: both workers,
  their WS / poll counts, event-loop lag, rev, uptime, beat age. The admin
  dashboard's "online users" is the sum over these beats.
- Counters, every 10 min in the log (`[CLUSTER] counters {...}` per worker):
  `remote_deliveries`, `remote_received`, `remote_miss`, `evict_sent`,
  `evicted_ghosts`, `presence_selfheal`, `presence_bg_repair`,
  `presence_ghost`, `router_deadline_hit`, `publish_zero_live`,
  `publish_zero_dead`, `wedged_reclass`, `debounce_skip_present`,
  `online_edge_suppressed`, `evict_pingpong_suppressed`, `bus_resyncs`.
- Redis (dev's, read-only): `redis-cli --scan --pattern 'd:presence:*' | head`,
  `GET d:presence:{<uid>}:ws` → `wid|cid|bg`.

## 4. Manual smoke (two phones / one phone + one emulator)

Pin client A to slot 1 and client B to slot 2, then check each line:

1. DM A→B: B gets it live; A gets `sent` and then `delivered` ticks.
2. Group with members on both slots: everyone gets it live.
3. Typing A→B shows on B.
4. Presence: B comes online → A sees "online"; B force-quits → A sees
   "offline" after ~8 s; B reconnects to the OTHER slot within 8 s → A never
   sees "offline" (`debounce_skip_present`).
5. Call A→B rings on B; accept / decline / end reach the other side.
6. Background B (home button) and send to it: B gets an FCM push and the
   live frame (`background` bucket via the presence `bg` flag).
7. Backgrounded poller (B on long-polling, backgrounded): FCM arrives.
8. Force-logout: log B in on another device → old device is logged out
   whichever slot it was on.
9. Evict: B connected to slot 2, then (airplane on/off) reconnects to slot
   1 while slot 2 still holds the old socket → slot 2 logs `evicted_ghosts`,
   the old socket closes with 4009, B keeps working.
10. Drain: `kill -TERM` slot 2 → its clients get `socket:restart` + 1012 and
    land on slot 1 within seconds; no "offline" flaps.
11. Redis pause (dev Redis only): fan-outs still complete within ~0.5 s,
    users on the other slot get FCM (`router_deadline_hit`).

`scripts/cluster-smoke.ts` (§13.13 item 13) is the automated version of this
list; it is part of RC-4 and not written yet.

## 5. Back to one process

Stop slot 2. Slot 1 notices within ≤ 5 s (worker beats) that it is the sole
worker and stops doing any Redis lookup for delivery. To also stop writing
presence, restart it without `CLUSTER_ROUTING` / with `CLUSTER_MAX=1`.

## 6. Prod at N=1 (before RC-4)

Ship with the defaults (`local`). To measure the registry without depending
on it, set `CLUSTER_ROUTING=shadow` on the slot unit and watch
`[CLUSTER] presence_mismatch` (gate item 5: ≈ 0) for a few days. `on` at
N=1 is also safe: recipients on this worker are delivered in-process, and
while no sibling is live everything else is classified from the local maps
(no Redis round trip on a fan-out); it adds one awaited presence claim per WS
open and enables open admission.

## 7. Redis keys used by RC-2

All behind `REDIS_NS` (`p:` / `d:`), `{uid}` is a hash tag (§13.4):

| Key / channel | Type | Value | TTL |
|---|---|---|---|
| `presence:{uid}:ws` | string | `wid\|cid\|bg` | 45 s, refreshed every 15 s |
| `presence:{uid}:poll` | string | `wid\|bg` | 12 s (v1 poll lease) |
| `presence:by_worker:{wid}` | set | uids | 60 s, refreshed (RC-3 reaper) |
| `ws:deliver:{wid}` | channel | inbox frames (`d`/`e`/`n`/`s`, §13.6.2) | – |
| `worker:{wid}`, `workers` | string, zset | beat (RC-1) | 15 s / pruned |

Pre-existing keys and channels (`ws:broadcast`, `ws:force_logout`,
`conv:invalidate`, `user_peer:invalidate`, `fcm:invalidate`, the pending
store `poll:user:*`, caches) keep their exact names: renaming them on deploy
would orphan live data and split old/new workers during a swap (§13.4).

## 8. RC-3 additions (per-process state removed)

| Key / channel | Type | Value | TTL | Who |
|---|---|---|---|---|
| `settings:invalidate` | channel | app_settings key (`marquee_banner`, `app_version:{platform}`, `sync_v2*`) | – | writers → every worker drops / re-reads |
| `reap:{wid}` | string | reaping wid | 300 s | reaper claim (one worker per dead wid) |
| `{db}:lease:{job}`, `…:fence`, `…:cursor` | string, counter, string | `holder\|fence`, n, JSON | lease ttl / – / 1 day | `redis_lease` (FCM broadcast) |
| `poll:user:{uid}:messages_v2` field value | — | entry JSON now starts `{"v":"<uuidv7>",…`; a drained-but-young entry reads `~<v>` | unchanged | pending store (C2/C3) |

What to watch while two processes run in `on`:
- Kill one with `kill -9`. Within about 20 s the survivor logs `[CLUSTER] reaped dead worker <wid>: indexed=… released=… offline=…`, and the peers of users who did not reconnect see them go offline.
- `[POLL] db_write_skipped_tomb` / `db_write_compensated` > 0 mean the tombstone guard stopped a deferred DB write that a drain on the other worker had made obsolete. `db_guard_failed` should stay at 0.
- `bun run scripts/set-sync-v2-flag.ts sync_v2 shadow` logs `[SYNCV2] flags changed` on BOTH workers at once, not up to 5 s apart.
