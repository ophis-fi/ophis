#!/usr/bin/env bash
# Greg Phase 3 Stage-2 mainnet bootstrap
#
# Runs end-to-end once the deployer is funded with mainnet ETH:
#   1. CoW core: Settlement + VaultRelayer + AllowListAuth (via hardhat-deploy)
#   2. CoW helpers: Balances + Signatures + HooksTrampoline (via cast send --create)
#   3. Uniswap V2: Factory + Router02 (pre-built bytecode in v2-artifacts/)
#   4. Driver-submitter added to allowlist
#
# Pool seeding (addLiquidity) is a separate step that requires WETH + USDT0
# to be in the deployer's wallet. Run seed-mainnet-pool.sh after this.

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
export GREG_MEGAETH_DEPLOYER_PK="$DEPLOYER_PK"
export GREG_MEGAETH_DEPLOYER_ADDRESS="$DEPLOYER_ADDR"
export MEGAETH_MAINNET_RPC

LOG="$REPO_ROOT/infra/megaeth/deploy-log-mainnet-$(date +%Y%m%d-%H%M%S).log"
HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network megaeth-mainnet 2>&1 | tee "$LOG"

# Extract addresses from hardhat-deploy artifacts
DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments/megaeth-mainnet"
GREG_AUTH_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Proxy.json'))['address'])")
GREG_AUTH_IMPLEMENTATION_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Implementation.json'))['address'])")
GREG_SETTLEMENT_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2Settlement.json'))['address'])")
GREG_VAULT_RELAYER_MAINNET=$(cast call --rpc-url "$RPC" "$GREG_SETTLEMENT_MAINNET" "vaultRelayer()(address)")

echo ""
echo "  Auth Proxy:           $GREG_AUTH_MAINNET"
echo "  Auth Implementation:  $GREG_AUTH_IMPLEMENTATION_MAINNET"
echo "  Settlement:           $GREG_SETTLEMENT_MAINNET"
echo "  VaultRelayer:         $GREG_VAULT_RELAYER_MAINNET"

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

GREG_BALANCES_MAINNET=$(deploy_artifact_create Balances apps/backend/contracts/artifacts/Balances.json)
GREG_SIGNATURES_MAINNET=$(deploy_artifact_create Signatures apps/backend/contracts/artifacts/Signatures.json)

# HooksTrampoline takes a Settlement address constructor arg
SETTLEMENT_HEX=${GREG_SETTLEMENT_MAINNET#0x}
PADDED=$(printf '%0*d' 24 0)$SETTLEMENT_HEX
GREG_HOOKS_TRAMPOLINE_MAINNET=$(deploy_artifact_create HooksTrampoline \
    apps/backend/contracts/artifacts/HooksTrampoline.json \
    "$PADDED")

echo "  Balances:        $GREG_BALANCES_MAINNET"
echo "  Signatures:      $GREG_SIGNATURES_MAINNET"
echo "  HooksTrampoline: $GREG_HOOKS_TRAMPOLINE_MAINNET"

# --- 3. Uniswap V2 ---
echo ""
echo "=== [3/4] Deploying Uniswap V2 ==="
WETH_MAINNET=0x4200000000000000000000000000000000000006

# Factory takes a feeToSetter constructor arg (32-byte padded address)
DEPLOYER_HEX=${DEPLOYER_ADDR#0x}
DEPLOYER_PADDED=$(printf '%0*d' 24 0)$DEPLOYER_HEX
GREG_V2_FACTORY_MAINNET=$(deploy_artifact_create UniswapV2Factory \
    infra/megaeth/v2-artifacts/UniswapV2Factory.json \
    "$DEPLOYER_PADDED")
echo "  V2 Factory:  $GREG_V2_FACTORY_MAINNET"

# Router02 takes (factory, WETH) constructor args
FACTORY_HEX=${GREG_V2_FACTORY_MAINNET#0x}
FACTORY_PADDED=$(printf '%0*d' 24 0)$FACTORY_HEX
WETH_HEX=${WETH_MAINNET#0x}
WETH_PADDED=$(printf '%0*d' 24 0)$WETH_HEX
GREG_V2_ROUTER_MAINNET=$(deploy_artifact_create UniswapV2Router02 \
    infra/megaeth/v2-artifacts/UniswapV2Router02.json \
    "$FACTORY_PADDED$WETH_PADDED")
echo "  V2 Router:   $GREG_V2_ROUTER_MAINNET"

# --- 4. Allowlist driver-submitter ---
echo ""
echo "=== [4/4] Allowlisting driver-submitter ==="
DRIVER=0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" \
  "$GREG_AUTH_MAINNET" "addSolver(address)" "$DRIVER" \
  --gas-limit 50000000 >/dev/null
echo "  isSolver(driver): $(cast call --rpc-url "$RPC" "$GREG_AUTH_MAINNET" "isSolver(address)(bool)" "$DRIVER")"

# --- Persist all addresses ---
echo ""
echo "=== Writing addresses to .env ==="
cat <<EOF >> "$ENV_FILE"

# Phase 3 Stage-2 mainnet deploy ($(date +%Y-%m-%d))
GREG_AUTH_MAINNET=$GREG_AUTH_MAINNET
GREG_AUTH_IMPLEMENTATION_MAINNET=$GREG_AUTH_IMPLEMENTATION_MAINNET
GREG_SETTLEMENT_MAINNET=$GREG_SETTLEMENT_MAINNET
GREG_VAULT_RELAYER_MAINNET=$GREG_VAULT_RELAYER_MAINNET
GREG_BALANCES_MAINNET=$GREG_BALANCES_MAINNET
GREG_SIGNATURES_MAINNET=$GREG_SIGNATURES_MAINNET
GREG_HOOKS_TRAMPOLINE_MAINNET=$GREG_HOOKS_TRAMPOLINE_MAINNET
GREG_V2_FACTORY_MAINNET=$GREG_V2_FACTORY_MAINNET
GREG_V2_ROUTER_MAINNET=$GREG_V2_ROUTER_MAINNET
EOF

echo ""
echo "=== Done. Next: seed-mainnet-pool.sh after acquiring WETH+USDT0 in deployer wallet."
