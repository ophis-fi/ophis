#!/usr/bin/env bash
# Ophis OP mainnet — safe wrapper for `docker compose up`.
#
# Tier 1.5 PK isolation puts the rendered driver.toml on a RAM-disk that
# vanishes on reboot. After a reboot, `docker compose up` without first
# re-rendering would hit a dangling symlink (sharp-edges HIGH-1, 2026-05-20).
#
# This wrapper:
#   1. Always re-runs render-configs.sh (idempotent; re-mounts RAM-disk if
#      needed, re-writes driver.toml).
#   2. Verifies the resulting `rendered/driver.toml` symlink resolves to a
#      readable file (defense in depth — the post-render assertion in
#      render-configs.sh already catches this, but a wrapper-level check
#      protects against partial render-configs.sh changes).
#   3. Then runs the docker compose up command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> render-configs.sh"
./render-configs.sh

echo ""
echo "==> verifying driver.toml symlink resolves"
if [[ ! -L rendered/driver.toml ]]; then
  echo "ERROR: rendered/driver.toml is not a symlink. Tier 1.5 expects it to" >&2
  echo "       point at the RAM-disk. Has render-configs.sh been edited?" >&2
  exit 8
fi
target=$(readlink rendered/driver.toml)
if [[ ! -s "$target" ]]; then
  echo "ERROR: rendered/driver.toml -> $target, but the target is empty/missing." >&2
  echo "       The RAM-disk may have been unmounted between render and verify." >&2
  exit 9
fi
echo "  ok: rendered/driver.toml -> $target ($(wc -c < "$target" | tr -d ' ') bytes)"

echo ""
# Sharp-edges HIGH-2 (2026-05-20): the observability profile (prometheus +
# alertmanager) is only enabled when TELEGRAM_BOT_TOKEN is set + a rendered
# alertmanager.yml exists. Profile gating means a missing token doesn't
# cascade-restart-loop the alerting containers.
PROFILES_ARG=""
if [[ -f observability-rendered/alertmanager.yml ]]; then
  echo "==> enabling observability profile (rendered alertmanager.yml found)"
  PROFILES_ARG="--profile observability"
else
  echo "==> observability profile DISABLED (no rendered alertmanager.yml — set TELEGRAM_BOT_TOKEN to enable)"
fi

echo ""
# Force-recreate config-mounted services BEFORE running `up`. Docker
# Compose's change-detection only looks at the image+env+volume-spec
# tuple; if the CONTENT of a bind-mounted file changes (e.g.
# render-configs.sh rewrote rendered/erpc.yaml after an eRPC config
# bump), Compose treats the service as already-up-to-date and leaves
# the container running with the STALE config. Without this step, a
# `compose-up.sh` after an eRPC change silently fails to apply.
#
# 2026-05-20 incident: PR #148 dropped 1rpc-op + bumped to 2-of-2, but
# the subsequent compose-up.sh left rpc-proxy on the OLD 3-of-3 config
# → orderbook bootstrap failed → autopilot wouldn't start. Force-
# recreating these services unconditionally is cheap (~2s each) and
# eliminates the footgun.
#
# driver also reads rendered/driver.toml (symlinked to RAM-disk), but
# its image gets rebuilt on every `--build` so a fresh container always
# spawns. Listed here for completeness in case `--build` ever gets
# stripped from the invocation.
CONFIG_BOUND_SERVICES=(rpc-proxy driver orderbook autopilot okx-solver)
if docker compose ps --services 2>/dev/null | grep -qF rpc-proxy; then
  echo "==> sequenced restart of config-mounted services to pick up rendered/* changes"
  echo "    (services: ${CONFIG_BOUND_SERVICES[*]})"
  # 2026-05-20 audit follow-up: the prior shape was
  #   `docker compose up -d --no-deps --force-recreate ${ALL_SERVICES[@]}`
  # which restarts every service in PARALLEL. Window of ~2-5s where
  # rpc-proxy is starting fresh with NEW eRPC config while driver/
  # orderbook/autopilot are still up and querying it. New consensus
  # rules (stricter agreementThreshold, tighter disputeThreshold)
  # cause in-flight `eth_call`s during the recreate window to fall
  # through to the catch-all retry — exactly the trust-model invariant
  # the strict-consensus block is supposed to enforce.
  #
  # Fix: stop the downstream consumers first, force-recreate rpc-proxy,
  # wait for healthcheck, then start the consumers. Adds ~10s to deploy
  # but preserves "driver always operates against 2-of-3 consensus"
  # across deploy windows.
  #
  # Trailing `|| true` removed: if a service fails to stop/start, we
  # want compose-up.sh to exit non-zero so operator sees the failure
  # before declaring deploy complete.
  DOWNSTREAM=(driver orderbook autopilot okx-solver)
  docker compose stop "${DOWNSTREAM[@]}"
  docker compose up -d --no-deps --force-recreate rpc-proxy
  # Wait for rpc-proxy-health (busybox tcp probe) to report healthy.
  # docker-compose's depends_on: service_healthy will gate downstream
  # starts on this automatically once they come up, but we wait here
  # explicitly so the log message ordering reflects reality.
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    health="$(docker inspect optimism-mainnet-rpc-proxy-health-1 \
      --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
    if [[ "$health" == "healthy" ]]; then break; fi
    sleep 1
  done
  echo "    rpc-proxy-health: $health"
  docker compose up -d --no-deps "${DOWNSTREAM[@]}"
fi

echo ""
echo "==> docker compose $PROFILES_ARG up -d --build $*"
docker compose $PROFILES_ARG up -d --build "$@"

echo ""
echo "Stack startup initiated. Verify with:"
echo "  docker compose ps"
echo "  docker inspect optimism-mainnet-driver-1 --format '{{.State.Health.Status}}'"
