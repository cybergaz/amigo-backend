#!/usr/bin/env bash
# /opt/amigo/bin/deploy.sh — A/B slot deploys for the Amigo backend
# (SYNC_V2 §13.10.4). Run by a human with sudo; nothing runs it automatically.
#
#   sudo deploy.sh prepare <git-ref>    archive the commit into
#                                       /opt/amigo/releases/<sha> and install
#                                       its dependencies (frozen lockfile).
#                                       Touches nothing that is running.
#   sudo deploy.sh swap <sha>           start the new release in the idle slot,
#                                       wait until ready, move the boot
#                                       enablement to it, drain and stop the
#                                       old slot, verify the public rev.
#   sudo deploy.sh <git-ref>            prepare + (ledger confirmation) + swap
#   sudo deploy.sh rollback             swap back to the previous release
#   deploy.sh status                    show slots, releases, revs
#
# Ledger scripts (scripts/migrations, `bun run script:migrate`) are NEVER run
# here. Between prepare and swap, check and apply them yourself:
#   sudo /opt/amigo/bin/amigo-run.sh --release <sha> bun run script:migrate status
#   sudo /opt/amigo/bin/amigo-run.sh --release <sha> bun run script:migrate up
# `swap` asks you to confirm that (or pass --ledger-checked).
#
# Layout:
#   /opt/amigo/releases/<sha>   one dir per release (git archive + REVISION)
#   /opt/amigo/current          symlink → the release the ACTIVE slot runs
#   /etc/amigo/active           live slot number (1 or 2)
#   /etc/amigo/release          live release sha
#   /etc/amigo/previous_release release before that (rollback target)
#   /etc/amigo/prod.env         environment (see deploy/prod.env.example)
#
# Every step either completes or leaves the old slot serving: the old slot is
# only stopped after the new one is ready, enabled and verified locally.
set -euo pipefail

# ---------------------------------------------------------------- settings
REPO="${REPO:-/home/ubuntu/amigo-backend}"     # git checkout to archive from
APP_USER="${APP_USER:-ubuntu}"
BUN="${BUN:-/home/ubuntu/.bun/bin/bun}"
BUN_VERSION="1.3.6"                              # keep in sync with package.json engines.bun
BASE="${BASE:-/opt/amigo}"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
ETC="${ETC:-/etc/amigo}"
ENV_FILE="$ETC/prod.env"
ACTIVE_FILE="$ETC/active"
RELEASE_FILE="$ETC/release"
PREVIOUS_FILE="$ETC/previous_release"
SWAP_FILE="${AMIGO_SWAP_FILE:-/run/amigo/swap}"
PUBLIC_HEALTHZ="${PUBLIC_HEALTHZ:-https://api.amigochats.com/api/healthz}"
LOCK_FILE="/run/amigo/deploy.lock"

# ---------------------------------------------------------------- helpers
# stderr, so functions whose stdout is captured ($(resolve_sha …)) stay clean
log() { printf '[deploy] %s\n' "$*" >&2; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "run with sudo (systemctl, /etc/amigo and /opt/amigo need root)"
}

as_app() { sudo -u "$APP_USER" -H "$@"; }

short() { printf '%s' "${1:0:12}"; }

http_port() { printf '510%s' "$1"; }
ws_port() { printf '520%s' "$1"; }

# rev field of a healthz JSON body (no jq dependency)
rev_of() { sed -n 's/.*"rev":"\([^"]*\)".*/\1/p'; }

active_slot() {
  local s
  s="$(cat "$ACTIVE_FILE" 2>/dev/null || true)"
  case "$s" in 1|2) printf '%s' "$s" ;; *) printf '' ;; esac
}

port_in_use() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }

take_lock() {
  mkdir -p /run/amigo
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another deploy.sh is running"
}

check_bun() {
  [ -x "$BUN" ] || die "bun not found at $BUN"
  local v
  v="$(as_app "$BUN" --version)"
  [ "$v" = "$BUN_VERSION" ] || die "bun is $v, expected $BUN_VERSION (pinned; see package.json engines)"
}

# ---------------------------------------------------------------- prepare
resolve_sha() {
  local ref="$1"
  as_app git -C "$REPO" fetch --quiet origin || log "warning: git fetch failed; using local refs"
  as_app git -C "$REPO" rev-parse --verify --quiet "${ref}^{commit}" \
    || die "unknown git ref '$ref' in $REPO"
}

