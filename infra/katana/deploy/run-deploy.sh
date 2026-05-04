#!/usr/bin/env bash
# Greg Phase 3c — Katana deploy runbook.
# Usage: ./run-deploy.sh katana-testnet | katana-mainnet

set -euo pipefail
NETWORK="${1:?network arg required}"
[[ "$NETWORK" =~ ^katana-(testnet|mainnet)$ ]] || { echo "ERROR: must be katana-testnet | katana-mainnet" >&2; exit 1; }

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/katana/.env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

GREG_MEGAETH_DEPLOYER_PK=$(security find-generic-password -a greg-megaeth-deployer -s greg-megaeth-deployer -w)
export GREG_MEGAETH_DEPLOYER_PK GREG_MEGAETH_DEPLOYER_ADDRESS

LOG_FILE="$REPO_ROOT/infra/katana/deploy-log-${NETWORK}-$(date +%Y%m%d-%H%M%S).log"
cd "$REPO_ROOT/contracts"

echo "=== Greg Katana deploy: $NETWORK ==="
echo "=== Deployer: ${GREG_MEGAETH_DEPLOYER_ADDRESS} ==="

HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network "$NETWORK" 2>&1 | tee "$LOG_FILE"
