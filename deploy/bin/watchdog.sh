#!/bin/sh
# /opt/amigo/bin/watchdog.sh <slot> — run every 10 s by amigo-watchdog@.timer.
# Restarts amigo@<slot> after 3 consecutive failed /api/healthz probes
# (~30 s). healthz only fails when the event loop is blocked for > 2 s or
# the process does not answer at all; it never checks DB/Redis.
set -u
slot="${1:?usage: watchdog.sh <slot>}"
case "$slot" in [1-9]) ;; *) echo "watchdog: bad slot '$slot'" >&2; exit 2 ;; esac
f="/run/amigo/wd-${slot}"
mkdir -p /run/amigo
# Starting, draining or stopped: not our business, and a stale counter
# must not carry over into the next run of the slot.
if ! systemctl is-active --quiet "amigo@${slot}"; then
  rm -f "$f"
  exit 0
fi
if curl -fsS --max-time 3 "http://127.0.0.1:510${slot}/api/healthz" >/dev/null 2>&1; then
  echo 0 > "$f"
  exit 0
fi
n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$f"
if [ "$n" -ge 3 ]; then
  echo 0 > "$f"
  logger -t amigo-watchdog "healthz failed ${n}x, restarting amigo@${slot}"
  systemctl restart "amigo@${slot}"
fi
exit 0
