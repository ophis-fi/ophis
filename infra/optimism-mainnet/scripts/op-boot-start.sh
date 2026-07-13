#!/usr/bin/env bash
# Boot-start the Optimism-mainnet backend's colima VM.
#
# WHY: the Cloudflare tunnels are launchd-supervised and every container is
# `restart: always`, but NOTHING starts the colima VM on boot -- so after a reboot
# the whole OP backend stays down (tunnel returns 502) until someone runs
# `colima start`. This LaunchAgent closes that gap.
#
# SCOPE: this only starts colima. The `driver`/`okx-solver` containers need their
# RAM-disk key config re-rendered via `./compose-up.sh`, which requires an
# interactive `sudo` to read the isolated submitter key -- it CANNOT run unattended
# here without weakening that isolation (or finishing #441 / Clef). So after boot:
# colima + the no-secret services come back automatically, and the op-healthcheck
# LaunchAgent Telegram-alerts that `compose-up.sh` is still needed for the driver.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG="$HOME/Library/Logs/ophis-op-boot.log"
exec >>"$LOG" 2>&1
echo "==> [$(date '+%Y-%m-%dT%H:%M:%S%z')] op-boot-start invoked"

if colima status >/dev/null 2>&1; then
  echo "==> colima already running; nothing to do"
  exit 0
fi

# Self-heal a brew-unlinked `docker` CLI before starting colima. On 2026-07-13
# this exact boot path failed: a `brew upgrade` had left the `docker` formula
# unlinked (the `opt/` symlink was present but `/opt/homebrew/bin/docker` was
# gone), so `colima start`'s dependency check aborted with "docker not found"
# and the whole OP backend stayed down through the reboot. The unlink hid until
# reboot because `restart:always` containers + the launchd cloudflared tunnels
# don't need the host docker CLI. Relink defensively so a future unlink can't
# wedge the boot path again; `colima start` below still surfaces the real error
# if docker genuinely isn't installed.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> docker CLI not on PATH -- attempting 'brew link --overwrite docker'"
  brew link --overwrite docker && echo "==> relinked docker CLI" \
    || echo "!! brew link docker failed (is it installed? 'brew install docker')"
fi

echo "==> starting colima (default profile)"
colima start || { echo "!! colima start failed"; exit 1; }

# Wait for the docker daemon socket to accept connections (max ~120s) so the
# restart:always containers have a daemon to come up under.
ready=0
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then echo "==> docker daemon ready after ${i} checks"; ready=1; break; fi
  sleep 2
done

# Don't report a clean boot if the daemon never came up: `colima start` can
# return before the socket is usable, and without this the script would fall
# through to the success log + exit 0, so launchd records a healthy one-shot
# boot while the restart:always containers still have no daemon. Exit nonzero
# so the truth is in the launchd status + log. Safe because the LaunchAgent is
# RunAtLoad-only (no KeepAlive), so a nonzero exit won't crash-loop; the
# op-healthcheck LaunchAgent is what actually alerts on the resulting outage.
if [[ "$ready" -ne 1 ]]; then
  echo "!! [$(date '+%Y-%m-%dT%H:%M:%S%z')] docker daemon never became ready after ~120s — boot incomplete (op-healthcheck will alert)"
  exit 1
fi
echo "==> [$(date '+%Y-%m-%dT%H:%M:%S%z')] op-boot-start done (driver still needs ./compose-up.sh — health-check will alert)"
