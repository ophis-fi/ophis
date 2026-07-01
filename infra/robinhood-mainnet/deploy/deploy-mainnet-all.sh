#!/usr/bin/env bash
# Ophis - Robinhood Chain mainnet (chain 4663) sovereign GPv2 bootstrap.
#
# Adapted from infra/unichain-mainnet/deploy/deploy-mainnet-all.sh. Governance
# model = DIRECT-TO-SAFE: AllowListAuthentication ownership + manager are handed
# to the 2-of-3 Ophis protocol Safe at the end of the same Ledger session. The
# OP-style 24h TimelockController + AllowListGuardian is an OPTIONAL later
# hardening (add before meaningful TVL), NOT deployed here.
#
# Hardware-wallet flow:
#   - Ledger at 0xBeC5B03ffDcac50071693E87bFDb88bAa6710199 (OPHIS_HW_WALLET) signs every tx.
#   - Runs from the Mac (contracts repo + Ledger via USB); submits to the Robinhood RPC.
#
# ============================================================================
# *** ARBITRUM ORBIT DELTAS vs the OP-Stack (Unichain) ceremony - READ FIRST ***
# ============================================================================
#  1. GAS MODEL. Robinhood is Arbitrum Nitro: eth_estimateGas bakes in an
#     L1-calldata component and the block gas limit is ~1.1B. So this script does
#     NOT hardcode --gas-limit (the OP script's 15M/2M limits are sized for OP's
#     60M blocks and can be too LOW for a large contract deploy on Arbitrum). We
#     let cast/hardhat estimate. If a deploy still hits out-of-gas, set
#     OPHIS_AUTH_PROXY_GAS_LIMIT (hardhat) and pass --gas-limit explicitly (cast).
#  2. WETH is chain-specific (0x0Bd7D308..cAD73), NOT the OP 0x4200..0006 predeploy.
#     (Not used directly here - EthFlow/native-ETH sells are DEFERRED - but it
#     matters for the frontend + a later EthFlow deploy.)
#  3. BALANCER V2 VAULT is likely NOT deployed on 4663. The Settlement stores the
#     canonical vault address as an immutable but never calls it unless a Balancer
#     interaction runs (baseline/LiFi do not), so the deploy + wiring check still
#     pass. GATE: if you ever add a Balancer-routing solver, confirm the vault has
#     code on 4663 first.
#  4. SAFE hosted service (app.safe.global / tx-service) likely does NOT index
#     4663 yet. The Safe 1.3.0/1.4.1 factories ARE deployed (verified), so create
#     + operate the 2-of-3 Safe via protocol-kit / a CLI, not the hosted UI.
#  5. CREATE2 deployer (0x4e59b448..B4956C) IS present (verified), so deterministic
#     GPv2 addresses work exactly as on Unichain.
# ============================================================================
#
# Steps:
#   1. GPv2 core (Settlement + VaultRelayer + AllowListAuth proxy/impl) via hardhat-deploy + Ledger
#   2. GPv2 helpers (Balances + Signatures + HooksTrampoline) via cast send --create --ledger
#   2.5 GATE: print each contract's EXTCODEHASH + wiring; operator MUST ToB+Codex-verify
#        it matches the audited Ophis fork BEFORE continuing to addSolver.
#   3. Allowlist the Robinhood driver-submitter EOA
#   4. Transfer AuthList ownership + manager to the 2-of-3 Ophis protocol Safe
#
# Pre-conditions:
#   - OPHIS_HW_WALLET 0xBeC5...0199 funded with >= ~0.02 ETH on Robinhood (4663)
#   - The Robinhood submitter EOA (ROBINHOOD_SUBMITTER_ADDR) funded with ~0.02 ETH
#   - infra/robinhood-mainnet/.env exists with OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET
#     and ROBINHOOD_SUBMITTER_ADDR set (a NEW per-chain Tier-1-isolated EOA; its PK
#     lives on the stack host, NEVER here - only the address is needed).
#   - The robinhood-mainnet hardhat network (chainId 4663) exists (added to
#     contracts/hardhat-megaeth.config.ts).
#   - Ledger Live CLOSED, device connected, Ethereum app open.

