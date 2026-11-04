#!/usr/bin/env bash
set -euo pipefail
umask 077

base=${1:?Pass the private operator installation directory}
[[ "$base" = /* && -f "$base/compose.env" ]]
compose=(docker compose --env-file "$base/compose.env" -f "$base/current/compose.yml")
# Local status only: no treasury access or external notification credentials.
if [[ $# = 1 ]]; then
  exec "${compose[@]}" exec -T broadcaster node dist/main.mjs monitor
fi
metrics=${2:?Pass the existing node-exporter textfile path}
[[ "$metrics" = /*.prom && ! -L "$metrics" && -d "${metrics%/*}" ]]
exec 9>"$base/monitor.lock"
flock -n 9 || exit 0
temporary=$(mktemp "${metrics%/*}/.ophis-broadcaster.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
status=0
timeout 45s "${compose[@]}" exec -T broadcaster node dist/main.mjs monitor --prometheus >"$temporary" || status=$?
if [[ ( "$status" = 0 || "$status" = 2 ) && -s "$temporary" ]]; then
  chmod 0644 "$temporary"
  mv -- "$temporary" "$metrics"
fi
exit "$status"
