#!/usr/bin/env bash
# Ophis — Unichain mainnet (chain 130) sovereign GPv2 bootstrap.
#
# Adapted from infra/megaeth/deploy/deploy-mainnet-all.sh (the rehearsed Ophis
# sovereign deploy). Governance model = DIRECT-TO-SAFE (the MegaETH model):
# AllowListAuthentication ownership + manager are handed to the 2-of-3 Ophis
# protocol Safe at the end of the same Ledger session. The OP-style 24h
# TimelockController + AllowListGuardian is an OPTIONAL later hardening (OP added
# it post-launch via a separate migration), NOT deployed here.
#
# Hardware-wallet flow:
#   - Ledger at 0xBeC5B03ffDcac50071693E87bFDb88bAa6710199 (OPHIS_HW_WALLET) signs every tx.
#   - Runs from the Mac (contracts repo + Ledger via USB); submits to the Unichain RPC.
#
# Unichain is a standard OP-Stack L2: 60M block gas, ~0.0005 gwei base fee. So the
# gas limits here are NORMAL (not MegaETH's inflated 150M/500M, which would exceed
# Unichain's 60M block cap). The unknown-chain 25M auth-proxy default in
# 001_authenticator.ts is sufficient — no OPHIS_AUTH_PROXY_GAS_LIMIT override.
#
# Steps:
#   1. GPv2 core (Settlement + VaultRelayer + AllowListAuth proxy/impl) via hardhat-deploy + Ledger
#   2. GPv2 helpers (Balances + Signatures + HooksTrampoline) via cast send --create --ledger
#   2.5 GATE: print each contract's EXTCODEHASH; operator MUST ToB+Codex-verify it
#        matches the audited Ophis fork BEFORE continuing to addSolver.
#   3. Allowlist the Unichain driver-submitter EOA
#   4. Transfer AuthList ownership + manager to the 2-of-3 Ophis protocol Safe
#
# EthFlow (native-ETH sells) is DEFERRED (D5): not deployed here. Native-ETH
# volume is not indexed/rebated until the settle() decoder is enabled; add EthFlow
# in a follow-up once that ships. The frontend OPHIS_ETHFLOW_OVERRIDES[130] stays
# at the zero sentinel until then.
#
# Pre-conditions:
#   - OPHIS_HW_WALLET 0xBeC5...0199 funded with >= ~0.02 ETH on Unichain (130)
#   - The Unichain submitter EOA (DRIVER below) funded with ~0.02 ETH on 130
#   - infra/unichain-mainnet/.env exists with OPHIS_PROTOCOL_SAFE_UNICHAIN_MAINNET set
#     (a 2-of-3 Safe deployed on Unichain)
#   - Ledger Live CLOSED (USB contention with hardhat-ledger), device connected,
#     Ethereum app open
#   - The hardhat config has the unichain-mainnet network (chainId 130) — added.

set -euo pipefail

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/unichain-mainnet/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found — copy from infra/unichain-mainnet/.env.example first" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${UNICHAIN_MAINNET_RPC:-}" ]]; then
  UNICHAIN_MAINNET_RPC=https://mainnet.unichain.org
fi
RPC="$UNICHAIN_MAINNET_RPC"

DEPLOYER_ADDR=0xBeC5B03ffDcac50071693E87bFDb88bAa6710199
# Unichain per-chain submitter EOA (WS10) — NOT the OP submitter 0x92B9...1A1B1.
# Generated 2026-06-26; PK lives 0600 on the Unichain stack host, never here.
DRIVER=0x7A956C269a12f1B897367663b536EB5dd29f3fBb
SAFE="${OPHIS_PROTOCOL_SAFE_UNICHAIN_MAINNET:-}"

if [[ -z "$SAFE" ]]; then
  echo "ERROR: OPHIS_PROTOCOL_SAFE_UNICHAIN_MAINNET not set in $ENV_FILE" >&2
  echo "       This is the 2-of-3 Safe (deployed on Unichain) that takes AllowListAuth ownership." >&2
  exit 3
fi

# Sanity: confirm we are actually talking to chain 130 before any deploy.
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
if [[ "$CHAIN_ID" != "130" ]]; then
  echo "ERROR: RPC $RPC reports chainId $CHAIN_ID, expected 130 (Unichain)" >&2
  exit 8
