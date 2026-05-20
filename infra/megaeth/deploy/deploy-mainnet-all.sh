#!/usr/bin/env bash
# Ophis — MegaETH mainnet bootstrap (Spec 3).
#
# Hardware-wallet flow (Spec 5):
#   - Ledger at 0xBeC5B03ffDcac50071693E87bFDb88bAa6710199 signs every tx
#   - Ownership of AllowListAuthentication is auto-transferred to the
#     Ophis protocol Safe at 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF
#     within the same Ledger session (~30s window)
#
# Steps:
#   1. CoW core (Settlement + VaultRelayer + AllowListAuth) via hardhat-deploy
#      using @nomicfoundation/hardhat-ledger
#   2. CoW helpers (Balances + Signatures + HooksTrampoline) via cast send --ledger
#   3. Allowlist driver-submitter
#   4. Transfer AuthList ownership + manager to Ophis protocol Safe
#
# Liquidity source is Kumbaya (MegaETH's dominant UniV3-fork DEX). No
# bootstrap pool seeding — Kumbaya has ~$53M TVL already.
#
# Pre-conditions:
#   - HW wallet at 0xBeC5…0199 is funded with ≥ 0.001 ETH on mainnet
#   - Driver EOA 0x92B9…1A1B1 is funded with ≥ 0.001 ETH
#   - infra/megaeth/.env exists with OPHIS_PROTOCOL_SAFE_MEGAETH_MAINNET set
#   - Ledger Live is CLOSED (USB device contention with hardhat-ledger plugin)
#   - Ledger is connected via USB and Ethereum app is open
#
# Rationale documented in
# docs/development/specs/2026-05-12-spec-3-megaeth-mainnet.md.

set -euo pipefail

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/megaeth/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found — copy from infra/megaeth/.env.example first" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${MEGAETH_MAINNET_RPC:-}" ]]; then
  MEGAETH_MAINNET_RPC=https://mainnet.megaeth.com/rpc
fi
RPC="$MEGAETH_MAINNET_RPC"

DEPLOYER_ADDR=0xBeC5B03ffDcac50071693E87bFDb88bAa6710199
DRIVER=0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1
SAFE="${OPHIS_PROTOCOL_SAFE_MEGAETH_MAINNET:-}"

if [[ -z "$SAFE" ]]; then
  echo "ERROR: OPHIS_PROTOCOL_SAFE_MEGAETH_MAINNET not set in $ENV_FILE" >&2
  echo "       This is the 2-of-3 Safe that takes AllowListAuth ownership post-deploy." >&2
  exit 3
fi

echo "⚠️  Hardware wallet flow. Make sure:"
echo "    - Ledger Live is CLOSED"
echo "    - Ledger device is connected via USB"
echo "    - Ethereum app is open on the device"
echo "    - ~6 tx prompts incoming (3 deploys + 1 allowlist + 2 ownership transfers)"
read -p "Press ENTER when ready..."

echo ""
echo "=== Deployer (HW wallet): $DEPLOYER_ADDR ==="
echo "=== Mainnet RPC: $RPC ==="
BAL_WEI=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR")
BAL_ETH=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether)
echo "=== Balance: $BAL_ETH ETH ==="
echo ""

if [[ "$BAL_WEI" -lt 1000000000000000 ]]; then  # 0.001 ETH
  echo "ERROR: deployer balance < 0.001 ETH — fund $DEPLOYER_ADDR first" >&2
  exit 4
fi

# --- 1. CoW core via hardhat-deploy (Ledger-signed) ---
echo "=== [1/4] Deploying CoW Settlement + VaultRelayer + Auth (Ledger) ==="
cd "$REPO_ROOT/contracts"
export MEGAETH_MAINNET_RPC

LOG="$REPO_ROOT/infra/megaeth/deploy-log-mainnet-$(date +%Y%m%d-%H%M%S).log"
# HARDHAT_NETWORK env var must be set explicitly — hardhat's CLI --network
# flag doesn't propagate to process.env, so the chain-aware gasLimit logic
# in contracts/src/deploy/001_authenticator.ts couldn't see we're on megaeth
# and fell through to a 25M default that OOG'd. Setting it here makes the
# 100M MegaETH path light up correctly.
HARDHAT_CONFIG=hardhat-megaeth.config.ts \
HARDHAT_NETWORK=megaeth-mainnet \
OPHIS_AUTH_PROXY_GAS_LIMIT=150000000 \
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

