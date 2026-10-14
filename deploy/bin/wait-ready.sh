#!/bin/sh
# /opt/amigo/bin/wait-ready.sh <slot> — ExecStartPost of amigo@.service.
# Succeeds as soon as http://127.0.0.1:510<slot>/api/readyz answers 2xx
# (the process passed its boot guard, its deps answer and both listeners are
# bound). Fails after ~50-150 s; TimeoutStartSec=60 in the unit cuts it first.
set -u
slot="${1:?usage: wait-ready.sh <slot>}"
case "$slot" in [1-9]) ;; *) echo "wait-ready: bad slot '$slot'" >&2; exit 2 ;; esac
i=0
while [ "$i" -lt 100 ]; do
  curl -fsS --max-time 1 "http://127.0.0.1:510${slot}/api/readyz" >/dev/null 2>&1 && exit 0
  i=$((i + 1))
  sleep 0.5
done
echo "amigo@${slot} not ready" >&2
exit 1