fi

# Validate the Safe BEFORE the ceremony (Codex HIGH): step [4] hands Auth
# ownership + manager to $SAFE irreversibly, and setManager has NO zero-address
# guard — a typo'd / zero / EOA / wrong-chain Safe would permanently brick the
# AllowListAuthentication. Require a real 2-of-3 Gnosis Safe with code on 130.
if [[ ! "$SAFE" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: OPHIS_PROTOCOL_SAFE_UNICHAIN_MAINNET '$SAFE' is not a 20-byte address" >&2
  exit 3
fi
SAFE_CODE=$(cast code --rpc-url "$RPC" "$SAFE")
if [[ "$SAFE_CODE" == "0x" || -z "$SAFE_CODE" ]]; then
  echo "ERROR: Safe $SAFE has NO code on Unichain (130) — deploy the 2-of-3 Safe on 130 first" >&2
  exit 3
fi
SAFE_THRESHOLD=$(cast call --rpc-url "$RPC" "$SAFE" "getThreshold()(uint256)" 2>/dev/null || echo ERR)
SAFE_OWNERS=$(cast call --rpc-url "$RPC" "$SAFE" "getOwners()(address[])" 2>/dev/null | grep -oE "0x[0-9a-fA-F]{40}")
SAFE_OWNERS_N=$(echo "$SAFE_OWNERS" | grep -c "0x")
echo "=== Safe $SAFE: threshold=$SAFE_THRESHOLD owners=$SAFE_OWNERS_N ==="
echo "    owners:"; echo "$SAFE_OWNERS" | sed 's/^/      /'
if [[ "$SAFE_THRESHOLD" != "2" ]]; then
  echo "ERROR: Safe threshold is '$SAFE_THRESHOLD', expected 2 (2-of-3). Not a valid Ophis protocol Safe — refusing." >&2
  exit 3
fi
if [[ "$SAFE_OWNERS_N" != "3" ]]; then
  echo "ERROR: Safe has $SAFE_OWNERS_N owners, expected 3 (2-of-3). Refusing." >&2
  exit 3
fi
# Hard-assert the owner SET (Codex HIGH): a wrong-but-valid 2-of-3 Safe would
# otherwise pass and receive irreversible authority. Set OPHIS_SAFE_EXPECTED_OWNERS
# in .env to the 3 owner addresses (comma/space-separated); every one must be
# present. If unset, the operator MUST visually confirm the printed owners at the
# prompt below.
if [[ -n "${OPHIS_SAFE_EXPECTED_OWNERS:-}" ]]; then
  EXP_N=$(echo "$OPHIS_SAFE_EXPECTED_OWNERS" | tr ',' ' ' | grep -oE "0x[0-9a-fA-F]{40}" | wc -l | tr -d ' ')
  if [[ "$EXP_N" != "3" ]]; then
    echo "ERROR: OPHIS_SAFE_EXPECTED_OWNERS must list exactly 3 valid 0x[40-hex] addresses (got $EXP_N well-formed)" >&2
    exit 3
  fi
  for o in $(echo "$OPHIS_SAFE_EXPECTED_OWNERS" | tr ',' ' '); do
    if ! echo "$SAFE_OWNERS" | tr '[:upper:]' '[:lower:]' | grep -q "$(echo "$o" | tr '[:upper:]' '[:lower:]')"; then
      echo "ERROR: expected owner $o is NOT in the Safe owner set — wrong Safe. Refusing." >&2
      exit 3
    fi
  done
  echo "    OPHIS_SAFE_EXPECTED_OWNERS: all 3 expected owners present (asserted)"
else
  echo "    (set OPHIS_SAFE_EXPECTED_OWNERS in .env to HARD-assert the owner set)"
fi

echo "WARNING: Hardware wallet flow. Make sure:"
echo "    - Ledger Live is CLOSED"
echo "    - Ledger device is connected via USB"
echo "    - Ethereum app is open on the device"
echo "    - ~6 tx prompts incoming (Settlement+Auth deploy, 3 helper deploys, addSolver, 2 ownership txs)"
echo ""
echo "    CONFIRM the Safe owners printed above ARE the intended 2-of-3 protocol signers."
echo "    This Safe will receive IRREVERSIBLE ownership of AllowListAuthentication."
read -r -p "    Type 'yes' to confirm the Safe + proceed: " CONFIRM_SAFE
[[ "$CONFIRM_SAFE" == "yes" ]] || { echo "Aborted (Safe not confirmed)." >&2; exit 9; }

echo ""
echo "=== Deployer (HW wallet): $DEPLOYER_ADDR ==="
echo "=== Unichain RPC: $RPC (chainId $CHAIN_ID) ==="
BAL_WEI=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR")
BAL_ETH=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether)
echo "=== Deployer balance: $BAL_ETH ETH ==="
SUB_BAL_WEI=$(cast balance --rpc-url "$RPC" "$DRIVER")
SUB_BAL_ETH=$(cast balance --rpc-url "$RPC" "$DRIVER" --ether)
echo "=== Submitter ($DRIVER) balance: $SUB_BAL_ETH ETH ==="
echo ""

# Floors (Codex MEDIUM): enforce BOTH, not just the deployer. Unichain L2 gas is
# ~free (~0.0005 gwei base fee) so the actual ceremony cost is tiny; 0.01 ETH is a
# generous safety floor that catches an unfunded address before a partial-authority
# state. Recommend funding ~0.02 ETH each for margin.
FLOOR=3000000000000000  # 0.003 ETH (Unichain gas ~0.0005 gwei; full ceremony costs ~0.0001 ETH)
if [[ "$BAL_WEI" -lt "$FLOOR" ]]; then
  echo "ERROR: deployer balance < 0.003 ETH — fund $DEPLOYER_ADDR on Unichain" >&2
  exit 4
fi
if [[ "$SUB_BAL_WEI" -lt "$FLOOR" ]]; then
  echo "ERROR: submitter balance < 0.003 ETH — fund $DRIVER on Unichain (needed to submit settlements post-launch)" >&2
  exit 4
fi

# --- 1. GPv2 core via hardhat-deploy (Ledger-signed) ---
echo "=== [1/4] Deploying GPv2 Settlement + VaultRelayer + Auth (Ledger) ==="
cd "$REPO_ROOT/contracts"
export UNICHAIN_MAINNET_RPC

LOG="$REPO_ROOT/infra/unichain-mainnet/deploy-log-mainnet-$(date +%Y%m%d-%H%M%S).log"
# HARDHAT_NETWORK must be set explicitly — the --network flag doesn't propagate to
# process.env, which the chain-aware gas logic in 001_authenticator.ts reads.
HARDHAT_CONFIG=hardhat-megaeth.config.ts \
HARDHAT_NETWORK=unichain-mainnet \
  pnpm exec hardhat deploy --network unichain-mainnet 2>&1 | tee "$LOG"

# Extract addresses from hardhat-deploy artifacts
DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments/unichain-mainnet"
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
  # 15M gas-limit: well above the ~1-5M actual deploy cost, well under Unichain's
  # 60M block gas limit.
  local result st
  result=$(cast send --rpc-url "$RPC" --ledger \
           --gas-limit 15000000 --create "$CODE" --json)
  st=$(echo "$result" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  case "$st" in 0x1|1|true) ;; *) echo "ERROR: $name deploy tx did not succeed on-chain (status=$st)" >&2; exit 11 ;; esac
  echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('contractAddress'))"
}

