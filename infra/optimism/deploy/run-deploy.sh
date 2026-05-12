#!/usr/bin/env bash
# Greg Phase 3c — Optimism deploy runbook.
# Usage: ./run-deploy.sh optimism-sepolia | optimism-mainnet

set -euo pipefail
NETWORK="${1:?network arg required}"
[[ "$NETWORK" =~ ^optimism-(sepolia|mainnet)$ ]] || { echo "ERROR: must be optimism-sepolia | optimism-mainnet" >&2; exit 1; }

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/optimism/.env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

OPHIS_MEGAETH_DEPLOYER_PK=$(security find-generic-password -a ophis-megaeth-deployer -s ophis-megaeth-deployer -w)
export OPHIS_MEGAETH_DEPLOYER_PK OPHIS_MEGAETH_DEPLOYER_ADDRESS

LOG_FILE="$REPO_ROOT/infra/optimism/deploy-log-${NETWORK}-$(date +%Y%m%d-%H%M%S).log"
cd "$REPO_ROOT/contracts"

echo "=== Greg Optimism deploy: $NETWORK ==="
echo "=== Deployer: ${OPHIS_MEGAETH_DEPLOYER_ADDRESS} ==="

HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network "$NETWORK" 2>&1 | tee "$LOG_FILE"
