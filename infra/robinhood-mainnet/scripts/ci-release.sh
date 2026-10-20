#!/usr/bin/env bash
# Called only by the protected main-branch workflow; inspection never mutates the host.
set -euo pipefail

operation=${1:?operation required}
revision=${2:?revision required}
case "$operation" in inspect|deploy) ;; *) exit 2 ;; esac
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2

# Discover the live stack from Docker rather than assuming a checkout location.
orderbook=$(docker ps --filter publish=8410 --format '{{.ID}}')
[[ "$orderbook" =~ ^[0-9a-f]{12,64}$ ]] || { echo 'Expected exactly one live port 8410 orderbook' >&2; exit 1; }
stack=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$orderbook")
[[ "$stack" == /*/infra/robinhood-mainnet ]] || { echo 'Unexpected live stack location' >&2; exit 1; }
root=$(git -C "$stack" rev-parse --show-toplevel)
[[ "$(realpath "$stack")" == "$root/infra/robinhood-mainnet" ]] || exit 1
docker_root=$(docker info --format '{{.DockerRootDir}}')

printf 'Host: %s; operator: %s; stack: %s\n' "$(hostname)" "$(id -un)" "$stack"
printf 'Current source: %s\n' "$(git -C "$root" rev-parse HEAD)"
df -h "$stack" "$docker_root"
docker compose version --short
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
if sudo -n tailscale debug prefs 2>/dev/null | python3 -c 'import json,sys; p=json.load(sys.stdin); print("Tailscale enabled:",p.get("WantRunning")); print("SSH enabled:",p.get("RunSSH"))'; then
  :
else
  echo 'Tailscale prefs unavailable to this operator'
fi
[[ "$operation" == deploy ]] || exit 0

available=$(df -Pk "$docker_root" | awk 'NR == 2 {print $4}')
[[ "$available" =~ ^[0-9]+$ && "$available" -ge 31457280 ]] || { echo 'Need at least 30 GiB free for backend build; no automatic cleanup' >&2; exit 1; }
git -C "$root" diff-index --quiet HEAD -- || { echo 'Tracked operator changes require review' >&2; exit 1; }
[[ -z "$(git -C "$root" status --porcelain --untracked-files=all -- apps/backend infra)" ]] || { echo 'Backend/infra operator changes require review' >&2; exit 1; }
git -C "$root" fetch --no-tags https://github.com/ophis-fi/ophis.git main
git -C "$root" merge-base --is-ancestor "$revision" FETCH_HEAD
git -C "$root" merge-base --is-ancestor HEAD "$revision"
git -C "$root" merge --ff-only "$revision"
[[ "$(git -C "$root" rev-parse HEAD)" == "$revision" ]] || exit 1

cd "$stack"
./compose-up.sh </dev/null
export OPHIS_GIT_SHA="$revision"
release_ready() {
  local container state service
  [[ "$(curl --fail --silent --max-time 3 http://127.0.0.1:8410/api/v1/version 2>/dev/null)" == "$revision" ]] || return 1
  for service in orderbook driver autopilot metric-solver elfomo-solver; do
    container=$(docker compose ps -q "$service") || return 1
    [[ "$container" =~ ^[0-9a-f]{12,64}$ ]] || return 1
    state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container") || return 1
    if [[ "$service" == autopilot ]]; then
      [[ "$state" == 'running ' ]] || return 1
    else
      [[ "$state" == 'running healthy' ]] || return 1
    fi
  done
}
ready=false
for attempt in {1..60}; do
  if release_ready; then ready=true; break; fi
  sleep 3
done
"$ready" || { echo 'Backend version/health did not become ready after 60 attempts' >&2; exit 1; }
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8410/api/v1/info/contracts | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["chainId"] == 4663; print("Verified Robinhood chain 4663")'
printf 'Verified backend revision: %s after %s readiness checks\n' "$revision" "$attempt"