prepare() {
  local ref="$1" sha dir tmp
  check_bun
  sha="$(resolve_sha "$ref")"
  dir="$RELEASES/$sha"
  if [ -f "$dir/.prepared" ]; then
    log "release $(short "$sha") already prepared at $dir"
    printf '%s\n' "$sha" > /run/amigo/last_prepared
    return 0
  fi
  mkdir -p "$RELEASES"
  tmp="$RELEASES/.tmp-$sha"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  log "archiving $(short "$sha") from $REPO"
  as_app git -C "$REPO" archive --format=tar "$sha" | tar -x -C "$tmp"
  # GIT_REV for healthz / the worker beat (release dirs have no .git).
  short "$sha" > "$tmp/REVISION"
  # Bun auto-loads .env from the working directory. A release must take its
  # environment from /etc/amigo/prod.env only (V3), so refuse one with .env.
  [ ! -e "$tmp/.env" ] || die "release contains .env; remove it from git first"
  chown -R "$APP_USER:$APP_USER" "$tmp"
  log "installing dependencies (frozen lockfile, production)"
  (cd "$tmp" && as_app "$BUN" install --frozen-lockfile --production)
  touch "$tmp/.prepared"
  chown "$APP_USER:$APP_USER" "$tmp/.prepared"
  mv -T "$tmp" "$dir"
  printf '%s\n' "$sha" > /run/amigo/last_prepared
  log "prepared $dir"
  log "next: check ledger scripts for this release, then swap:"
  log "  sudo $BASE/bin/amigo-run.sh --release $sha bun run script:migrate status"
  log "  sudo $0 swap $sha"
}

# ---------------------------------------------------------------- swap
confirm_ledger() {
  local sha="$1" answer
  [ "${LEDGER_CHECKED:-0}" = "1" ] && return 0
  [ -t 0 ] || die "not interactive: pass --ledger-checked once ledger scripts are handled"
  echo
  echo "Ledger scripts are never run by this script. Pending ones for this release:"
  echo "  sudo $BASE/bin/amigo-run.sh --release $sha bun run script:migrate status"
  read -r -p "Have pending ledger scripts been checked/applied? Type 'yes' to continue: " answer
  [ "$answer" = "yes" ] || die "aborted (nothing changed)"
}

point_current() {
  ln -sfn "$1" "$CURRENT.tmp"
  mv -T "$CURRENT.tmp" "$CURRENT"
}

local_rev() {
  curl -fsS --max-time 3 "http://127.0.0.1:$(http_port "$1")/api/healthz" 2>/dev/null | rev_of || true
}