set -euo pipefail

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/robinhood-mainnet/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found - copy from infra/robinhood-mainnet/.env.example first" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${ROBINHOOD_MAINNET_RPC:-}" ]]; then
  ROBINHOOD_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com
fi
RPC="$ROBINHOOD_MAINNET_RPC"

DEPLOYER_ADDR=0xBeC5B03ffDcac50071693E87bFDb88bAa6710199   # OPHIS_HW_WALLET (Ledger)
# Robinhood per-chain submitter EOA (a NEW EOA, NOT the OP/Unichain submitter).
# Address only; the PK lives 0600 on the stack host (Tier-1), never here.
DRIVER="${ROBINHOOD_SUBMITTER_ADDR:-}"
SAFE="${OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET:-}"

if [[ ! "$DRIVER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: ROBINHOOD_SUBMITTER_ADDR '$DRIVER' is not a 20-byte address - set it in $ENV_FILE" >&2
  echo "       (generate the Robinhood submitter EOA, fund it, store its PK on the stack host)" >&2
  exit 3
fi
if [[ -z "$SAFE" ]]; then
  echo "ERROR: OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET not set in $ENV_FILE" >&2
  echo "       This is the 2-of-3 Safe (deployed on Robinhood via protocol-kit) that takes AllowListAuth ownership." >&2
  exit 3
fi

# Sanity: confirm we are actually talking to chain 4663 before any deploy.
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
if [[ "$CHAIN_ID" != "4663" ]]; then
  echo "ERROR: RPC $RPC reports chainId $CHAIN_ID, expected 4663 (Robinhood)" >&2
  exit 8
fi

# Validate the Safe BEFORE the ceremony: step [4] hands Auth ownership + manager
# to $SAFE irreversibly, and setManager has NO zero-address guard - a typo'd /
# zero / EOA / wrong-chain Safe would permanently brick the AllowListAuthentication.
if [[ ! "$SAFE" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET '$SAFE' is not a 20-byte address" >&2
  exit 3
fi
SAFE_CODE=$(cast code --rpc-url "$RPC" "$SAFE")
if [[ "$SAFE_CODE" == "0x" || -z "$SAFE_CODE" ]]; then
  echo "ERROR: Safe $SAFE has NO code on Robinhood (4663) - deploy the 2-of-3 Safe (protocol-kit) first" >&2
  exit 3
fi
SAFE_THRESHOLD=$(cast call --rpc-url "$RPC" "$SAFE" "getThreshold()(uint256)" 2>/dev/null || echo ERR)
SAFE_OWNERS=$(cast call --rpc-url "$RPC" "$SAFE" "getOwners()(address[])" 2>/dev/null | grep -oE "0x[0-9a-fA-F]{40}")
SAFE_OWNERS_N=$(echo "$SAFE_OWNERS" | grep -c "0x")
echo "=== Safe $SAFE: threshold=$SAFE_THRESHOLD owners=$SAFE_OWNERS_N ==="
echo "    owners:"; echo "$SAFE_OWNERS" | sed 's/^/      /'
if [[ "$SAFE_THRESHOLD" != "2" ]]; then
  echo "ERROR: Safe threshold is '$SAFE_THRESHOLD', expected 2 (2-of-3). Refusing." >&2
  exit 3
fi
if [[ "$SAFE_OWNERS_N" != "3" ]]; then
  echo "ERROR: Safe has $SAFE_OWNERS_N owners, expected 3 (2-of-3). Refusing." >&2
  exit 3
fi
# Hard-assert the owner SET if OPHIS_SAFE_EXPECTED_OWNERS is set (recommended).
if [[ -n "${OPHIS_SAFE_EXPECTED_OWNERS:-}" ]]; then
  EXP_N=$(echo "$OPHIS_SAFE_EXPECTED_OWNERS" | tr ',' ' ' | grep -oE "0x[0-9a-fA-F]{40}" | wc -l | tr -d ' ')
  if [[ "$EXP_N" != "3" ]]; then
    echo "ERROR: OPHIS_SAFE_EXPECTED_OWNERS must list exactly 3 valid 0x[40-hex] addresses (got $EXP_N)" >&2
    exit 3
  fi
  for o in $(echo "$OPHIS_SAFE_EXPECTED_OWNERS" | tr ',' ' '); do
    if ! echo "$SAFE_OWNERS" | tr '[:upper:]' '[:lower:]' | grep -q "$(echo "$o" | tr '[:upper:]' '[:lower:]')"; then
      echo "ERROR: expected owner $o is NOT in the Safe owner set - wrong Safe. Refusing." >&2
      exit 3
    fi
  done
  echo "    OPHIS_SAFE_EXPECTED_OWNERS: all 3 expected owners present (asserted)"
else
  echo "    (set OPHIS_SAFE_EXPECTED_OWNERS in .env to HARD-assert the owner set)"
fi

echo "WARNING: Hardware wallet flow. Make sure:"
echo "    - Ledger Live is CLOSED; device connected via USB; Ethereum app open"
echo "    - ~6 tx prompts incoming (Settlement+Auth deploy, 3 helper deploys, addSolver, 2 ownership txs)"
echo ""
echo "    CONFIRM the Safe owners printed above ARE the intended 2-of-3 protocol signers."
echo "    This Safe will receive IRREVERSIBLE ownership of AllowListAuthentication."
read -r -p "    Type 'yes' to confirm the Safe + proceed: " CONFIRM_SAFE
[[ "$CONFIRM_SAFE" == "yes" ]] || { echo "Aborted (Safe not confirmed)." >&2; exit 9; }

echo ""
echo "=== Deployer (HW wallet): $DEPLOYER_ADDR ==="
echo "=== Robinhood RPC: $RPC (chainId $CHAIN_ID) ==="
BAL_WEI=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR")
echo "=== Deployer balance: $(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether) ETH ==="
SUB_BAL_WEI=$(cast balance --rpc-url "$RPC" "$DRIVER")
echo "=== Submitter ($DRIVER) balance: $(cast balance --rpc-url "$RPC" "$DRIVER" --ether) ETH ==="
echo ""

# Robinhood L2 gas is ~0.02 gwei; the full ceremony costs a fraction of a cent.
# 0.003 ETH is a generous floor that catches an unfunded address before a
# partial-authority state. Fund ~0.02 ETH each for margin.
FLOOR=3000000000000000  # 0.003 ETH
if [[ "$BAL_WEI" -lt "$FLOOR" ]]; then
  echo "ERROR: deployer balance < 0.003 ETH - fund $DEPLOYER_ADDR on Robinhood" >&2
  exit 4
fi
if [[ "$SUB_BAL_WEI" -lt "$FLOOR" ]]; then
  echo "ERROR: submitter balance < 0.003 ETH - fund $DRIVER on Robinhood (needed to submit settlements)" >&2
  exit 4
fi

# --- 1. GPv2 core via hardhat-deploy (Ledger-signed) ---
echo "=== [1/4] Deploying GPv2 Settlement + VaultRelayer + Auth (Ledger) ==="
cd "$REPO_ROOT/contracts"
export ROBINHOOD_MAINNET_RPC

LOG="$REPO_ROOT/infra/robinhood-mainnet/deploy-log-mainnet-$(date +%Y%m%d-%H%M%S).log"
# ORBIT GAS: if the proxy deploy hits out-of-gas, set OPHIS_AUTH_PROXY_GAS_LIMIT
# (read by 001_authenticator.ts) high enough for Arbitrum's ArbGas accounting.
HARDHAT_CONFIG=hardhat-megaeth.config.ts \
HARDHAT_NETWORK=robinhood-mainnet \
  pnpm exec hardhat deploy --network robinhood-mainnet 2>&1 | tee "$LOG"

DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments/robinhood-mainnet"
OPHIS_AUTH=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Proxy.json'))['address'])")
OPHIS_AUTH_IMPL=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Implementation.json'))['address'])")
OPHIS_SETTLEMENT=$(python3 -c "import json; print(json.load(open('$DEPLOYMENTS_DIR/GPv2Settlement.json'))['address'])")
OPHIS_VAULT_RELAYER=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vaultRelayer()(address)")

echo ""
echo "  Auth Proxy:           $OPHIS_AUTH"
echo "  Auth Implementation:  $OPHIS_AUTH_IMPL"
echo "  Settlement:           $OPHIS_SETTLEMENT"
echo "  VaultRelayer:         $OPHIS_VAULT_RELAYER"

# --- 2. GPv2 helpers via cast send --create --ledger ---
echo ""
echo "=== [2/4] Deploying GPv2 helpers (Ledger) ==="
cd "$REPO_ROOT"

deploy_artifact_create() {
  local name="$1" path="$2" extra_args="${3:-}"
  local CODE
  CODE=$(python3 -c "
import json
d=json.load(open('$path'))
bc=d['bytecode']
if isinstance(bc, dict): bc=bc.get('object', bc.get('bytecode'))
if not bc.startswith('0x'): bc='0x'+bc
print(bc + '$extra_args')")
  # ORBIT GAS: NO --gas-limit - let cast estimate via eth_estimateGas, which on
  # Arbitrum already includes the L1-calldata component. A hardcoded OP-sized 15M
  # can be too low for a large deploy here. If estimation ever fails, add an
  # explicit --gas-limit sized from a prior successful estimate.
  local result st
  result=$(cast send --rpc-url "$RPC" --ledger --create "$CODE" --json)
  st=$(echo "$result" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  case "$st" in 0x1|1|true) ;; *) echo "ERROR: $name deploy tx did not succeed (status=$st)" >&2; exit 11 ;; esac
  echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('contractAddress'))"
}

# Governance cast send WITH on-chain success verification (cast send returns a
# receipt even when the tx REVERTS with status 0). No hardcoded --gas-limit (Orbit).
send_checked() {  # $1=description; rest=cast send args (after --ledger)
  local desc="$1"; shift
  local out st
  out=$(cast send --rpc-url "$RPC" --ledger "$@" --json)
  st=$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  case "$st" in 0x1|1|true) ;; *) echo "ERROR: $desc tx did not succeed (status=$st)" >&2; exit 11 ;; esac
}

OPHIS_BALANCES=$(deploy_artifact_create Balances apps/backend/contracts/artifacts/Balances.json)
OPHIS_SIGNATURES=$(deploy_artifact_create Signatures apps/backend/contracts/artifacts/Signatures.json)

# HooksTrampoline takes a Settlement address constructor arg (ABI-encoded, 32-byte padded)
SETTLEMENT_HEX=${OPHIS_SETTLEMENT#0x}
PADDED=$(printf '%0*d' 24 0)$SETTLEMENT_HEX
OPHIS_HOOKS_TRAMPOLINE=$(deploy_artifact_create HooksTrampoline \
    apps/backend/contracts/artifacts/HooksTrampoline.json "$PADDED")

echo "  Balances:        $OPHIS_BALANCES"
echo "  Signatures:      $OPHIS_SIGNATURES"
echo "  HooksTrampoline: $OPHIS_HOOKS_TRAMPOLINE"

# --- 2.5 GATE: deployed-bytecode integrity (MANDATORY before addSolver) ---
codehash() { cast codehash --rpc-url "$RPC" "$1" 2>/dev/null || cast keccak "$(cast code --rpc-url "$RPC" "$1")"; }
lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
echo ""
echo "=== [GATE] Deployed-bytecode integrity (ToB + Codex must confirm) ==="
echo "  (1) EXACT codehash match vs the OP/Unichain deployed equivalents (immutable-free):"
for pair in "AuthImpl:$OPHIS_AUTH_IMPL" "Balances:$OPHIS_BALANCES" "Signatures:$OPHIS_SIGNATURES"; do
  n=${pair%%:*}; a=${pair#*:}
  printf '      %-12s %s  codehash=%s\n' "$n" "$a" "$(codehash "$a")"
done
F2_PINNED=0
for trip in "AuthImpl:$OPHIS_AUTH_IMPL:${OPHIS_EXPECTED_CODEHASH_AUTHIMPL:-}" \
            "Balances:$OPHIS_BALANCES:${OPHIS_EXPECTED_CODEHASH_BALANCES:-}" \
            "Signatures:$OPHIS_SIGNATURES:${OPHIS_EXPECTED_CODEHASH_SIGNATURES:-}"; do
  n=${trip%%:*}; rest=${trip#*:}; a=${rest%%:*}; exp=${rest#*:}
  [[ -z "$exp" ]] && continue
  F2_PINNED=1
  got=$(codehash "$a")
  [[ "$(lc "$exp")" == "$(lc "$got")" ]] || { echo "ERROR: $n codehash $got != pinned $exp - NOT the audited fork" >&2; exit 10; }
  echo "      $n codehash matches pinned expected (machine-asserted)"
done
[[ "$F2_PINNED" == "1" ]] || echo "      (pin OPHIS_EXPECTED_CODEHASH_{AUTHIMPL,BALANCES,SIGNATURES} in .env to machine-assert; else ToB+Codex diff live)"
echo ""
echo "  (2) WIRING getters for immutable-bearing contracts (codehash WILL differ from OP):"
W_AUTH=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "authenticator()(address)")
W_VR=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vaultRelayer()(address)")
W_VAULT=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vault()(address)")
W_HS=$(cast call --rpc-url "$RPC" "$OPHIS_HOOKS_TRAMPOLINE" "settlement()(address)")
echo "      Settlement.authenticator() = $W_AUTH  (must == Auth $OPHIS_AUTH)"
echo "      Settlement.vaultRelayer()  = $W_VR  (must == VaultRelayer $OPHIS_VAULT_RELAYER)"
echo "      Settlement.vault()         = $W_VAULT  (canonical Balancer V2 vault; LIKELY UNDEPLOYED on 4663 - unused by baseline/LiFi)"
echo "      Settlement.domainSeparator = $(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "domainSeparator()(bytes32)")  (chain-4663-specific; record it)"
echo "      HooksTrampoline.settlement = $W_HS  (must == Settlement $OPHIS_SETTLEMENT)"
echo ""
echo "  (3) Proxy points at the verified implementation (EIP-1967 impl slot):"
IMPL_SLOT=$(cast storage --rpc-url "$RPC" "$OPHIS_AUTH" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc 2>/dev/null)
W_IMPL="0x${IMPL_SLOT: -40}"
echo "      Auth impl slot = $IMPL_SLOT  (low 20 bytes must == AuthImpl $OPHIS_AUTH_IMPL)"
echo ""
# Hard-assert the wiring the script CAN check (a mismatch means the deploy is
# broken - refuse before addSolver). ToB+Codex still confirm the (1) codehashes.
BAL_VAULT=0xBA12222222228d8Ba445958a75a0704d566BF2C8
[[ "$(lc "$W_AUTH")" == "$(lc "$OPHIS_AUTH")" ]] || { echo "ERROR: Settlement.authenticator $W_AUTH != Auth $OPHIS_AUTH" >&2; exit 10; }
[[ "$(lc "$W_VR")" == "$(lc "$OPHIS_VAULT_RELAYER")" ]] || { echo "ERROR: Settlement.vaultRelayer $W_VR != VaultRelayer $OPHIS_VAULT_RELAYER" >&2; exit 10; }
[[ "$(lc "$W_VAULT")" == "$(lc "$BAL_VAULT")" ]] || { echo "ERROR: Settlement.vault $W_VAULT != canonical Balancer V2 vault $BAL_VAULT (constructor arg mismatch)" >&2; exit 10; }
[[ "$(lc "$W_HS")" == "$(lc "$OPHIS_SETTLEMENT")" ]] || { echo "ERROR: HooksTrampoline.settlement $W_HS != Settlement $OPHIS_SETTLEMENT" >&2; exit 10; }
[[ "$(lc "$W_IMPL")" == "$(lc "$OPHIS_AUTH_IMPL")" ]] || { echo "ERROR: Auth proxy impl $W_IMPL != AuthImpl $OPHIS_AUTH_IMPL" >&2; exit 10; }
echo "  Wiring auto-asserted OK: authenticator / vaultRelayer / vault / settlement / impl all consistent."
echo ""
echo "  STOP. Run the ToB + Codex gpt-5.5 review against the above NOW. Confirm:"
echo "    - the (1) codehashes are IDENTICAL to the OP/Unichain deployed equivalents, AND"
echo "    - the (2)+(3) wiring is correct."
read -r -p "  Press ENTER ONLY after ToB+Codex confirm bytecode + wiring..."

# --- 3. Allowlist driver-submitter ---
echo ""
echo "=== [3/4] Allowlisting Robinhood driver-submitter $DRIVER (Ledger) ==="
send_checked "addSolver" "$OPHIS_AUTH" "addSolver(address)" "$DRIVER"
IS_SOLVER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "isSolver(address)(bool)" "$DRIVER")
echo "  isSolver(driver): $IS_SOLVER"
if [[ "$IS_SOLVER" != "true" ]]; then
  echo "ERROR: driver-submitter not allowlisted after addSolver - investigate" >&2
  exit 5
fi

# --- 4. Transfer ownership + manager to the Ophis protocol Safe ---
# Order is transferOwnership FIRST so an interrupted state (Safe=owner, HW=manager)
# leaves the Safe with strictly MORE authority than the HW wallet. If you Ctrl-C
# between the two txs, resume with:
#   cast send --rpc-url "$RPC" --ledger "$OPHIS_AUTH" "setManager(address)" "$SAFE"
echo ""
echo "=== [4/4] Transferring AuthList ownership to Ophis protocol Safe (Ledger) ==="
echo "  Safe: $SAFE"
send_checked "transferOwnership" "$OPHIS_AUTH" "transferOwnership(address)" "$SAFE"
echo "  transferOwnership OK"
send_checked "setManager" "$OPHIS_AUTH" "setManager(address)" "$SAFE"
echo "  setManager OK"

NEW_OWNER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "owner()(address)")
NEW_MANAGER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "manager()(address)")
echo ""
echo "  Verified owner:   $NEW_OWNER"
echo "  Verified manager: $NEW_MANAGER"
[[ "$(lc "$NEW_OWNER")" == "$(lc "$SAFE")" ]] || { echo "ERROR: owner is $NEW_OWNER, expected $SAFE" >&2; exit 6; }
[[ "$(lc "$NEW_MANAGER")" == "$(lc "$SAFE")" ]] || { echo "ERROR: manager is $NEW_MANAGER, expected $SAFE" >&2; exit 7; }
echo "  OK Protocol authority fully handed to the 2-of-3 Safe"

