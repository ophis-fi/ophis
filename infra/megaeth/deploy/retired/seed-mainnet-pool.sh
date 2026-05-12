#!/usr/bin/env bash
# Greg Phase 3 Stage-2 — seed the WETH/USDT0 pool on the Greg-deployed V2.
#
# Pre-reqs:
#  - deploy-mainnet-all.sh has run (V2 Factory + Router deployed, addresses in .env)
#  - The deployer wallet holds WETH + USDT0 (acquire on Kumbaya or bridge in)
#
# Seeds with what's in the deployer wallet, capping at 10 WETH and 10000 USDT0
# (caps prevent accidentally dumping more than intended into the pool).

set -euo pipefail

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/megaeth/.env"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

RPC="$MEGAETH_MAINNET_RPC"
DEPLOYER_PK=$(security find-generic-password -a greg-megaeth-deployer -s greg-megaeth-deployer -w)
DEPLOYER_ADDR=$(cast wallet address "$DEPLOYER_PK")

WETH=0x4200000000000000000000000000000000000006
USDT0=0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb
ROUTER="${GREG_V2_ROUTER_MAINNET:?must be set in .env from deploy-mainnet-all.sh}"

# Read balances
WETH_BAL=$(cast call --rpc-url "$RPC" "$WETH" "balanceOf(address)(uint256)" "$DEPLOYER_ADDR" | awk '{print $1}')
USDT0_BAL=$(cast call --rpc-url "$RPC" "$USDT0" "balanceOf(address)(uint256)" "$DEPLOYER_ADDR" | awk '{print $1}')

echo "Deployer WETH balance:  $WETH_BAL  (1e18 wei = 1 WETH)"
echo "Deployer USDT0 balance: $USDT0_BAL  (1e6   wei = 1 USDT0)"

if [[ "$WETH_BAL" == "0" || "$USDT0_BAL" == "0" ]]; then
  echo "ERROR: deployer wallet must hold WETH AND USDT0 to seed the pool" >&2
  exit 1
fi

# Use 80% of each balance to leave gas/buffer
WETH_AMT=$(python3 -c "print($WETH_BAL * 80 // 100)")
USDT0_AMT=$(python3 -c "print($USDT0_BAL * 80 // 100)")

echo ""
echo "=== Seeding ==="
echo "  WETH:  $WETH_AMT  ($(python3 -c "print($WETH_AMT/1e18)") WETH)"
echo "  USDT0: $USDT0_AMT ($(python3 -c "print($USDT0_AMT/1e6)") USDT0)"

# Approve router for both tokens (max approval)
MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

echo ""
echo "=== Approving router ==="
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --gas-limit 50000000 \
  "$WETH" "approve(address,uint256)" "$ROUTER" "$MAX" >/dev/null
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --gas-limit 50000000 \
  "$USDT0" "approve(address,uint256)" "$ROUTER" "$MAX" >/dev/null
echo "  approved"

# addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, to, deadline)
DEADLINE=$(($(date +%s) + 600))

echo ""
echo "=== Calling router.addLiquidity ==="
TX=$(cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --gas-limit 500000000 \
  "$ROUTER" \
  "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)(uint256,uint256,uint256)" \
  "$WETH" "$USDT0" "$WETH_AMT" "$USDT0_AMT" 0 0 \
  "$DEPLOYER_ADDR" "$DEADLINE" --json | python3 -c "import json,sys; print(json.load(sys.stdin).get('transactionHash'))")

echo "  tx: $TX"

# Read pool address from factory
GREG_V2_PAIR_WETH_USDT0_MAINNET=$(cast call --rpc-url "$RPC" \
  "$GREG_V2_FACTORY_MAINNET" \
  "getPair(address,address)(address)" "$WETH" "$USDT0")

echo ""
echo "=== Pool created ==="
echo "  Pair: $GREG_V2_PAIR_WETH_USDT0_MAINNET"
echo "  reserves: $(cast call --rpc-url "$RPC" "$GREG_V2_PAIR_WETH_USDT0_MAINNET" "getReserves()(uint112,uint112,uint32)")"

cat <<EOF >> "$ENV_FILE"

# Phase 3 Stage-2 pool seed ($(date +%Y-%m-%d))
GREG_V2_PAIR_WETH_USDT0_MAINNET=$GREG_V2_PAIR_WETH_USDT0_MAINNET
EOF