# Wrap governance cast send with on-chain success verification (ToB F5): cast send
# returns a receipt even when the tx REVERTS (status 0); without this, a silently
# failed addSolver/transferOwnership/setManager would be masked and the ceremony
# would proceed past it (e.g. leaving the Ledger as latent owner+manager).
send_checked() {  # $1=description; rest=cast send args (after --ledger)
  local desc="$1"; shift
  local out st
  out=$(cast send --rpc-url "$RPC" --ledger "$@" --json)
  st=$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  case "$st" in 0x1|1|true) ;; *) echo "ERROR: $desc tx did not succeed on-chain (status=$st)" >&2; exit 11 ;; esac
}

OPHIS_BALANCES=$(deploy_artifact_create Balances apps/backend/contracts/artifacts/Balances.json)
OPHIS_SIGNATURES=$(deploy_artifact_create Signatures apps/backend/contracts/artifacts/Signatures.json)

# HooksTrampoline takes a Settlement address constructor arg (ABI-encoded, 32-byte padded)
SETTLEMENT_HEX=${OPHIS_SETTLEMENT#0x}
PADDED=$(printf '%0*d' 24 0)$SETTLEMENT_HEX
OPHIS_HOOKS_TRAMPOLINE=$(deploy_artifact_create HooksTrampoline \
    apps/backend/contracts/artifacts/HooksTrampoline.json \
    "$PADDED")

echo "  Balances:        $OPHIS_BALANCES"
echo "  Signatures:      $OPHIS_SIGNATURES"
echo "  HooksTrampoline: $OPHIS_HOOKS_TRAMPOLINE"

# --- 2.5 GATE: deployed-bytecode integrity (MANDATORY before addSolver) ---
# PHASE-0 scope: ToB + Codex must verify the deployed contracts are the audited
# Ophis fork before the chain gets any solver authority. The money-path gate.
#
# Codex HIGH correction: do NOT codehash-compare immutable-bearing contracts.
# Settlement / VaultRelayer / HooksTrampoline bake chain-specific immutables
# (authenticator, vault, vaultRelayer, settlement, domain separator) into RUNTIME
# code, so their codehash legitimately DIFFERS from OP/MegaETH — verify those by
# GETTERS + wiring. Only the immutable-free contracts (Auth impl, Balances,
# Signatures) get an exact codehash match against the OP/MegaETH equivalents.
codehash() { cast codehash --rpc-url "$RPC" "$1" 2>/dev/null || cast keccak "$(cast code --rpc-url "$RPC" "$1")"; }
lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
echo ""
echo "=== [GATE] Deployed-bytecode integrity (ToB + Codex must confirm) ==="
echo ""
echo "  (1) EXACT codehash match vs the OP/MegaETH deployed equivalents (no immutables):"
for pair in "AuthImpl:$OPHIS_AUTH_IMPL" "Balances:$OPHIS_BALANCES" "Signatures:$OPHIS_SIGNATURES"; do
  n=${pair%%:*}; a=${pair#*:}
  printf '      %-12s %s  codehash=%s\n' "$n" "$a" "$(codehash "$a")"
done
# ToB F2 (highest leverage): if the expected codehashes are pinned in .env
# (OPHIS_EXPECTED_CODEHASH_{AUTHIMPL,BALANCES,SIGNATURES} — compute once at ceremony
# prep from the OP/MegaETH deployed equivalents), HARD-assert so the gate is
# self-enforcing instead of relying on the human ToB diff.
F2_PINNED=0
for trip in "AuthImpl:$OPHIS_AUTH_IMPL:${OPHIS_EXPECTED_CODEHASH_AUTHIMPL:-}" \
            "Balances:$OPHIS_BALANCES:${OPHIS_EXPECTED_CODEHASH_BALANCES:-}" \
            "Signatures:$OPHIS_SIGNATURES:${OPHIS_EXPECTED_CODEHASH_SIGNATURES:-}"; do
  n=${trip%%:*}; rest=${trip#*:}; a=${rest%%:*}; exp=${rest#*:}
  [[ -z "$exp" ]] && continue
  F2_PINNED=1
  got=$(codehash "$a")
  [[ "$(lc "$exp")" == "$(lc "$got")" ]] || { echo "ERROR: $n codehash $got != pinned $exp — NOT the audited fork" >&2; exit 10; }
  echo "      $n codehash matches pinned expected (machine-asserted)"
done
[[ "$F2_PINNED" == "1" ]] || echo "      (pin OPHIS_EXPECTED_CODEHASH_{AUTHIMPL,BALANCES,SIGNATURES} in .env to machine-assert; else ToB+Codex diff live)"
echo ""
echo "  (2) WIRING getters for immutable-bearing contracts (codehash WILL differ from OP):"
echo "      Settlement.authenticator() = $(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "authenticator()(address)")  (must == Auth $OPHIS_AUTH)"
echo "      Settlement.vaultRelayer()  = $(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vaultRelayer()(address)")  (must == VaultRelayer $OPHIS_VAULT_RELAYER)"
echo "      Settlement.vault()         = $(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vault()(address)")  (Balancer V2 vault 0xBA12222222228d8Ba445958a75a0704d566BF2C8)"
echo "      Settlement.domainSeparator = $(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "domainSeparator()(bytes32)")  (chain-130-specific; record it)"
echo "      HooksTrampoline.settlement = $(cast call --rpc-url "$RPC" "$OPHIS_HOOKS_TRAMPOLINE" "settlement()(address)")  (must == Settlement $OPHIS_SETTLEMENT)"
echo ""
echo "  (3) Proxy points at the verified implementation (EIP-1967 impl slot):"
IMPL_SLOT=$(cast storage --rpc-url "$RPC" "$OPHIS_AUTH" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc 2>/dev/null)
echo "      Auth impl slot = $IMPL_SLOT  (low 20 bytes must == AuthImpl $OPHIS_AUTH_IMPL)"
echo ""
# Hard-assert the wiring the script CAN check (Codex MEDIUM): a mismatch means the
# deploy is broken — refuse before addSolver. ToB+Codex still confirm the (1)
# codehashes against the audited fork (compare to the OP/MegaETH deployed equivalents
# from contracts/networks.json chain 10 / the OP deployment — pin these at ceremony prep).
lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
W_AUTH=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "authenticator()(address)")
W_VR=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vaultRelayer()(address)")
W_VAULT=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vault()(address)")
W_HS=$(cast call --rpc-url "$RPC" "$OPHIS_HOOKS_TRAMPOLINE" "settlement()(address)")
W_IMPL="0x${IMPL_SLOT: -40}"
BAL_VAULT=0xBA12222222228d8Ba445958a75a0704d566BF2C8  # Balancer V2 vault (verified on 130)
[[ "$(lc "$W_AUTH")" == "$(lc "$OPHIS_AUTH")" ]] || { echo "ERROR: Settlement.authenticator $W_AUTH != Auth $OPHIS_AUTH" >&2; exit 10; }
[[ "$(lc "$W_VR")" == "$(lc "$OPHIS_VAULT_RELAYER")" ]] || { echo "ERROR: Settlement.vaultRelayer $W_VR != VaultRelayer $OPHIS_VAULT_RELAYER" >&2; exit 10; }
[[ "$(lc "$W_VAULT")" == "$(lc "$BAL_VAULT")" ]] || { echo "ERROR: Settlement.vault $W_VAULT != Balancer V2 vault $BAL_VAULT (settlement-critical)" >&2; exit 10; }
[[ "$(lc "$W_HS")" == "$(lc "$OPHIS_SETTLEMENT")" ]] || { echo "ERROR: HooksTrampoline.settlement $W_HS != Settlement $OPHIS_SETTLEMENT" >&2; exit 10; }
[[ "$(lc "$W_IMPL")" == "$(lc "$OPHIS_AUTH_IMPL")" ]] || { echo "ERROR: Auth proxy impl $W_IMPL != AuthImpl $OPHIS_AUTH_IMPL" >&2; exit 10; }
echo "  Wiring auto-asserted OK: authenticator / vaultRelayer / vault / settlement / impl all consistent."
echo ""
echo "  STOP. Run the ToB + Codex gpt-5.5 review against the above NOW. Confirm:"
echo "    - the (1) codehashes are IDENTICAL to the OP/MegaETH deployed equivalents, AND"
echo "    - the (2)+(3) wiring is correct (authenticator / vaultRelayer / vault / settlement / impl)."
read -r -p "  Press ENTER ONLY after ToB+Codex confirm bytecode + wiring..."

