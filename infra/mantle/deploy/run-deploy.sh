#!/usr/bin/env bash
# Greg Phase 3c — Mantle deploy runbook.
# Usage: ./run-deploy.sh mantle-testnet | mantle-mainnet

set -euo pipefail
NETWORK="${1:?network arg required}"
[[ "$NETWORK" =~ ^mantle-(testnet|mainnet)$ ]] || { echo "ERROR: must be mantle-testnet | mantle-mainnet" >&2; exit 1; }

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/mantle/.env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

OPHIS_MEGAETH_DEPLOYER_PK=$(security find-generic-password -a greg-megaeth-deployer -s greg-megaeth-deployer -w)
export OPHIS_MEGAETH_DEPLOYER_PK OPHIS_MEGAETH_DEPLOYER_ADDRESS

LOG_FILE="$REPO_ROOT/infra/mantle/deploy-log-${NETWORK}-$(date +%Y%m%d-%H%M%S).log"
cd "$REPO_ROOT/contracts"

echo "=== Greg Mantle deploy: $NETWORK ==="
echo "=== Deployer: ${OPHIS_MEGAETH_DEPLOYER_ADDRESS} ==="

HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network "$NETWORK" 2>&1 | tee "$LOG_FILE"