swap() {
  local sha="$1" dir old new prev_target want got i
  dir="$RELEASES/$sha"
  [ -f "$dir/.prepared" ] || die "release $sha is not prepared (run: $0 prepare <ref>)"
  [ -r "$ENV_FILE" ] || die "missing $ENV_FILE"
  check_bun
  want="$(short "$sha")"

  old="$(active_slot)"
  [ -n "$old" ] || die "$ACTIVE_FILE missing or invalid; the first slot is started by hand (CUTOVER.md)"
  new=$(( 3 - old ))
  systemctl is-active --quiet "amigo@$old" || die "active slot amigo@$old is not running; fix that first (systemctl status amigo@$old)"
  if systemctl is-active --quiet "amigo@$new"; then
    die "amigo@$new is already running; stop it first (sudo systemctl stop amigo@$new)"
  fi
  port_in_use "$(http_port "$new")" && die "port $(http_port "$new") is in use"
  port_in_use "$(ws_port "$new")" && die "port $(ws_port "$new") is in use"

  confirm_ledger "$sha"

  log "swap: slot $old → slot $new, release $want"
  prev_target="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  point_current "$dir"

  # Authorises the boot guard to start a second ready worker while the old
  # slot is still live (valid for 180 s).
  mkdir -p /run/amigo
  touch "$SWAP_FILE"

  log "starting amigo@$new (blocks until /api/readyz is 200, max 60 s)"
  if ! systemctl start "amigo@$new"; then
    log "amigo@$new failed to become ready; last log lines:"
    journalctl -u "amigo@$new" -n 40 --no-pager || true
    systemctl stop "amigo@$new" || true
    [ -n "$prev_target" ] && point_current "$prev_target"
    rm -f "$SWAP_FILE"
    die "swap aborted; amigo@$old is still serving, nothing else changed"
  fi

  got="$(local_rev "$new")"
  if [ "$got" != "$want" ]; then
    systemctl stop "amigo@$new" || true
    [ -n "$prev_target" ] && point_current "$prev_target"
    rm -f "$SWAP_FILE"
    die "amigo@$new reports rev '$got', expected '$want'; swap aborted, amigo@$old still serving"
  fi
  log "amigo@$new ready, rev $got"

  # Boot enablement moves in ONE step: from here on a reboot starts exactly
  # the new slot (and the boot guard would refuse a stray second one).
  systemctl enable --quiet "amigo@$new" "amigo-watchdog@$new.timer"
  systemctl disable --quiet "amigo@$old" "amigo-watchdog@$old.timer"
  systemctl start "amigo-watchdog@$new.timer"
  systemctl stop "amigo-watchdog@$old.timer"

  # Slow drain: the old slot hands its sockets to the new one over ~45 s
  # (socket:restart + 1012), then exits. Blocks up to TimeoutStopSec=90.
  log "draining amigo@$old (≈50 s)"
  systemctl stop "amigo@$old"
  rm -f "$SWAP_FILE"

  printf '%s\n' "$new" > "$ACTIVE_FILE.tmp" && mv -f "$ACTIVE_FILE.tmp" "$ACTIVE_FILE"
  local prev_sha
  prev_sha="$(cat "$RELEASE_FILE" 2>/dev/null || true)"
  if [ -n "$prev_sha" ] && [ "$prev_sha" != "$sha" ]; then
    printf '%s\n' "$prev_sha" > "$PREVIOUS_FILE"
  fi
  printf '%s\n' "$sha" > "$RELEASE_FILE"

  # Through Cloudflare + nginx: only the new slot is left, so the rev must match.
  for i in 1 2 3 4 5; do
    got="$(curl -fsS --max-time 5 "$PUBLIC_HEALTHZ" 2>/dev/null | rev_of || true)"
    [ "$got" = "$want" ] && break
    sleep 2
  done
  if [ "$got" = "$want" ]; then
    log "done: $PUBLIC_HEALTHZ reports rev $got (slot $new)"
  else
    log "WARNING: $PUBLIC_HEALTHZ reports rev '${got:-unreachable}', expected $want."
    log "         Slot $new is live locally. Check nginx upstreams and Cloudflare."
    log "         To roll back: sudo $0 rollback"
    exit 1
  fi
}

# ---------------------------------------------------------------- status
status() {
  local s state rev enabled
  echo "active slot:      $(active_slot || true)"
  echo "live release:     $(cat "$RELEASE_FILE" 2>/dev/null || echo '-')"
  echo "previous release: $(cat "$PREVIOUS_FILE" 2>/dev/null || echo '-')"
  echo "current ->        $(readlink -f "$CURRENT" 2>/dev/null || echo '-')"
  for s in 1 2; do
    state="$(systemctl is-active "amigo@$s" 2>/dev/null || true)"
    rev="$(local_rev "$s")"
    enabled="$(systemctl is-enabled "amigo@$s" 2>/dev/null || true)"
    echo "amigo@$s:          ${state:-unknown} (enabled: ${enabled:-no}) rev ${rev:--}"
  done
  echo "releases:"
  ls -1t "$RELEASES" 2>/dev/null | grep -v '^\.' | head -10 | sed 's/^/  /' || true
}

# ---------------------------------------------------------------- main
LEDGER_CHECKED=0
args=()
for a in "$@"; do
  case "$a" in
    --ledger-checked) LEDGER_CHECKED=1 ;;
    *) args+=("$a") ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"

cmd="${1:-}"
case "$cmd" in
  status)
    status
    ;;
  prepare)
    require_root; take_lock
    prepare "${2:?usage: deploy.sh prepare <git-ref>}"
    ;;
  swap)
    require_root; take_lock
    swap "${2:?usage: deploy.sh swap <sha>}"
    ;;
  rollback)
    require_root; take_lock
    prev="$(cat "$PREVIOUS_FILE" 2>/dev/null || true)"
    [ -n "$prev" ] || die "no previous release recorded in $PREVIOUS_FILE"
    log "rolling back to $(short "$prev") (same A/B swap; ledger scripts are additive, nothing to undo)"
    LEDGER_CHECKED=1
    swap "$prev"
    ;;
  ""|-h|--help|help)
    sed -n '2,30p' "$0"
    ;;
  *)
    require_root; take_lock
    prepare "$cmd"
    swap "$(cat /run/amigo/last_prepared)"
    ;;
esac