# --- 3. Allowlist driver-submitter ---
echo ""
echo "=== [3/4] Allowlisting Unichain driver-submitter $DRIVER (Ledger) ==="
send_checked "addSolver" "$OPHIS_AUTH" "addSolver(address)" "$DRIVER" --gas-limit 2000000
IS_SOLVER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "isSolver(address)(bool)" "$DRIVER")
echo "  isSolver(driver): $IS_SOLVER"

if [[ "$IS_SOLVER" != "true" ]]; then
  echo "ERROR: driver-submitter not allowlisted after addSolver — investigate before proceeding" >&2
  exit 5
fi

# --- 4. Transfer ownership + manager to the Ophis protocol Safe ---
# CRITICAL: closes the window where the HW wallet still has unilateral protocol
# power. After these two txs, only the 2-of-3 Safe can addSolver/removeSolver/
# transferOwnership/upgrade.
#
# Interrupt safety (Codex 2026-05-13): order is transferOwnership FIRST so an
# interrupted state (Safe=owner, HW=manager) leaves the Safe with strictly MORE
# authority than the HW wallet — a stolen HW wallet there could only addSolver
# (bounded), and the Safe can immediately removeSolver + setManager(Safe). If you
# Ctrl-C between the two txs, resume manually:
#   cast send --rpc-url "$RPC" --ledger "$OPHIS_AUTH" "setManager(address)" "$SAFE" --gas-limit 2000000
echo ""
echo "=== [4/4] Transferring AuthList ownership to Ophis protocol Safe (Ledger) ==="
echo "  Safe: $SAFE"

