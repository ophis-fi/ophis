#!/usr/bin/env bash
# Ophis Phase 3 — MegaETH deploy runbook
#
# Usage:
#   ./run-deploy.sh megaeth-testnet
#   ./run-deploy.sh megaeth-mainnet
#
# Pulls the deployer private key from macOS Keychain, sources non-secret
# env (RPC URLs etc) from infra/megaeth/.env, and runs hardhat-deploy
# with the Ophis-specific config that lives inside contracts/.

set -euo pipefail

NETWORK="${1:?network arg required (megaeth-testnet | megaeth-mainnet)}"

if [[ "$NETWORK" != "megaeth-testnet" && "$NETWORK" != "megaeth-mainnet" ]]; then
  echo "ERROR: network must be 'megaeth-testnet' or 'megaeth-mainnet' (got: $NETWORK)" >&2
  exit 1
fi

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/megaeth/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy from .env.example and fill in." >&2
  exit 1
fi

# Source non-secret env (RPC URLs, addresses).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Read deployer PK from Keychain (NEVER persisted to disk).
OPHIS_MEGAETH_DEPLOYER_PK=$(security find-generic-password \
  -a "ophis-megaeth-deployer" -s "ophis-megaeth-deployer" -w)
export OPHIS_MEGAETH_DEPLOYER_PK

# Sourced from .env above; export so the hardhat config sees it for the
# namedAccounts override (owner + manager → Ophis deployer EOA).
export OPHIS_MEGAETH_DEPLOYER_ADDRESS

# Sanity: mainnet RPC must be set if we're hitting mainnet.
if [[ "$NETWORK" == "megaeth-mainnet" && -z "${MEGAETH_MAINNET_RPC:-}" ]]; then
  echo "ERROR: MEGAETH_MAINNET_RPC is empty in $ENV_FILE." >&2
  echo "       Confirm the mainnet RPC URL via chainlist.org/chain/4326 or docs.megaeth.com" >&2
  exit 1
fi

LOG_FILE="$REPO_ROOT/infra/megaeth/deploy-log-${NETWORK}-$(date +%Y%m%d-%H%M%S).log"

cd "$REPO_ROOT/contracts"

echo "=== Ophis MegaETH deploy: $NETWORK ==="
echo "=== Deployer: ${OPHIS_MEGAETH_DEPLOYER_ADDRESS:?must be set in .env} ==="
echo "=== Log file: $LOG_FILE ==="
echo ""

HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network "$NETWORK" 2>&1 | tee "$LOG_FILE"

echo ""
echo "=== capture deployed addresses from the log above and write to:"
echo "      $ENV_FILE"
if [[ "$NETWORK" == "megaeth-testnet" ]]; then
  echo "    fields: OPHIS_AUTH_TESTNET, OPHIS_SETTLEMENT_TESTNET, OPHIS_VAULT_RELAYER_TESTNET"
else
  echo "    fields: OPHIS_AUTH_MAINNET, OPHIS_SETTLEMENT_MAINNET, OPHIS_VAULT_RELAYER_MAINNET"
fi
