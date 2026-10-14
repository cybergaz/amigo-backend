#!/usr/bin/env bash
# /opt/amigo/bin/amigo-run.sh [--release <sha|dir>] <command...>
#
# Runs a one-off command (ledger scripts, set-app-version, …) as the app
# user with EXACTLY the environment the service gets: /etc/amigo/prod.env is
# parsed by systemd itself (systemd-run -p EnvironmentFile=…), not by a
# shell, so quoting rules can never differ from the running service.
# Release dirs carry no .env, so this is the only way to give a script the
# prod DB_URL / REDIS_URL.
#
# Examples:
#   sudo /opt/amigo/bin/amigo-run.sh bun run script:migrate status
#   sudo /opt/amigo/bin/amigo-run.sh --release <full 40-hex sha> bun run script:migrate up
#
# It runs only what you type. Nothing calls it automatically.
set -euo pipefail

APP_USER="${APP_USER:-ubuntu}"
BUN="${BUN:-/home/ubuntu/.bun/bin/bun}"
ENV_FILE="${ENV_FILE:-/etc/amigo/prod.env}"
RELEASES="${RELEASES:-/opt/amigo/releases}"
dir="${AMIGO_DIR:-/opt/amigo/current}"

if [ "$(id -u)" -ne 0 ]; then
  echo "amigo-run: run with sudo (systemd-run needs root to read $ENV_FILE)" >&2
  exit 1
fi

if [ "${1:-}" = "--release" ]; then
  rel="${2:?--release needs a sha or a directory}"
  shift 2
  if [ -d "$rel" ]; then dir="$rel"; else dir="$RELEASES/$rel"; fi
fi
[ "$#" -gt 0 ] || { echo "usage: amigo-run.sh [--release <sha|dir>] <command...>" >&2; exit 2; }
[ -d "$dir" ] || { echo "amigo-run: no such directory: $dir" >&2; exit 1; }
[ -r "$ENV_FILE" ] || { echo "amigo-run: cannot read $ENV_FILE" >&2; exit 1; }

# systemd-run does not search ~/.bun/bin; resolve a leading "bun".
if [ "$1" = "bun" ]; then shift; set -- "$BUN" "$@"; fi

echo "amigo-run: in $(readlink -f "$dir") as $APP_USER: $*" >&2
exec systemd-run --quiet --pty --wait --collect \
  --uid="$APP_USER" \
  -p EnvironmentFile="$ENV_FILE" \
  -p WorkingDirectory="$(readlink -f "$dir")" \
  -- "$@"
