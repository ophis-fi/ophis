#!/usr/bin/env bash
# Restore OP/Arc RAM files with local authentication, then start existing containers.
set -euo pipefail
case "$-" in *x*) echo 'Refusing shell tracing during key recovery' >&2; exit 2;; esac

MODE="${1:---restore}"
[[ "$MODE" == --login || "$MODE" == --restore ]] || exit 2
OP_DIR="${OPHIS_OP_DEPLOY_DIR:?Set the existing Optimism deployment directory}"
ARC_DIR="${OPHIS_ARC_DEPLOY_DIR:?Set the existing Arc release directory}"
[[ -f "$OP_DIR/render-configs.sh" && -f "$ARC_DIR/mac-key.cjs" ]]

if [[ "$MODE" == --login ]]; then
  /bin/bash "$OP_DIR/scripts/op-boot-start.sh"
  # Colima can report running before its Docker socket accepts connections.
  for _ in {1..60}; do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
fi
docker info >/dev/null 2>&1 || { echo 'Docker is unavailable; no runtime files or containers changed' >&2; exit 1; }

# Verify the fixed inventory before changing services; never create or rebuild.
containers=(optimism-mainnet-rpc-proxy-1 optimism-mainnet-okx-solver-1
  optimism-mainnet-enso-solver-1 optimism-mainnet-curve-solver-1
  optimism-mainnet-woofi-solver-1 optimism-mainnet-alertmanager-1
  optimism-mainnet-driver-1 ophis-arc-driver-1)
docker inspect "${containers[@]}" >/dev/null
missing=no
for file in driver.toml erpc.yaml okx.toml enso.toml curve.toml woofi.toml; do
  [[ -f "$OP_DIR/rendered/$file" ]] || missing=yes
done
[[ -f "$OP_DIR/observability-rendered/telegram-token" ]] || missing=yes
ARC_KEY_FILE="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/solver-key"}}{{.Source}}{{end}}{{end}}' ophis-arc-driver-1)"
[[ -n "$ARC_KEY_FILE" && -f "$ARC_KEY_FILE" ]] || missing=yes
for container in "${containers[@]}"; do
  [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]] || missing=yes
done

if [[ "$MODE" == --login ]]; then
  if [[ "$missing" == no ]]; then
    echo 'OP and Arc runtime files and containers are already available.'
    exit 0
  fi
  # Keep authentication in the operator's terminal; never grant unattended key access.
  exec osascript - "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" "$OP_DIR" "$ARC_DIR" <<'APPLESCRIPT'
on run args
  set commandText to "env " & quoted form of ("OPHIS_OP_DEPLOY_DIR=" & item 2 of args) & " " & quoted form of ("OPHIS_ARC_DEPLOY_DIR=" & item 3 of args) & " /bin/bash " & quoted form of (item 1 of args) & " --restore"
  tell application "Terminal"
    activate
    do script commandText
  end tell
end run
APPLESCRIPT
fi

(cd "$OP_DIR" && ./render-configs.sh)
node "$ARC_DIR/mac-key.cjs" --prepare
/bin/bash "$OP_DIR/render-configs.sh" --check-rendered "$OP_DIR/rendered/erpc.yaml"
for container in "${containers[@]}"; do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == false ]]; then
    docker start "$container"
  fi
done
echo 'OP and Arc runtime files restored; existing containers started. Check driver health and public quotes.'
