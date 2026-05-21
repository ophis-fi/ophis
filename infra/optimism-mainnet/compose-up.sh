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

# Defense-in-depth: enforce OP_RPC_INTERNAL bypass-ACK BEFORE rendering.
# render-configs.sh has the same check at render time, but operators can
# edit .env between renders (e.g. for ad-hoc debug) and then run
# `docker compose up` directly — which reads OP_RPC_INTERNAL from .env
# via docker-compose.yml's `${OP_RPC_INTERNAL:-...}` defaults and silently
# downgrades the stack to single-provider posture. Checking here on every
# stack-up (whether via this wrapper or via direct `docker compose up`
# that happens to source `.env`) catches the after-render edit. A6
# whole-repo audit L3 (2026-05-21).
if [[ -f .env ]]; then
  # Subshell so `source .env` doesn't pollute compose-up.sh's environment.
  # `set -euo pipefail` at the top propagates the subshell's `exit 12` to
  # this script (verified locally; bash semantics).
  # shellcheck disable=SC1091
  (
    source .env
    if [[ -n "${OP_RPC_INTERNAL:-}" ]] && [[ "${ALLOW_RPC_BYPASS:-}" != "1" ]]; then
      echo "" >&2
      echo "*** REFUSING: OP_RPC_INTERNAL is set in .env ***" >&2
      echo "    This BYPASSES the eRPC 3-of-3 consensus path and downgrades" >&2
      echo "    the stack to single-provider posture. compose-up.sh blocks" >&2
      echo "    this independently of render-configs.sh so an after-render" >&2
      echo "    edit of .env doesn't slip through." >&2
      echo "" >&2
      echo "    If this is intentional (failure-domain test / emergency):" >&2
      echo "      ALLOW_RPC_BYPASS=1 ./compose-up.sh" >&2
      echo "" >&2
      echo "    Otherwise: remove the OP_RPC_INTERNAL line from .env." >&2
      exit 12
    fi
  )
fi

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

# Alertmanager's bot_token_file is read ONCE at process start (not lazily
# per-notification). After a token rotation lands a new value at the RAM-
# disk symlink target, the running container still holds the old token
# in memory. Force-recreate it so the new token takes effect.
#
# Sharp-edges audit HIGH-1 (2026-05-21 whole-repo pass): same finding
# already closed on the HL stack via PR #200's Codex Cyber HIGH; the OP
# stack had been missing the symmetric fix. Conditional on the rendered
# config existing AND the service being up (skipped on first-deploy
# where the service isn't running yet — the final
# `docker compose up -d --build` below brings it up fresh).
if [[ -f observability-rendered/alertmanager.yml ]] && \
   docker compose ps --services 2>/dev/null | grep -qF alertmanager; then
  echo "==> force-recreating alertmanager to pick up rendered Telegram token"
  # `--profile observability` is technically redundant on compose v2.20+
  # (auto-activates profiles when a service is named explicitly), but
  # explicit-is-better-than-implicit and keeps the line portable if
  # someone ever downgrades. Sharp-edges PR #203 review MED-2.
  docker compose --profile observability up -d --no-deps --force-recreate alertmanager
fi

echo ""
echo "==> docker compose $PROFILES_ARG up -d --build $*"
docker compose $PROFILES_ARG up -d --build "$@"

echo ""
echo "Stack startup initiated. Verify with:"
echo "  docker compose ps"
echo "  docker inspect optimism-mainnet-driver-1 --format '{{.State.Health.Status}}'"
