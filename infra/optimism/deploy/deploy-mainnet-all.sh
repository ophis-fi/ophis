#!/usr/bin/env bash
# Ophis — Optimism mainnet bootstrap (Spec 2).
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
# Liquidity source is Uniswap V3 on Optimism — NOT an Ophis-deployed V2 fork.
# UniV3 pools already exist with deep liquidity (canonical 0.05% WETH/USDC.e).
#
# Pre-conditions:
#   - HW wallet at 0xBeC5…0199 is funded with ≥ 0.05 OP ETH
#   - Driver EOA 0x00f9…502F is funded with ≥ 0.05 OP ETH
#   - infra/optimism/.env exists with OPHIS_PROTOCOL_SAFE_OP_MAINNET set
#   - Ledger Live is CLOSED (USB device contention with hardhat-ledger plugin)
#   - Ledger is connected via USB and Ethereum app is open
#   - OP_MAINNET_RPC points at a reliable endpoint (recommend the self-hosted
#     op-reth via Tailscale once the new VM is up)
#
# Rationale documented in
# docs/development/specs/2026-05-12-spec-2-optimism-mainnet.md.

set -euo pipefail

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/optimism/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found — copy from infra/optimism/.env.example first" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${OP_MAINNET_RPC:-}" ]]; then
  OP_MAINNET_RPC=https://mainnet.optimism.io
fi
RPC="$OP_MAINNET_RPC"

DEPLOYER_ADDR=0xBeC5B03ffDcac50071693E87bFDb88bAa6710199
DRIVER=0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F
SAFE="${OPHIS_PROTOCOL_SAFE_OP_MAINNET:-}"

if [[ -z "$SAFE" ]]; then
  echo "ERROR: OPHIS_PROTOCOL_SAFE_OP_MAINNET not set in $ENV_FILE" >&2
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

if [[ "$BAL_WEI" -lt 50000000000000000 ]]; then  # 0.05 ETH
  echo "ERROR: deployer balance < 0.05 ETH — fund $DEPLOYER_ADDR first" >&2
  exit 4
fi

# --- 1. CoW core via hardhat-deploy (Ledger-signed) ---
echo "=== [1/4] Deploying CoW Settlement + VaultRelayer + Auth (Ledger) ==="
cd "$REPO_ROOT/contracts"
export OP_MAINNET_RPC

LOG="$REPO_ROOT/infra/optimism/deploy-log-mainnet-$(date +%Y%m%d-%H%M%S).log"
HARDHAT_CONFIG=hardhat-megaeth.config.ts \
  pnpm exec hardhat deploy --network optimism-mainnet 2>&1 | tee "$LOG"

DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments/optimism-mainnet"
OPHIS_AUTH_OP_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Proxy.json'))['address'])")
OPHIS_AUTH_IMPLEMENTATION_OP_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Implementation.json'))['address'])")
OPHIS_SETTLEMENT_OP_MAINNET=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2Settlement.json'))['address'])")
OPHIS_VAULT_RELAYER_OP_MAINNET=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT_OP_MAINNET" "vaultRelayer()(address)")

echo ""
echo "  Auth Proxy:           $OPHIS_AUTH_OP_MAINNET"
echo "  Auth Implementation:  $OPHIS_AUTH_IMPLEMENTATION_OP_MAINNET"
echo "  Settlement:           $OPHIS_SETTLEMENT_OP_MAINNET"
echo "  VaultRelayer:         $OPHIS_VAULT_RELAYER_OP_MAINNET"

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
           --create "$CODE" --json)
  echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('contractAddress'))"
}

OPHIS_BALANCES_OP_MAINNET=$(deploy_artifact_create Balances apps/backend/contracts/artifacts/Balances.json)
OPHIS_SIGNATURES_OP_MAINNET=$(deploy_artifact_create Signatures apps/backend/contracts/artifacts/Signatures.json)

