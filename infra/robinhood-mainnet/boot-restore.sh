#!/usr/bin/env bash
# Adapted from ../unichain-mainnet/boot-restore.sh. Run as root on Cadia.
# Snapshot non-PK outputs as root (the Telegram token belongs to nobody);
# render as clement so the existing RAM mount and symlink ownership stay valid.
set -euo pipefail
umask 077
case "$-" in *x*) echo "REFUSING to run under set -x: the PK would leak in the trace." >&2; exit 2;; esac

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

export HOME=/home/clement
export USER="${USER:-$(id -un)}"

PK_SERVICES=(driver)
PK_FILES=(driver.toml)
COMPOSE_PROJECT=robinhood-mainnet

log() { echo "[ophis-boot-restore] $*"; }

for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
docker info >/dev/null 2>&1 || { log "FATAL: docker API not responding after 120s"; exit 3; }

SNAP="$(mktemp -d)"
trap 'rm -rf "$SNAP"' EXIT
snap_paths() {  # every non-PK render output that exists right now
  local p
  for p in rendered/* observability-rendered/*; do
    [ -e "$p" ] || continue
    case "$(basename "$p")" in
      driver.toml) continue;;
      *.BAK*|*.OLD*|*.bak*|*.old*|*.tmp*) continue;;
    esac
    [ -L "$p" ] && continue   # symlinks are the PK mechanism, never snapshot targets
    printf '%s\n' "$p"
  done
}
snap_paths | while IFS= read -r p; do
  mkdir -p "$SNAP/$(dirname "$p")"
  cp -a "$p" "$SNAP/$p"
done
snap_paths > "$SNAP/.manifest"

log "rendering configs (recreates the RAM-disk)"
render_rc=0
sudo -n -u clement env HOME="$HOME" USER=clement ./render-configs.sh >/dev/null || render_rc=$?

drift=0
while IFS= read -r p; do
  if [ ! -e "$p" ] || ! cmp -s "$SNAP/$p" "$p"; then
    log "WARN: render changed non-PK output '$p' — RESTORING pre-boot version (boot must not redeploy)"
    mkdir -p "$(dirname "$p")"
    cp -a "$SNAP/$p" "$p"
    drift=1
  fi
done < "$SNAP/.manifest"
snap_paths | while IFS= read -r p; do
  if ! grep -qxF "$p" "$SNAP/.manifest"; then
    log "WARN: render created new non-PK output '$p' — REMOVING (boot must not redeploy)"
    rm -f "$p"
  fi
done
[ "$render_rc" -eq 0 ] || { log "FATAL: render-configs.sh failed (exit $render_rc)"; exit 4; }
if [ "$drift" -ne 0 ]; then
  log "WARN: the checkout/.env has drifted since the last deliberate deploy."
  log "      Non-PK services keep their pre-boot configs; the freshly rendered"
  log "      PK files come from the SAME drifted state and could not be pinned."
  log "      Reconcile with a deliberate compose-up.sh deploy soon."
fi

for f in "${PK_FILES[@]}"; do
  [ -f "rendered/$f" ] || { log "FATAL: rendered/$f does not resolve — refusing to start containers"; exit 5; }
done
log "all ${#PK_FILES[@]} PK configs resolve"

rc=0
for svc in "${PK_SERVICES[@]}"; do
  c="${COMPOSE_PROJECT}-${svc}-1"
  if ! docker inspect "$c" >/dev/null 2>&1; then
    log "WARN: container $c does not exist — skipping (run compose-up.sh for a first bring-up)"
    rc=6
    continue
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$c")" = "true" ]; then
    log "$c already running"
    continue
  fi
  if docker start "$c" >/dev/null 2>&1; then
    log "$c started"
  else
    log "ERROR: failed to start $c"
    rc=7
  fi
done

deadline=$(( $(date +%s) + 180 ))
for svc in "${PK_SERVICES[@]}"; do
  c="${COMPOSE_PROJECT}-${svc}-1"
  docker inspect "$c" >/dev/null 2>&1 || continue   # already WARNed in step 6
  while :; do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo gone)
    case "$h" in
      healthy) log "$c healthy"; break ;;
      none)    [ "$(docker inspect -f '{{.State.Running}}' "$c")" = "true" ] \
                 && log "$c running (no healthcheck configured)" && break ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "ERROR: $c not healthy within 180s (state: $h) — check 'docker logs $c'"
      rc=8
      break
    fi
    sleep 4
  done
done

hp=$(docker inspect -f '{{(index (index .NetworkSettings.Ports "80/tcp") 0).HostPort}}' \
       "${COMPOSE_PROJECT}-driver-1" 2>/dev/null || true)
driver_ok=""
h=""
gate_deadline=$(( $(date +%s) + 60 ))
if [ -z "$hp" ]; then
  log "ERROR: driver container has no published 80/tcp host port — cannot probe /healthz"
else
  while :; do
    h=$(curl -s --max-time 5 "http://127.0.0.1:${hp}/healthz" 2>/dev/null || true)
    case "$h" in *'"ok":true'*) driver_ok=1; log "driver healthz ok"; break;; esac
    now=$(date +%s)
    [ $(( now + 4 )) -ge "$gate_deadline" ] && break
    sleep 4
  done
fi
if [ -z "$driver_ok" ]; then
  case "$h" in
    "") log "ERROR: could not fetch driver /healthz within 60s" ;;
    *)  log "ERROR: driver healthz still failing after 60s: $h" ;;
  esac
  rc=8
fi
exit $rc