send_checked "transferOwnership" "$OPHIS_AUTH" "transferOwnership(address)" "$SAFE" --gas-limit 2000000
echo "  transferOwnership OK"

send_checked "setManager" "$OPHIS_AUTH" "setManager(address)" "$SAFE" --gas-limit 2000000
echo "  setManager OK"

NEW_OWNER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "owner()(address)")
NEW_MANAGER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "manager()(address)")
echo ""
echo "  Verified owner:   $NEW_OWNER"
echo "  Verified manager: $NEW_MANAGER"

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
echo "  OK Protocol authority fully handed to the 2-of-3 Safe"

# --- Persist all addresses + emit the placeholder fill map ---
echo ""
echo "=== Writing addresses to .env ==="
cat <<EOF >> "$ENV_FILE"

# Unichain mainnet (chain 130) sovereign deploy ($(date +%Y-%m-%d))
OPHIS_AUTH_UNICHAIN=$OPHIS_AUTH
OPHIS_AUTH_IMPLEMENTATION_UNICHAIN=$OPHIS_AUTH_IMPL
OPHIS_SETTLEMENT_UNICHAIN=$OPHIS_SETTLEMENT
OPHIS_VAULT_RELAYER_UNICHAIN=$OPHIS_VAULT_RELAYER
OPHIS_BALANCES_UNICHAIN=$OPHIS_BALANCES
OPHIS_SIGNATURES_UNICHAIN=$OPHIS_SIGNATURES
OPHIS_HOOKS_TRAMPOLINE_UNICHAIN=$OPHIS_HOOKS_TRAMPOLINE
EOF