# --- Persist all addresses + emit the placeholder fill map ---
echo ""
echo "=== Writing addresses to .env ==="
cat <<EOF >> "$ENV_FILE"

# Robinhood mainnet (chain 4663) sovereign deploy ($(date +%Y-%m-%d))
OPHIS_AUTH_ROBINHOOD=$OPHIS_AUTH
OPHIS_AUTH_IMPLEMENTATION_ROBINHOOD=$OPHIS_AUTH_IMPL
OPHIS_SETTLEMENT_ROBINHOOD=$OPHIS_SETTLEMENT
OPHIS_VAULT_RELAYER_ROBINHOOD=$OPHIS_VAULT_RELAYER
OPHIS_BALANCES_ROBINHOOD=$OPHIS_BALANCES
OPHIS_SIGNATURES_ROBINHOOD=$OPHIS_SIGNATURES
OPHIS_HOOKS_TRAMPOLINE_ROBINHOOD=$OPHIS_HOOKS_TRAMPOLINE
EOF

echo ""
echo "=== Done. Fill these into configs/*.toml.tmpl (render-configs.sh refuses until filled): ==="
echo "  __FILL_AFTER_DEPLOY_SETTLEMENT__      -> $OPHIS_SETTLEMENT"
echo "  __FILL_AFTER_DEPLOY_BALANCES__        -> $OPHIS_BALANCES"
echo "  __FILL_AFTER_DEPLOY_SIGNATURES__      -> $OPHIS_SIGNATURES"
echo "  __FILL_AFTER_DEPLOY_HOOKS__           -> $OPHIS_HOOKS_TRAMPOLINE"
echo "  __FILL_AFTER_DEPLOY_SUBMITTER_EOA__   -> $DRIVER"
echo "  (AllowListAuthentication proxy for monitoring: $OPHIS_AUTH)"
echo ""
echo "Protocol authority: 2-of-3 Safe $SAFE"
echo "Next: fill placeholders -> ./render-configs.sh -> ./compose-up.sh"
echo ""
echo "GOVERNANCE POSTURE: launched DIRECT-TO-SAFE (no 24h Timelock + Guardian)."
echo "Acceptable for Phase-0 (single-lane LiFi, low TVL), but the 2-of-3 Safe can"
echo "instantly addSolver/upgrade. BEFORE meaningful TVL or the public frontend flip:"
echo "deploy the per-chain 24h TimelockController + AllowListGuardian and migrate Auth"
echo "ownership/manager to them (the OP post-launch model)."