SETTLEMENT_HEX=${OPHIS_SETTLEMENT_OP_MAINNET#0x}
PADDED=$(printf '%0*d' 24 0)$SETTLEMENT_HEX
OPHIS_HOOKS_TRAMPOLINE_OP_MAINNET=$(deploy_artifact_create HooksTrampoline \
    apps/backend/contracts/artifacts/HooksTrampoline.json \
    "$PADDED")

echo "  Balances:        $OPHIS_BALANCES_OP_MAINNET"
echo "  Signatures:      $OPHIS_SIGNATURES_OP_MAINNET"
echo "  HooksTrampoline: $OPHIS_HOOKS_TRAMPOLINE_OP_MAINNET"

# --- 3. Allowlist driver-submitter ---
echo ""
echo "=== [3/4] Allowlisting driver-submitter (Ledger) ==="
cast send --rpc-url "$RPC" --ledger \
  "$OPHIS_AUTH_OP_MAINNET" "addSolver(address)" "$DRIVER" >/dev/null
IS_SOLVER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH_OP_MAINNET" "isSolver(address)(bool)" "$DRIVER")
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
# RECOVERY: this is a non-stuck state. After Ctrl-C, the operator runs:
#   cast send --rpc-url "$RPC" --ledger \
#     "$OPHIS_AUTH_OP_MAINNET" "setManager(address)" "$SAFE"
# manually. Once that lands the Safe controls everything. Order is
# transferOwnership FIRST then setManager so an interrupted state leaves
# the Safe with strictly MORE authority than the HW wallet — a stolen HW
# wallet at this intermediate state could only addSolver (bounded blast
# radius); the Safe can immediately removeSolver + setManager(Safe) to
# recover.
echo ""
echo "=== [4/4] Transferring AuthList ownership to Ophis protocol Safe (Ledger) ==="
echo "  Safe: $SAFE"
echo "  ⚠️  If you Ctrl-C between the two txs below, the AuthList is left in"
echo "      a partial state (Safe=owner, Ledger=manager). Resume manually:"
echo "      cast send --rpc-url \"\$RPC\" --ledger \"\$OPHIS_AUTH_OP_MAINNET\" \"setManager(address)\" \"\$SAFE\""

cast send --rpc-url "$RPC" --ledger \
  "$OPHIS_AUTH_OP_MAINNET" "transferOwnership(address)" "$SAFE" >/dev/null
echo "  transferOwnership ✓"

cast send --rpc-url "$RPC" --ledger \
  "$OPHIS_AUTH_OP_MAINNET" "setManager(address)" "$SAFE" >/dev/null
echo "  setManager ✓"

NEW_OWNER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH_OP_MAINNET" "owner()(address)")
NEW_MANAGER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH_OP_MAINNET" "manager()(address)")
echo ""
echo "  Verified — owner:   $NEW_OWNER"
echo "  Verified — manager: $NEW_MANAGER"

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

# Spec 2 Optimism mainnet deploy ($(date +%Y-%m-%d))
OPHIS_AUTH_OP_MAINNET=$OPHIS_AUTH_OP_MAINNET
OPHIS_AUTH_IMPLEMENTATION_OP_MAINNET=$OPHIS_AUTH_IMPLEMENTATION_OP_MAINNET
OPHIS_SETTLEMENT_OP_MAINNET=$OPHIS_SETTLEMENT_OP_MAINNET
OPHIS_VAULT_RELAYER_OP_MAINNET=$OPHIS_VAULT_RELAYER_OP_MAINNET
OPHIS_BALANCES_OP_MAINNET=$OPHIS_BALANCES_OP_MAINNET
OPHIS_SIGNATURES_OP_MAINNET=$OPHIS_SIGNATURES_OP_MAINNET
OPHIS_HOOKS_TRAMPOLINE_OP_MAINNET=$OPHIS_HOOKS_TRAMPOLINE_OP_MAINNET
EOF

echo ""
echo "=== Done. ==="
echo ""
echo "Next: build infra/optimism-mainnet/ chain stack pointing at:"
echo "  - settlement: $OPHIS_SETTLEMENT_OP_MAINNET"
echo "  - liquidity:  Uniswap V3 on Optimism (factory 0x1F98431c8aD98523631AE4a59f267346ea31F984)"
echo "  - RPC:        the self-hosted op-reth via Tailscale once the new VM is up"
echo ""
echo "Protocol authority: 2-of-3 Safe $SAFE"
