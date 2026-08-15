#!/usr/bin/env bash
# Restore the RAM-disk PK configs after a reboot, then start the containers that
# depend on them.
#
# WHY THIS EXISTS (2026-08-14 incident, 23h of stopped solving)
# ------------------------------------------------------------
# rendered/{driver,okx,enso}.toml are SYMLINKS into a tmpfs RAM-disk, on purpose:
# the submitter PK and the API credentials must never touch the SSD. A reboot
# wipes tmpfs, so those three symlinks dangle. Docker resolves a bind-mount source
# at container start, and a dangling symlink is not something it can create, so it
# fails the container with:
#
#   error while creating mount source path '.../rendered/driver.toml':
#   mkdir .../rendered/driver.toml: file exists
#
# That is exit 128, and `restart: always` cannot heal it — the error is
# deterministic, so the container stays dead. Everything else in the stack uses
# plain on-disk 0644 configs and restarts normally, which is what makes this
# failure so quiet: 17 of 20 containers come back healthy, the VM looks fine, and
# only the driver (plus the okx/enso solvers) is gone. On 2026-08-14 the VM
# rebooted at 19:09 UTC and Unichain solving stayed down until it was noticed.
#
# render-configs.sh already documents "After reboot, the RAM-disk is gone" and
# tells a HUMAN to re-run it. Nothing ran it unattended. This unit is that
# missing step.
#
# Deliberately NOT a `compose up`: no build, no pull, no recreate. It re-renders
# and starts the EXISTING containers, so it cannot silently ship new images or a
# drifted config the way a redeploy can (see the 2026-07-22 stale-rebuild
# outage). If a container does not exist yet, this script says so and stops
# rather than inventing one — first-time bring-up stays a human, on-purpose act.
set -euo pipefail
case "$-" in *x*) echo "REFUSING to run under set -x: the PK would leak in the trace." >&2; exit 2;; esac

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# systemd does NOT set HOME for a Type=oneshot service, and render-configs.sh
# derives the RAM-disk path from it under `set -u`:
#   RAM_PK_MOUNT="$HOME/.local/state/ophis/ram-pk"   -> "HOME: unbound variable"
# Every interactive test passes (ssh/login shells export HOME) and only the real
# boot fails, which is the worst possible way to find out. Caught by running the
# unit against a reproduced post-reboot state on 2026-08-15.
#
# The value is not cosmetic: the rendered/*.toml symlinks already point at
# /root/.local/state/ophis/ram-pk, so HOME must resolve to the SAME root the
# symlinks were written against or the render silently populates a different
# directory and the links stay dangling.
export HOME="${HOME:-/root}"
if [ "$HOME" != "/root" ] && [ "$(id -u)" = "0" ]; then
  log_early() { echo "[ophis-boot-restore] $*"; }
  log_early "WARN: running as root with HOME=$HOME; RAM-disk path must match the"
  log_early "      rendered symlink targets (/root/.local/state/ophis/ram-pk)."
fi

PK_SERVICES=(driver okx-solver enso-solver)
PK_FILES=(driver.toml okx.toml enso.toml)
COMPOSE_PROJECT=unichain-mainnet

log() { echo "[ophis-boot-restore] $*"; }

# 1. Wait for dockerd. systemd's After=docker.service only guarantees the unit
#    was started, not that the API answers yet.
for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
docker info >/dev/null 2>&1 || { log "FATAL: docker API not responding after 120s"; exit 3; }

# 2. Re-render. This remounts the tmpfs and rewrites the symlink targets.
log "rendering configs (recreates the RAM-disk)"
./render-configs.sh >/dev/null || { log "FATAL: render-configs.sh failed (exit $?)"; exit 4; }

# 3. Prove every PK symlink resolves BEFORE touching containers. Without this the
#    script would "succeed" while docker fails exactly as it did during the
#    incident. -f follows symlinks, so a dangling link fails here.
for f in "${PK_FILES[@]}"; do
  [ -f "rendered/$f" ] || { log "FATAL: rendered/$f does not resolve — refusing to start containers"; exit 5; }
done
log "all ${#PK_FILES[@]} PK configs resolve"

# 4. Start the containers that could not start on their own.
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

# 5. Report the driver's own verdict. A started container is not a working one:
#    the driver reports ok:false while its submitter balance is under the
#    per-chain floor, and that is worth seeing in the boot log.
for _ in $(seq 1 30); do
  h=$(docker exec "${COMPOSE_PROJECT}-driver-1" true 2>/dev/null && \
      docker run --rm --network "${COMPOSE_PROJECT}_default" curlimages/curl:latest \
        -s --max-time 5 http://driver:80/healthz 2>/dev/null || true)
  case "$h" in *'"ok":true'*) log "driver healthz ok"; exit $rc;; esac
  sleep 4
done
log "WARN: driver did not report healthy within 120s — check 'docker logs ${COMPOSE_PROJECT}-driver-1'"
[ "$rc" -eq 0 ] && rc=8
exit $rc
