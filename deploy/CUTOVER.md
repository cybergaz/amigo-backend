# Amigo backend: tmux → systemd cutover, then routine deploys

Runbook for RC-1 (SYNC_V2_PROTOCOL.md §13.10, §13.12). Everything here is
done **by you, by hand**, on the prod box. Nothing in this repository installs,
enables, starts or reloads anything by itself.

What changes: prod stops being one `bun start` in tmux (ports 5000/5002) and
becomes systemd **slots** — `amigo@1` (HTTP 5101, WS 5201) and `amigo@2`
(5102/5202) — behind nginx upstreams. At N=1 exactly one slot is live; each
deploy starts the new release in the idle slot, waits until it is ready, and
then drains the old slot into it over about 45 s. Users get `socket:restart`
plus close code 1012 and reconnect within a few seconds. Nobody is logged out,
and current and old app builds both just reconnect.

Files (all under `deploy/` in the repo):

| File | Installs to |
|---|---|
| `systemd/amigo@.service` | `/etc/systemd/system/` |
| `systemd/amigo.target`, `systemd/amigo.slice` | `/etc/systemd/system/` |
| `systemd/amigo-watchdog@.service`, `systemd/amigo-watchdog@.timer` | `/etc/systemd/system/` |
| `tmpfiles/amigo.conf` | `/etc/tmpfiles.d/` |
| `bin/wait-ready.sh`, `bin/watchdog.sh`, `bin/deploy.sh`, `bin/amigo-run.sh` | `/opt/amigo/bin/` |
| `nginx/amigo-upstreams.conf` | `/etc/nginx/conf.d/` |
| `nginx/amigo-ws.conf` | `/etc/nginx/snippets/` |
| `nginx/api-locations.example.conf` | reference only: edit your server block by hand |
| `prod.env.example` | reference only: build `/etc/amigo/prod.env` from it |

Conventions below: `$SHA` is the full commit sha of the RC-1 release, and
`$REPO` is `/home/ubuntu/amigo-backend`, today's prod checkout, which stays the
git source for `deploy.sh`.

---

## Part A — Pre-checks (read-only, change nothing)

1. **Bun.** `sudo -u ubuntu -H /home/ubuntu/.bun/bin/bun --version` must print
   `1.3.6`. The unit and `deploy.sh` use that exact path and version.
2. **V1 ports free.** `ss -ltnp | grep -E ':(5101|5102|5201|5202)\b'` must
   print nothing (true on 2026-10-13).
3. **V4 nginx.** Run `sudo nginx -T > ~/nginx-before-rc1.txt` and note:
   - `worker_connections`: want ≥ 8192, because each WS uses 2 connections;
   - which server block really serves `api.amigochats.com` (there is a
     duplicate certbot block in `sites-enabled/default`);
   - the exact `proxy_pass` lines of `location = /chat`, `/chat/`,
     `/chat/sse`, `/chat/poll` and `/`, including any URI part after the port;
   - `client_max_body_size` and anything else in `location /`;
   - that `worker_shutdown_timeout` is **not** set (keep it unset).
4. **NODE_ENV.** Find the prod bun pid with `ss -ltnp 'sport = :5000'`, then
   `sudo cat /proc/<pid>/environ | tr '\0' '\n' | sort`. Note whether
   `NODE_ENV` is set. Add it to the unit only if it is (auth cookie config).