echo ""
echo "=== Done. Fill these into configs/*.toml.tmpl (render-configs.sh refuses until filled): ==="
echo "  __FILL_AFTER_DEPLOY_SETTLEMENT__  -> $OPHIS_SETTLEMENT"
echo "  __FILL_AFTER_DEPLOY_BALANCES__    -> $OPHIS_BALANCES"
echo "  __FILL_AFTER_DEPLOY_SIGNATURES__  -> $OPHIS_SIGNATURES"
echo "  __FILL_AFTER_DEPLOY_HOOKS__       -> $OPHIS_HOOKS_TRAMPOLINE"
echo "  __FILL_AFTER_DEPLOY_SUBMITTER__   -> $DRIVER"
echo "  (AllowListAuthentication proxy for monitoring: $OPHIS_AUTH)"
echo ""
echo "Protocol authority: 2-of-3 Safe $SAFE"
echo "Next: fill placeholders -> ./render-configs.sh -> ./compose-up.sh -> 6-gate VALIDATION.md"
echo ""
echo "GOVERNANCE POSTURE (Codex MEDIUM): launched DIRECT-TO-SAFE (no 24h Timelock +"
echo "Guardian). Acceptable for Phase-0 (single-solver, low TVL), but the 2-of-3 Safe"
echo "can instantly addSolver/upgrade. BEFORE meaningful TVL or the public cowSdk.ts"
echo "frontend flip: deploy the per-chain 24h TimelockController + AllowListGuardian and"
echo "migrate Auth ownership/manager to them (the OP post-launch model). Dated blocker"
echo "tracked in VALIDATION.md."
