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

# USER is unset in the same systemd environment, and render-configs.sh expands
# it under `set -u` in its optional Keychain lookup — a path only reached when
# TELEGRAM_BOT_TOKEN is absent from .env, so this VM's mutation test could not
# catch it (its .env carries the token and the block is skipped). The renderer
# now tolerates an unset USER itself; this default is the belt to that braces,
# so the boot path never depends on which copy of the renderer is deployed.
export USER="${USER:-$(id -un)}"

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

# 2. Snapshot every NON-PK render output before touching anything. The renderer
#    has no PK-only mode: it rewrites every configs/*.tmpl output plus
#    observability-rendered/, and prunes orphans. At boot that is a redeploy in
#    disguise — if the checkout or .env drifted since the last deliberate
#    deploy, containers that already restarted on the OLD configs would race
#    later restarts picking up NEW ones. The invariant this unit promises is
#    "recover, don't redeploy", so: snapshot before, render, then restore any
#    non-PK output the render changed (modified, deleted, or newly created).
#    The PK files themselves cannot be preserved — they died with the tmpfs and
#    re-rendering is the only way to get them back; a drifted PK render is
#    flagged by the same warning so it is at least visible.
#    telegram-token in observability-rendered/ is itself a secret: compare with
#    cmp, copy with cp -a, and never print file contents.
SNAP="$(mktemp -d /root/.ophis-boot-snap.XXXXXX)"
trap 'rm -rf "$SNAP"' EXIT
snap_paths() {  # every non-PK render output that exists right now
  local p
  for p in rendered/* observability-rendered/*; do
    [ -e "$p" ] || continue
    case "$(basename "$p")" in driver.toml|okx.toml|enso.toml) continue;; esac
    [ -L "$p" ] && continue   # symlinks are the PK mechanism, never snapshot targets
    printf '%s\n' "$p"
  done
}
snap_paths | while IFS= read -r p; do
  mkdir -p "$SNAP/$(dirname "$p")"
  cp -a "$p" "$SNAP/$p"
done
snap_paths > "$SNAP/.manifest"

# 3. Re-render. This remounts the tmpfs and rewrites the symlink targets.
log "rendering configs (recreates the RAM-disk)"
./render-configs.sh >/dev/null || { log "FATAL: render-configs.sh failed (exit $?)"; exit 4; }

# 4. Restore any non-PK output the render changed, so the boot path cannot
#    deploy config drift. Three cases: modified (restore), deleted/orphan-pruned
#    (restore), newly appeared (remove — a file no running container was
#    deployed with).
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
if [ "$drift" -ne 0 ]; then
  log "WARN: the checkout/.env has drifted since the last deliberate deploy."
  log "      Non-PK services keep their pre-boot configs; the freshly rendered"
  log "      PK files come from the SAME drifted state and could not be pinned."
  log "      Reconcile with a deliberate compose-up.sh deploy soon."
fi

# 5. Prove every PK symlink resolves BEFORE touching containers. Without this the
#    script would "succeed" while docker fails exactly as it did during the
#    incident. -f follows symlinks, so a dangling link fails here.
for f in "${PK_FILES[@]}"; do
  [ -f "rendered/$f" ] || { log "FATAL: rendered/$f does not resolve — refusing to start containers"; exit 5; }
done
log "all ${#PK_FILES[@]} PK configs resolve"

# 6. Start the containers that could not start on their own.
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

# 7. Wait for EVERY restored container to reach its compose healthcheck's
#    "healthy" state — not just the driver. `docker start` returns 0 the moment
#    the process launches, so a solver that starts and then crash-loops leaves
#    rc at zero; and the driver's /healthz checks block freshness, chain id and
#    submitter balance, NOT solver reachability, so it cannot vouch for okx or
#    enso. Each of the three has a healthcheck in docker-compose.yml (the
#    driver's depends_on gates on them with condition: service_healthy), which
#    makes .State.Health.Status the right signal. A container with no
#    healthcheck configured would return "<nil>"; treat that as "running is the
#    best we can know" rather than blocking boot forever.
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

# 8. Log the driver's own /healthz verdict for the boot journal. Its healthcheck
#    already gated step 7, but the body names the failing check (e.g. submitter
#    balance under the per-chain floor) and that is worth having in the log.
h=$(docker run --rm --network "${COMPOSE_PROJECT}_default" curlimages/curl:latest \
      -s --max-time 5 http://driver:80/healthz 2>/dev/null || true)
case "$h" in
  *'"ok":true'*) log "driver healthz ok" ;;
  "")            log "WARN: could not fetch driver /healthz for the boot log" ;;
  *)             log "WARN: driver healthz: $h" ;;
esac
exit $rc
