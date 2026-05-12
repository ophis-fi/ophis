#!/usr/bin/env bash
# Greg Phase 3b — HyperEVM (Hyperliquid) deploy runbook.
#
# Usage:
#   ./run-deploy.sh hyperevm-testnet
#   ./run-deploy.sh hyperevm-mainnet
#
# Pre-req: deployer EOA must already be opted into HyperEVM big-block mode
# (run infra/hyperevm/opt-in-big-blocks.py first; the Settlement deploy
# exceeds the 3M small-block gas limit).

set -euo pipefail

NETWORK="${1:?network arg required (hyperevm-testnet | hyperevm-mainnet)}"

if [[ "$NETWORK" != "hyperevm-testnet" && "$NETWORK" != "hyperevm-mainnet" ]]; then
  echo "ERROR: network must be 'hyperevm-testnet' or 'hyperevm-mainnet' (got: $NETWORK)" >&2
  exit 1
fi

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/hyperevm/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

OPHIS_MEGAETH_DEPLOYER_PK=$(security find-generic-password \
  -a "greg-megaeth-deployer" -s "greg-megaeth-deployer" -w)
export OPHIS_MEGAETH_DEPLOYER_PK OPHIS_MEGAETH_DEPLOYER_ADDRESS

LOG_FILE="$REPO_ROOT/infra/hyperevm/deploy-log-${NETWORK}-$(date +%Y%m%d-%H%M%S).log"

cd "$REPO_ROOT/contracts"

echo "=== Greg HyperEVM deploy: $NETWORK ==="
echo "=== Deployer: ${OPHIS_MEGAETH_DEPLOYER_ADDRESS:?must be set in .env} ==="
echo ""

HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network "$NETWORK" 2>&1 | tee "$LOG_FILE"

echo ""
echo "=== Capture deployed addresses from the log + write to:"
echo "      $ENV_FILE"
if [[ "$NETWORK" == "hyperevm-testnet" ]]; then
  echo "    fields: OPHIS_AUTH_HYPEREVM_TESTNET, OPHIS_SETTLEMENT_HYPEREVM_TESTNET, OPHIS_VAULT_RELAYER_HYPEREVM_TESTNET"
else
  echo "    fields: OPHIS_*_HYPEREVM_MAINNET"
fi