5. **V14 Redis.** The dev instance must use its **own** Redis database, not
   prod's. Compare `REDIS_URL` in `/home/ubuntu/amigo-development/.env` and
   `$REPO/.env` (look at host and db only, don't print the password). Dev
   must also have `APP_ENV=dev`.
6. **V6 Postgres.** Run `SHOW max_connections;` on RDS. During a swap two slots
   hold up to `PG_POOL_MAX=10` each, plus scripts and dev. Keep the total
   under ~80 % of `max_connections` minus the reserved connections.
7. **Tools.** `systemd-run --version` (≥ 235 for `--pty`), plus `flock`, `ss`
   and `curl` available.

## Part B — Cutover (§13.12)

### Step 0 — Prep (no traffic impact)

```sh
# RC-1 code into the prod checkout (the running process is not affected;
# bun has its code in memory).
cd /home/ubuntu/amigo-backend
git fetch origin && git checkout <rc1-branch-or-tag> && git pull --ff-only
SHA=$(git rev-parse HEAD); echo "$SHA"

# Directories, scripts, units
sudo mkdir -p /opt/amigo/bin /opt/amigo/releases /etc/amigo
sudo install -m 0755 deploy/bin/wait-ready.sh deploy/bin/watchdog.sh \
                     deploy/bin/deploy.sh deploy/bin/amigo-run.sh /opt/amigo/bin/
sudo install -m 0644 deploy/systemd/amigo@.service deploy/systemd/amigo.target \
                     deploy/systemd/amigo.slice deploy/systemd/amigo-watchdog@.service \
                     deploy/systemd/amigo-watchdog@.timer /etc/systemd/system/
sudo install -m 0644 deploy/tmpfiles/amigo.conf /etc/tmpfiles.d/amigo.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/amigo.conf     # creates /run/amigo
sudo systemctl daemon-reload                                   # enables nothing

# nginx: upstreams + WS snippet. Defined but unused until step 3, so they
# change nothing. Validate only; no reload needed yet.
sudo install -m 0644 deploy/nginx/amigo-upstreams.conf /etc/nginx/conf.d/
sudo install -m 0644 deploy/nginx/amigo-ws.conf /etc/nginx/snippets/
sudo nginx -t
```

**Environment file.** Build `/etc/amigo/prod.env` by following
`deploy/prod.env.example`: start from `$REPO/.env` plus anything only the tmux
process has (Part A, item 4), then **remove `SERVER_PORT` and `SOCKET_PORT`**.
Copy auth-related keys (`FRONTEND_URL`, `COOKIE_DOMAIN`, the TTLs) exactly. If
`NODE_ENV` was set in tmux, uncomment it in the unit
(`sudo systemctl edit --full amigo@.service`) rather than adding it here.

```sh
sudo install -m 0640 -o root -g ubuntu /path/to/prod.env /etc/amigo/prod.env
```

**Release.** This archives `$SHA` into `/opt/amigo/releases/$SHA`, writes
`REVISION` and runs `bun install --frozen-lockfile --production`:

```sh
sudo /opt/amigo/bin/deploy.sh prepare "$SHA"
ls -a /opt/amigo/releases/$SHA/.env 2>/dev/null && echo "STOP: release has .env"   # V3: must print nothing
sudo ln -sfn /opt/amigo/releases/$SHA /opt/amigo/current
```

### Step 1 — Deploy RC-1 inside tmux (the last abrupt restart)

Restart the tmux process the way you do today, on the RC-1 code already in
`$REPO`:

```sh
cd /home/ubuntu/amigo-backend
bun install --frozen-lockfile        # package.json pins changed; resolution is identical
bun run script:migrate status        # ledger as usual; `up` only if something is pending
# in tmux session amigo-prod: stop the old process, then
bun start
```

The old build exits at once on Ctrl-C, so this one cut is abrupt like every
restart before it. From now on the tmux process drains gracefully on
SIGTERM. Check it:

```sh
curl -s localhost:5000/api/healthz      # {"svc":"amigo","ok":true,"w":"…:5000:…","rev":"<12-hex>"}
curl -s localhost:5000/api/readyz       # ok:true
```

Let it run as long as you like (minutes or days) before step 2.

### Step 2 — Start slot 1 next to tmux

```sh
sudo touch /run/amigo/swap          # authorises a 2nd worker for 180 s (boot guard)
sudo systemctl start amigo@1        # blocks until /api/readyz is 200 (max 60 s)
curl -s localhost:5101/api/healthz
journalctl -u amigo@1 -n 40 --no-pager   # [BOOT] … wid=<host>:1:<boot> … ready
```

If it does not become ready, `journalctl -u amigo@1` says why. A message
`refused_second_instance` means the swap file was missing or stale: touch it
and start again. Running both at once is safe: shared jobs are fenced (one
runner per batch), and a ring timeout fires on exactly one worker. That is
preferably the worker holding the caller's or callee's WebSocket (tmux, until
step 3), so the caller's "Calling…" screen is closed over WS. A worker without
either socket fires only if the deadline is more than 5 s overdue. Live
delivery between the two workers is still not routed (that is RC-2), so keep
the gap from step 2 to step 4 short: minutes, not hours.

### Step 3 — Point nginx at the upstreams

```sh
sudo cp -a /etc/nginx/sites-available/<api-site> /root/<api-site>.pre-rc1   # rollback copy
sudoedit /etc/nginx/sites-available/<api-site>
```

Change the locations as shown in `deploy/nginx/api-locations.example.conf`:
- retarget `location = /chat`, `location /chat/` and `location /` and keep
  their URI forms;
- delete `location /chat/poll` and `location /chat/sse`, since no backend
  route serves either;
- add the localhost-only `location = /api/readyz`.

```sh
sudo nginx -t && sudo systemctl reload nginx
```

New connections now go to slot 1. Existing WS connections to tmux stay on
the old nginx workers until they close.

### Step 4 — Drain the tmux process

```sh
ss -ltnp 'sport = :5000'            # note the bun pid (do not confuse it with the dev bun)
kill -TERM <pid>
```

**Never Ctrl-C or `kill -9`.** SIGTERM starts the slow drain: slot 1 is a live
sibling, so the sockets are handed over in 45 batches over about 45 s. The
tmux pane logs `[SHUTDOWN] …` phases and ends with `drained in …ms, exiting`.

### Step 5 — Verify

```sh
ss -ltnp | grep -E ':(5000|5002|5101|5201)\b'   # only 5101 and 5201 (amigo)
journalctl -u amigo@1 --since -5min | grep -E 'wid=|\[WS\] counters'
curl -s https://api.amigochats.com/api/healthz   # rev = ${SHA:0:12}
curl -s -o /dev/null -w '%{http_code}\n' https://api.amigochats.com/api/readyz   # 403 (localhost only)
```

Open the app on a phone: chats load, a message sends and gets its tick, and a
call rings.

### Step 6 — Make it permanent

```sh
sudo systemctl enable amigo.target amigo@1 amigo-watchdog@1.timer
sudo systemctl start amigo-watchdog@1.timer
echo 1    | sudo tee /etc/amigo/active
echo $SHA | sudo tee /etc/amigo/release
sudo rm -f /run/amigo/swap
tmux kill-session -t amigo-prod     # only after step 5 shows nothing on 5000/5002
```

`$REPO` stays the git source for deploys. Do not `bun start` in it again
except to roll back (step 7).

### Step 7 — Rollback during the cutover

Go back to tmux and let slot 1 drain into it:

```sh
sudo touch /run/amigo/swap          # the RC-1 code in tmux also has the boot guard
# tmux: cd /home/ubuntu/amigo-backend && bun start
curl -s localhost:5000/api/readyz   # wait for ok:true
sudo cp -a /root/<api-site>.pre-rc1 /etc/nginx/sites-available/<api-site>
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop amigo@1         # slow drain into tmux
sudo systemctl disable amigo@1 amigo-watchdog@1.timer
```

To go further back to a pre-RC-1 build, check out that commit in `$REPO`
and restart tmux as before step 1. Pre-RC-1 builds have no
`/api/readyz` and cannot run under `deploy.sh`.

---

## Part C — Routine deploys (after the cutover)

```sh
# 1. Build the release (touches nothing that is running)
sudo /opt/amigo/bin/deploy.sh prepare origin/<branch>      # prints the sha
# 2. Ledger scripts: deploy.sh NEVER runs them. Check, and apply if pending:
sudo /opt/amigo/bin/amigo-run.sh --release <sha> bun run script:migrate status
sudo /opt/amigo/bin/amigo-run.sh --release <sha> bun run script:migrate up
# 3. Swap (asks you to confirm step 2; --ledger-checked skips the question)
sudo /opt/amigo/bin/deploy.sh swap <sha>
```

`swap` does the following:
1. touches `/run/amigo/swap` and points `current` at the release;
2. `systemctl start amigo@NEW`, which blocks until ready;
3. checks that the slot's local `/api/healthz` reports the release's rev;
4. enables `amigo@NEW` and its watchdog timer, and disables the old slot and
   its timer, in one step;
5. `systemctl stop amigo@OLD`, a slow drain of about 50 s;
6. writes `/etc/amigo/active`, `release` and `previous_release`;
7. checks that `https://api.amigochats.com/api/healthz` reports the new rev.

If the new slot fails to become ready or reports the wrong rev, `swap` stops it
and puts `current` back. The old slot was never touched and keeps serving.

| Task | Command |
|---|---|
| One-shot deploy (prepare, ledger question, swap) | `sudo /opt/amigo/bin/deploy.sh <ref>` |
| Roll back to the previous release (the same A/B swap) | `sudo /opt/amigo/bin/deploy.sh rollback` |
| Show slots, revs and releases | `/opt/amigo/bin/deploy.sh status` |
| Gentle restart without new code | `sudo /opt/amigo/bin/deploy.sh swap $(cat /etc/amigo/release) --ledger-checked` |
| Logs | `journalctl -u amigo@$(cat /etc/amigo/active) -f` |

A plain `systemctl restart amigo@N` drains with no sibling (about 5 s), and
users wait for the new process to listen. Use the gentle restart instead.

**Updating the deploy kit itself.** When a release changes `deploy/`,
re-install from the release dir. Units take effect on a slot's next start.

```sh
R=/opt/amigo/releases/<sha>
sudo install -m 0755 $R/deploy/bin/*.sh /opt/amigo/bin/
sudo install -m 0644 $R/deploy/systemd/amigo* /etc/systemd/system/ && sudo systemctl daemon-reload
```

**Log lines worth knowing** (each counter line is printed every 10 min):
- `[BOOT] … wid=… rev=…`
- `[SHUTDOWN] <phase> <ms>`
- `[WS] counters {…}`, `[FCM] counters {…}`
- `[JOBS] counters {…}` (receipt_flush, ring_backstop, missed_cleanup)
- `[JOBS] missed_cleanup ran <ms> rows=<n>` (about once a day)
- `[CALL] counters {…}` (ring_timeout_tick / _backstop)
- `[UPLOAD] counters {…}` (large uploads admitted / refused with 503)
- `[CLUSTER] refused_second_instance` (a stray second slot was blocked)

**Rules.**
- Never enable both slots.
- Never Ctrl-C or `kill -9` a slot.
- Batch nginx reloads, and leave `worker_shutdown_timeout` unset.
- Bun stays at 1.3.6. To change it, update `BUN_VERSION` in `deploy.sh` and
  `engines.bun` in `package.json` together.
- Old releases are never deleted automatically. Prune
  `/opt/amigo/releases` by hand and keep at least the live and previous ones.

**Troubleshooting.**
- *New slot never ready.* Read `journalctl -u amigo@N`. You will see the DB or
  Redis retry lines, `listen failed` (port busy), or `refused_second_instance`.
- *Watchdog restarts.* Check `journalctl -t amigo-watchdog`. It means healthz
  failed 3 times in a row, i.e. the event loop was blocked for more than 2 s.
- *Public rev mismatch after a swap.* nginx is still pointing at something
  else (step 3 not applied, or a stale `proxy_pass`), or Cloudflare served an
  error page. The slots are fine locally (`deploy.sh status`).