# --- 2. CoW helpers via cast send --create --ledger ---
echo ""
echo "=== [2/4] Deploying CoW helpers (Ledger) ==="
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
  result=$(cast send --rpc-url "$RPC" --ledger \
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
echo "=== [3/4] Allowlisting driver-submitter (Ledger) ==="
cast send --rpc-url "$RPC" --ledger \
  "$OPHIS_AUTH_MAINNET" "addSolver(address)" "$DRIVER" \
  --gas-limit 50000000 >/dev/null
IS_SOLVER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH_MAINNET" "isSolver(address)(bool)" "$DRIVER")
echo "  isSolver(driver): $IS_SOLVER"

if [[ "$IS_SOLVER" != "true" ]]; then
  echo "ERROR: driver-submitter not allowlisted after addSolver — investigate before proceeding" >&2
  exit 5
fi

# --- 4. Transfer ownership + manager to the Ophis protocol Safe ---
# CRITICAL: this closes the dangerous window where the HW wallet still has
# unilateral protocol-level power. After these two txs, only the 2-of-3
# Safe can addSolver / removeSolver / transferOwnership / upgrade.
#
# Interrupt safety: if the operator Ctrl-C's between transferOwnership and
# setManager (or either tx fails on chain), the AuthList enters a partially-
# migrated state where the Safe owns it but the HW wallet retains manager
# (can still addSolver/removeSolver). Codex's 2026-05-13 second-opinion
# review flagged this as not-fail-closed.
#
# RECOVERY: non-stuck state. After Ctrl-C, the operator runs:
#   cast send --rpc-url "$RPC" --ledger \
#     "$OPHIS_AUTH_MAINNET" "setManager(address)" "$SAFE" --gas-limit 50000000
# manually. Order is transferOwnership FIRST so an interrupted state leaves
# the Safe with strictly MORE authority than the HW wallet — a stolen HW
# wallet at this intermediate state could only addSolver (bounded blast
# radius); the Safe can immediately removeSolver + setManager(Safe) to
# recover.
echo ""
echo "=== [4/4] Transferring AuthList ownership to Ophis protocol Safe (Ledger) ==="
echo "  Safe: $SAFE"
echo "  ⚠️  If you Ctrl-C between the two txs below, the AuthList is left in"
echo "      a partial state (Safe=owner, Ledger=manager). Resume manually:"
echo "      cast send --rpc-url \"\$RPC\" --ledger \"\$OPHIS_AUTH_MAINNET\" \"setManager(address)\" \"\$SAFE\" --gas-limit 50000000"

cast send --rpc-url "$RPC" --ledger \
  "$OPHIS_AUTH_MAINNET" "transferOwnership(address)" "$SAFE" \
  --gas-limit 50000000 >/dev/null
echo "  transferOwnership ✓"

cast send --rpc-url "$RPC" --ledger \
  "$OPHIS_AUTH_MAINNET" "setManager(address)" "$SAFE" \
  --gas-limit 50000000 >/dev/null
echo "  setManager ✓"

NEW_OWNER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH_MAINNET" "owner()(address)")
NEW_MANAGER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH_MAINNET" "manager()(address)")
echo ""
echo "  Verified — owner:   $NEW_OWNER"
echo "  Verified — manager: $NEW_MANAGER"

# Lowercase compare (Solidity returns mixed-case)
LOWER_SAFE=$(echo "$SAFE" | tr '[:upper:]' '[:lower:]')
LOWER_OWNER=$(echo "$NEW_OWNER" | tr '[:upper:]' '[:lower:]')
LOWER_MANAGER=$(echo "$NEW_MANAGER" | tr '[:upper:]' '[:lower:]')
if [[ "$LOWER_OWNER" != "$LOWER_SAFE" ]]; then
  echo "ERROR: owner is $NEW_OWNER, expected $SAFE" >&2
  exit 6
fi
if [[ "$LOWER_MANAGER" != "$LOWER_SAFE" ]]; then
  echo "ERROR: manager is $NEW_MANAGER, expected $SAFE" >&2
  exit 7
fi
echo "  ✓ Protocol authority fully handed to the 2-of-3 Safe"

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
echo "Liquidity source: Kumbaya UniV3 fork"
echo "  factory   0x68b34591f662508076927803c567Cc8006988a09"
echo "  poolHash  0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7"
echo "Configure the chain stack's driver.toml with these in [[liquidity.uniswap-v3]]."
echo ""
echo "Protocol authority: 2-of-3 Safe $SAFE"
