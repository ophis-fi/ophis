#!/usr/bin/env bash
# Offline validation: no token file, Alertmanager API, or Telegram access.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
amtool() {
  docker run --rm -i --network none --read-only --entrypoint amtool \
    prom/alertmanager:v0.27.0 "$@" < "$HERE/alertmanager.yml.tmpl"
}
amtool check-config --no-version-check /dev/stdin
for case in \
  'OphisOpErpcUpstreamCredentialFailing warning telegram-rpc' \
  'OphisOpErpcConsensusUnhealthy critical telegram-rpc' \
  'OphisOpAutopilotMaintenanceStalled critical telegram-rpc' \
  'OphisOpERPCDown critical telegram-critical' \
  'OphisOpAutopilotDown critical telegram-critical' \
  'OtherWarning warning telegram-warning' \
  'UnclassifiedAlert info telegram-critical'; do
  read -r alert severity receiver <<< "$case"
  amtool config routes test --no-version-check --config.file=/dev/stdin \
    --verify.receivers="$receiver" "alertname=$alert" "severity=$severity" chain=optimism
done
