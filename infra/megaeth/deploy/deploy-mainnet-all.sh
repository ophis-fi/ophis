#!/usr/bin/env bash
# Greg Phase 4 Spec 3 — MegaETH mainnet bootstrap.
#
# Runs end-to-end once the deployer is funded with mainnet MEGA:
#   1. CoW core: Settlement + VaultRelayer + AllowListAuth (via hardhat-deploy)
#   2. CoW helpers: Balances + Signatures + HooksTrampoline (via cast send --create)
#   3. Driver-submitter added to allowlist
#
# Liquidity source is Kumbaya (MegaETH's dominant UniV3-fork DEX,
# factory 0x68b34591…988a09, custom pool init code hash). NOT a
# Greg-deployed V2. No bootstrap pool seeding is needed; Kumbaya
# already has ~$53M TVL.
#
# Rationale documented in
# docs/development/specs/2026-05-12-spec-3-megaeth-mainnet.md.

set -euo pipefail

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/megaeth/.env"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${MEGAETH_MAINNET_RPC:-}" ]]; then
  MEGAETH_MAINNET_RPC=https://mainnet.megaeth.com/rpc
fi
RPC="$MEGAETH_MAINNET_RPC"

DEPLOYER_PK=$(security find-generic-password -a greg-megaeth-deployer -s greg-megaeth-deployer -w)
DEPLOYER_ADDR=$(cast wallet address "$DEPLOYER_PK")

echo "=== Deployer: $DEPLOYER_ADDR ==="
echo "=== Mainnet RPC: $RPC ==="
echo "=== Balance: $(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether) ETH ==="
echo ""

# --- 1. CoW core via hardhat-deploy ---
echo "=== [1/4] Deploying CoW Settlement + VaultRelayer + Auth ==="
cd "$REPO_ROOT/contracts"
export OPHIS_MEGAETH_DEPLOYER_PK="$DEPLOYER_PK"
export OPHIS_MEGAETH_DEPLOYER_ADDRESS="$DEPLOYER_ADDR"
export MEGAETH_MAINNET_RPC

LOG="$REPO_ROOT/infra/megaeth/deploy-log-mainnet-$(date +%Y%m%d-%H%M%S).log"
HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network megaeth-mainnet 2>&1 | tee "$LOG"

# Extract addresses from hardhat-deploy artifacts
DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments/megaeth-mainnet"
OPHIS_AUTH_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Proxy.json'))['address'])")
OPHIS_AUTH_IMPLEMENTATION_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Implementation.json'))['address'])")
OPHIS_SETTLEMENT_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2Settlement.json'))['address'])")
OPHIS_VAULT_RELAYER_MAINNET=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT_MAINNET" "vaultRelayer()(address)")

echo ""
echo "  Auth Proxy:           $OPHIS_AUTH_MAINNET"
echo "  Auth Implementation:  $OPHIS_AUTH_IMPLEMENTATION_MAINNET"
echo "  Settlement:           $OPHIS_SETTLEMENT_MAINNET"
echo "  VaultRelayer:         $OPHIS_VAULT_RELAYER_MAINNET"

# --- 2. CoW helpers via cast send --create ---
echo ""
echo "=== [2/4] Deploying CoW helpers ==="
cd "$REPO_ROOT"

deploy_artifact_create() {
  local name="$1" path="$2" extra_args="${3:-}"
  CODE=$(python3 -c "
import json
d=json.load(open('$path'))
bc=d['bytecode']
if isinstance(bc, dict): bc=bc.get('object', bc.get('bytecode'))
if not bc.startswith('0x'): bc='0x'+bc
print(bc + '$extra_args')")
  result=$(cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" \
           --gas-limit 500000000 --create "$CODE" --json)
  echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('contractAddress'))"
}

OPHIS_BALANCES_MAINNET=$(deploy_artifact_create Balances apps/backend/contracts/artifacts/Balances.json)
OPHIS_SIGNATURES_MAINNET=$(deploy_artifact_create Signatures apps/backend/contracts/artifacts/Signatures.json)

# HooksTrampoline takes a Settlement address constructor arg
SETTLEMENT_HEX=${OPHIS_SETTLEMENT_MAINNET#0x}
PADDED=$(printf '%0*d' 24 0)$SETTLEMENT_HEX
OPHIS_HOOKS_TRAMPOLINE_MAINNET=$(deploy_artifact_create HooksTrampoline \
    apps/backend/contracts/artifacts/HooksTrampoline.json \
    "$PADDED")

echo "  Balances:        $OPHIS_BALANCES_MAINNET"
echo "  Signatures:      $OPHIS_SIGNATURES_MAINNET"
echo "  HooksTrampoline: $OPHIS_HOOKS_TRAMPOLINE_MAINNET"

# --- 3. Allowlist driver-submitter ---
echo ""
echo "=== [3/3] Allowlisting driver-submitter ==="
DRIVER=0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" \
  "$OPHIS_AUTH_MAINNET" "addSolver(address)" "$DRIVER" \
  --gas-limit 50000000 >/dev/null
echo "  isSolver(driver): $(cast call --rpc-url "$RPC" "$OPHIS_AUTH_MAINNET" "isSolver(address)(bool)" "$DRIVER")"

# --- Persist all addresses ---
echo ""
echo "=== Writing addresses to .env ==="
cat <<EOF >> "$ENV_FILE"

# Spec 3 MegaETH mainnet deploy ($(date +%Y-%m-%d))
OPHIS_AUTH_MAINNET=$OPHIS_AUTH_MAINNET
OPHIS_AUTH_IMPLEMENTATION_MAINNET=$OPHIS_AUTH_IMPLEMENTATION_MAINNET
OPHIS_SETTLEMENT_MAINNET=$OPHIS_SETTLEMENT_MAINNET
OPHIS_VAULT_RELAYER_MAINNET=$OPHIS_VAULT_RELAYER_MAINNET
OPHIS_BALANCES_MAINNET=$OPHIS_BALANCES_MAINNET
OPHIS_SIGNATURES_MAINNET=$OPHIS_SIGNATURES_MAINNET
OPHIS_HOOKS_TRAMPOLINE_MAINNET=$OPHIS_HOOKS_TRAMPOLINE_MAINNET
EOF

echo ""
echo "=== Done. ==="
echo ""
echo "Liquidity source on this chain is Kumbaya UniV3 fork at"
echo "  factory   0x68b34591f662508076927803c567Cc8006988a09"
echo "  poolHash  0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7"
echo "Configure the chain stack's driver.toml with these in [[liquidity.uniswap-v3]]."
