#!/usr/bin/env bash
# Greg Spec 2 — Optimism mainnet bootstrap.
#
# Runs end-to-end once the deployer is funded with mainnet OP ETH:
#   1. CoW core: Settlement + VaultRelayer + AllowListAuth (via hardhat-deploy)
#   2. CoW helpers: Balances + Signatures + HooksTrampoline (via cast send --create)
#   3. Driver-submitter added to allowlist
#
# Liquidity source is Uniswap V3 on Optimism — NOT a Greg-deployed V2 fork.
# No pool seeding is needed (UniV3 pools already exist with deep liquidity).
# That choice is documented in docs/development/specs/2026-05-12-spec-2-optimism-mainnet.md.
#
# Pre-requisites:
#   - macOS Keychain entry `greg-optimism-deployer` exists with the private key
#   - the corresponding EOA holds ≥ 0.05 mainnet OP ETH for gas
#   - infra/optimism/.env exists (committed example: ./.env.example) with at
#     minimum OP_MAINNET_RPC set (defaults to https://mainnet.optimism.io but
#     a paid endpoint is recommended for the deploy run to avoid 429s)
#
# Writes deployed addresses to infra/optimism/.env as OPHIS_*_OP_MAINNET keys.

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

if ! DEPLOYER_PK=$(security find-generic-password -a greg-optimism-deployer -s greg-optimism-deployer -w 2>/dev/null); then
  echo "ERROR: macOS Keychain entry 'greg-optimism-deployer' not found." >&2
  echo "Create one with:" >&2
  echo "  cast wallet new" >&2
  echo "  security add-generic-password -U -a \$USER -s greg-optimism-deployer -w <PRIVATE_KEY>" >&2
  echo "Then fund the corresponding EOA with ≥ 0.05 ETH on Optimism mainnet." >&2
  exit 3
fi
DEPLOYER_ADDR=$(cast wallet address "$DEPLOYER_PK")

echo "=== Deployer: $DEPLOYER_ADDR ==="
echo "=== Mainnet RPC: $RPC ==="
BAL_WEI=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR")
BAL_ETH=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether)
echo "=== Balance: $BAL_ETH ETH ==="
echo ""

if [[ "$BAL_WEI" -lt 50000000000000000 ]]; then  # 0.05 ETH
  echo "ERROR: deployer balance < 0.05 ETH — fund $DEPLOYER_ADDR first" >&2
  exit 4
fi

# --- 1. CoW core via hardhat-deploy ---
echo "=== [1/3] Deploying CoW Settlement + VaultRelayer + Auth ==="
cd "$REPO_ROOT/contracts"

# hardhat-megaeth.config.ts (despite the name) covers all non-CoW chains including OP mainnet.
# It overrides namedAccounts.owner and .manager to OPHIS_MEGAETH_DEPLOYER_ADDRESS — that env var
# name is historical; we export it pointed at the OP deployer here for compatibility.
export OPHIS_MEGAETH_DEPLOYER_PK="$DEPLOYER_PK"
export OPHIS_MEGAETH_DEPLOYER_ADDRESS="$DEPLOYER_ADDR"
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

# --- 2. CoW helpers via cast send --create ---
echo ""
echo "=== [2/3] Deploying CoW helpers ==="
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
echo "=== [3/3] Allowlisting driver-submitter ==="
DRIVER=0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" \
  "$OPHIS_AUTH_OP_MAINNET" "addSolver(address)" "$DRIVER" >/dev/null
IS_SOLVER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH_OP_MAINNET" "isSolver(address)(bool)" "$DRIVER")
echo "  isSolver(driver): $IS_SOLVER"

if [[ "$IS_SOLVER" != "true" ]]; then
  echo "ERROR: driver-submitter not allowlisted after addSolver — investigate before proceeding" >&2
  exit 5
fi

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
echo "  - liquidity: Uniswap V3 on Optimism (factory 0x1F98431c8aD98523631AE4a59f267346ea31F984)"
echo ""
echo "See docs/development/plans/2026-05-12-spec-2-optimism-mainnet.md once it's written."
