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
echo "==> docker compose up -d --build $*"
docker compose up -d --build "$@"

echo ""
echo "Stack startup initiated. Verify with:"
echo "  docker compose ps"
echo "  docker inspect optimism-mainnet-driver-1 --format '{{.State.Health.Status}}'"
