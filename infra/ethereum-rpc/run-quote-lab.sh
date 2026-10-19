#!/bin/sh
set -eu

reports=${STATE_DIRECTORY:?systemd must supply STATE_DIRECTORY}
report=$(mktemp "$reports/.run.XXXXXX")
trap 'rm -f "$report"' EXIT HUP INT TERM

docker run --rm --name ophis-quote-lab --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 128m --memory-swap 128m --cpus 0.25 \
  --env ETHEREUM_RPC_URL=http://100.69.134.7:8547 \
  local/ophis-quote-lab:20260921 matrix --matrix /app/config/ethereum-matrix.toml \
  --source ophis-baseline-uniswap-v2 --source ophis-baseline-uniswap-v3 > "$report"

destination="$reports/$(date -u +%Y%m%dT%H%M%SZ).json"
chmod 644 "$report"
mv "$report" "$destination"
find "$reports" -maxdepth 1 -type f -name '*.json' -mtime +30 -delete
printf 'Quote Lab report saved: %s\n' "$destination"
