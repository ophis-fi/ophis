#!/usr/bin/env bash
# Ophis HyperEVM mainnet — safe wrapper for `docker compose up`.
#
# Tier 1.5 PK isolation puts the rendered driver.toml on a RAM-disk that
# vanishes on reboot. After a reboot, `docker compose up` without first
# re-rendering would hit a dangling symlink (sharp-edges HIGH-1, 2026-05-20).
#
# Mirrors infra/optimism-mainnet/compose-up.sh — see that file for full
# rationale on the sequenced-restart pattern. HL differs from OP in:
#   - Observability is always included (no --profile gating); missing
#     TELEGRAM_BOT_TOKEN leaves alertmanager unhealthy but does not
#     cascade-fail the stack (alertmanager has no downstream consumers).
#   - Downstream service set excludes okx-solver (OKX doesn't support HL).
#
# This wrapper:
#   1. Always re-runs render-configs.sh (idempotent; re-mounts RAM-disk if
#      needed, re-writes driver.toml).
#   2. Verifies the resulting `rendered/driver.toml` symlink resolves to a
#      readable file (defense in depth — the post-render assertion in
#      render-configs.sh already catches this, but a wrapper-level check
#      protects against partial render-configs.sh changes).
#   3. Sequenced restart of config-bound services to avoid a recreate-window
#      where downstream queries fall through to the catch-all retry while
#      rpc-proxy is starting fresh with new eRPC config.
#   4. Then runs the docker compose up command.

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
# Sequenced restart of config-mounted services so that downstream
# consumers (driver/orderbook/autopilot/baseline/kyberswap-solver) don't
# query rpc-proxy during its config-reload window. Mirrors OP's pattern
# from PR #148 audit fallout — see infra/optimism-mainnet/compose-up.sh
# for full rationale.
#
# HL downstream set differs from OP:
#   - No okx-solver (OKX doesn't support HyperEVM yet, per .env.example)
#   - Adds baseline + kyberswap-solver
DOWNSTREAM=(driver orderbook autopilot baseline kyberswap-solver)
if docker compose ps --services 2>/dev/null | grep -qF rpc-proxy; then
  echo "==> sequenced restart of config-mounted services to pick up rendered/* changes"
  echo "    (services: rpc-proxy ${DOWNSTREAM[*]})"
  docker compose stop "${DOWNSTREAM[@]}"
  docker compose up -d --no-deps --force-recreate rpc-proxy
  # Wait for rpc-proxy-health (busybox tcp probe) to report healthy.
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    health="$(docker inspect hyperevm-mainnet-rpc-proxy-health-1 \
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
# Codex Cyber HIGH (PR #200 review). Conditional on the rendered config
# existing (observability profile is wired in HL's compose unconditionally,
# so this triggers whenever the wrapper is run with a token set). Skipped
# on first-deploy where the service isn't running yet — the final
# `docker compose up -d --build` below brings it up fresh.
if [[ -f observability-rendered/alertmanager.yml ]] && \
   docker compose ps --services 2>/dev/null | grep -qF alertmanager; then
  echo "==> force-recreating alertmanager to pick up rendered Telegram token"
  docker compose up -d --no-deps --force-recreate alertmanager
fi

echo ""
echo "==> docker compose up -d --build $*"
docker compose up -d --build "$@"

echo ""
echo "Stack startup initiated. Verify with:"
echo "  docker compose ps"
echo "  docker inspect hyperevm-mainnet-driver-1 --format '{{.State.Health.Status}}'"
