#!/usr/bin/env bash
# Ophis — HyperEVM mainnet (chain 999) bootstrap.
#
# Software-EOA signing flow (deliberately not Ledger — see rationale below).
#
# Steps:
#   1. CoW core (Settlement + VaultRelayer + AllowListAuth) via hardhat-deploy.
#   2. CoW helpers (Balances + Signatures + HooksTrampoline) via cast send --create.
#   3. Allowlist driver-submitter (addSolver).
#   4. Transfer AuthList ownership + manager to the Ophis protocol Safe.
#
# Why software EOA, not Ledger:
#   HyperEVM big-block opt-in requires the signer EOA to be a HyperCore user
#   (any HyperCore asset receipt). The software deployer (Keychain
#   `ophis-megaeth-deployer`) is already HyperCore-registered + big-block
#   opted in. Reusing the Ledger would require another bridge + opt-in
#   cycle. The software EOA's protocol authority transfers to the Safe at
#   step 4, so the trust window is ≤ 1 minute.
#
# Pre-conditions:
#   - $REPO_ROOT/infra/hyperevm/.env exists and contains:
#       * GREG_MEGAETH_DEPLOYER_ADDRESS — deployer EOA on HL
#       * GREG_DRIVER_SUBMITTER_ADDRESS — driver-submitter EOA on HL
#       * OPHIS_PROTOCOL_SAFE_HYPEREVM_MAINNET — Safe that takes authority
#       * HYPEREVM_MAINNET_RPC — Alchemy or paid endpoint (public RPC has
#         100 req/min/IP cap that breaks hardhat-deploy mid-flow)
#   - Keychain entry `ophis-megaeth-deployer` holds the deployer PK
#   - Deployer EOA balance ≥ 0.5 HYPE on chain 999
#   - Deployer EOA opted into big blocks (run opt-in-big-blocks.py)
#   - Ophis Safe deployed on chain 999 (verify with: cast code <safe> --rpc-url …)
#
# Rationale documented in research notes /tmp/hyperevm-research.md.

set -euo pipefail

REPO_ROOT="/Users/scep/greg"
ENV_FILE="$REPO_ROOT/infra/hyperevm/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found — copy from .env.example first" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# --- Env-name bridge: legacy .env uses GREG_*, Hardhat config reads OPHIS_*.
# Keep .env on legacy names (touches many infra files) and remap here.
export OPHIS_MEGAETH_DEPLOYER_ADDRESS="${GREG_MEGAETH_DEPLOYER_ADDRESS:?GREG_MEGAETH_DEPLOYER_ADDRESS must be set in $ENV_FILE}"

RPC="${HYPEREVM_MAINNET_RPC:?HYPEREVM_MAINNET_RPC must be set in $ENV_FILE}"
DEPLOYER_ADDR="$OPHIS_MEGAETH_DEPLOYER_ADDRESS"
DRIVER="${GREG_DRIVER_SUBMITTER_ADDRESS:?GREG_DRIVER_SUBMITTER_ADDRESS must be set in $ENV_FILE}"
SAFE="${OPHIS_PROTOCOL_SAFE_HYPEREVM_MAINNET:?OPHIS_PROTOCOL_SAFE_HYPEREVM_MAINNET must be set in $ENV_FILE}"

# Hard-fail if `bc` is missing — the balance comparison below uses it. macOS
# ships bc by default but stripped CI images won't, and the previous
# `|| echo "0"` fallback silently skipped the threshold check.
command -v bc >/dev/null 2>&1 || { echo "ERROR: bc not installed" >&2; exit 9; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not installed" >&2; exit 9; }

# Pull PK from Keychain. `-s` matches the service name; the entry's `-a`
# attribute is "scep" not "ophis-megaeth-deployer", so we MUST NOT pass -a
# (would give exit 44 — entry not found).
#
# Security: PK is held in a local shell variable and re-exported into each
# stage's child env explicitly. It is NOT global-exported to the script's
# process env, so subshells / cast invocations that don't need it
# (cast call / cast balance / cast code) never see it. The hardhat-deploy
# stage needs the PK in env (config reads OPHIS_MEGAETH_DEPLOYER_PK) and
# is launched with a per-invocation `OPHIS_MEGAETH_DEPLOYER_PK=$PK` prefix.
# The cast send stages use ETH_PRIVATE_KEY (cast's standard env-var hook)
# also per-invocation, NOT --private-key on argv — argv would expose the
# PK to `ps auxe` / `/proc/<pid>/cmdline` / macOS Endpoint Security logs.
OPHIS_MEGAETH_DEPLOYER_PK=$(security find-generic-password \
  -s "ophis-megaeth-deployer" -w)
if [[ ! "$OPHIS_MEGAETH_DEPLOYER_PK" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: Keychain entry 'ophis-megaeth-deployer' did not yield a 32-byte hex PK" >&2
  exit 8
fi
# The hardhat config (contracts/hardhat-megaeth.config.ts) reads this name
# specifically. It is intentionally NOT marked readonly so we can clear at
# script exit.
trap 'unset OPHIS_MEGAETH_DEPLOYER_PK ETH_PRIVATE_KEY 2>/dev/null || true' EXIT

# --- Sanity checks ---
echo "=== Pre-flight ==="
echo "  Deployer:   $DEPLOYER_ADDR"
echo "  Driver:     $DRIVER"
echo "  Safe:       $SAFE"
echo "  RPC:        ${RPC%/v2/*}/v2/<redacted>"
echo ""

BAL_WEI=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR")
BAL_HYPE=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether)
echo "  Balance:    $BAL_HYPE HYPE"

# Threshold ~0.5 HYPE — 3 contract deploys (Settlement ~5M + VaultRelayer
# ~2M + AuthProxy ~2.5M = ~9.5M gas) + helpers (~3M) + setter calls (~150k)
# = ~13M gas total. At 0.1 gwei base fee that's 0.0013 HYPE; buffer covers
# spikes and the multiple txs.
THRESHOLD_WEI=500000000000000000  # 0.5 HYPE in wei
if (( $(echo "$BAL_WEI < $THRESHOLD_WEI" | bc -l 2>/dev/null || echo "0") )); then
  echo "ERROR: deployer balance < 0.5 HYPE — fund $DEPLOYER_ADDR first" >&2
  exit 4
fi

# Verify Safe deployed (Safe Proxy Factory CREATE2 must have run for
# this address on chain 999 — we cannot transferOwnership to a code-less
# address without bricking AuthList admin).
SAFE_CODE=$(cast code --rpc-url "$RPC" "$SAFE")
if [[ "$SAFE_CODE" == "0x" ]]; then
  echo "ERROR: Safe $SAFE has no bytecode on chain 999." >&2
  echo "  Deploy it via app.safe.global (chain HyperEVM) or SafeProxyFactory before continuing." >&2
  exit 5
fi
SAFE_OWNERS=$(cast call --rpc-url "$RPC" "$SAFE" "getOwners()(address[])")
SAFE_THRESHOLD=$(cast call --rpc-url "$RPC" "$SAFE" "getThreshold()(uint256)")
echo "  Safe owners:    $SAFE_OWNERS"
echo "  Safe threshold: $SAFE_THRESHOLD"
echo ""

# Audit MEDIUM-4 (2026-05-17) — original proposal was to preflight HL block
# gas-limit. Withdrawn after Codex Cyber review: HyperEVM big-block routing
# is PER-ADDRESS, not global. `eth_getBlockByNumber("latest").gasLimit` is
# the most recently-included block's limit; that block may be a 3M small
# block even when our deployer EOA is fully opted-in for big blocks (and
# vice versa). The check would both false-fail and false-pass.
#
# Correct preflight requires either (a) reading HyperCore opt-in state via
# the off-chain HyperCore API, or (b) actually broadcasting a low-gas
# probe tx and observing inclusion. Neither is cheap or precise enough to
# add inline. Treating big-block opt-in as a Pre-conditions item (above):
# OPERATOR MUST CONFIRM with `python3 opt-in-big-blocks.py status $DEPLOYER_ADDR`
# before running this script. If forgotten, hardhat-deploy will fail
# loudly with "intrinsic gas too high" mid-flow; recovery is to opt-in
# and re-run (idempotent up to the AllowList deploy step).
echo ""

read -p "Press ENTER to deploy (or Ctrl-C to abort)..."

# --- 1. CoW core via hardhat-deploy (software-EOA signed) ---
echo ""
echo "=== [1/4] Deploying CoW Settlement + VaultRelayer + Auth ==="
cd "$REPO_ROOT/contracts"

LOG="$REPO_ROOT/infra/hyperevm/deploy-log-mainnet-$(date +%Y%m%d-%H%M%S).log"
# Create + chmod 600 the log BEFORE any process writes to it. If hardhat or
# tee ever prints `process.env` on an uncaught exception (we've seen this in
# upstream debug paths) the PK would land in this file; chmod 600 keeps it
# scoped to the operator.
: > "$LOG" && chmod 600 "$LOG"

# HARDHAT_NETWORK env var must be set explicitly — hardhat's CLI --network
# flag doesn't propagate to process.env, so the chain-aware gasLimit logic
# in contracts/src/deploy/001_authenticator.ts couldn't see chain 999 and
# would fall through to the 25M default (which is fine for HL, but better
# to be explicit so future edits don't accidentally route HL through the
# MegaETH 100M default).
# PK is passed via per-invocation env prefix (NOT global export) so cast
# subshells in this script never see it.
HARDHAT_CONFIG=hardhat-megaeth.config.ts \
HARDHAT_NETWORK=hyperevm-mainnet \
OPHIS_MEGAETH_DEPLOYER_PK="$OPHIS_MEGAETH_DEPLOYER_PK" \
OPHIS_MEGAETH_DEPLOYER_ADDRESS="$OPHIS_MEGAETH_DEPLOYER_ADDRESS" \
  pnpm exec hardhat deploy --network hyperevm-mainnet 2>&1 | tee "$LOG"

DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments/hyperevm-mainnet"
# python3 invocation passes the JSON file path via argv (sys.argv[1]) instead
# of string-interpolating into the python source — closes a code-injection
# foot-shape if $DEPLOYMENTS_DIR ever contained a single-quote.
read_artifact_address() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' "$1"
}
OPHIS_AUTH=$(read_artifact_address "$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Proxy.json")
OPHIS_AUTH_IMPL=$(read_artifact_address "$DEPLOYMENTS_DIR/GPv2AllowListAuthentication_Implementation.json")
OPHIS_SETTLEMENT=$(read_artifact_address "$DEPLOYMENTS_DIR/GPv2Settlement.json")
OPHIS_VAULT_RELAYER=$(cast call --rpc-url "$RPC" "$OPHIS_SETTLEMENT" "vaultRelayer()(address)")

echo ""
echo "  Auth Proxy:           $OPHIS_AUTH"
echo "  Auth Implementation:  $OPHIS_AUTH_IMPL"
echo "  Settlement:           $OPHIS_SETTLEMENT"
echo "  VaultRelayer:         $OPHIS_VAULT_RELAYER"

# Audit LOW-2 (2026-05-17): atomic deploy+init verification. Hardhat-deploy
# bundles proxy deploy + initializeManager(deployer) but they're two
# separate on-chain txs. If the init tx failed/dropped (RPC flake, gas
# underpricing), an attacker watching the mempool could race-call
# initializeManager(attackerAddr) and become manager of a deployed-but-
# uninitialized AllowList proxy. Detect this by asserting manager() ==
# DEPLOYER_ADDR BEFORE the script proceeds to setManager(Safe).
INIT_MANAGER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "manager()(address)")
LOWER_INIT_MANAGER=$(echo "$INIT_MANAGER" | tr '[:upper:]' '[:lower:]')
LOWER_DEPLOYER=$(echo "$DEPLOYER_ADDR" | tr '[:upper:]' '[:lower:]')
if [[ "$LOWER_INIT_MANAGER" != "$LOWER_DEPLOYER" ]]; then
  # GPv2AllowListAuthentication.setManager is onlyManagerOrOwner — and the
  # deployer at this point still holds the proxy owner role (handoff
  # happens at step 4). So a raced initializeManager is RECOVERABLE: the
  # deployer can call setManager(deployer) to retake the manager slot,
  # then continue the script. Recovery is NOT a redeploy.
  echo "ERROR: AllowList proxy initializeManager was raced." >&2
  echo "       manager() = $INIT_MANAGER" >&2
  echo "       expected  = $DEPLOYER_ADDR" >&2
  echo "       Recovery: deployer still holds proxy owner role; reclaim manager via" >&2
  echo "         ETH_PRIVATE_KEY=\$PK cast send --rpc-url $RPC $OPHIS_AUTH \\" >&2
  echo "           'setManager(address)' $DEPLOYER_ADDR --gas-limit 200000" >&2
  echo "       Then re-run this script (idempotent from step 2 onward)." >&2
  exit 9
fi
echo "  ✓ proxy initialized atomically (manager == deployer pre-handoff)"

# --- 2. CoW helpers via cast send --create ---
echo ""
echo "=== [2/4] Deploying CoW helpers ==="
cd "$REPO_ROOT"

deploy_artifact_create() {
  local name="$1" path="$2" extra_args="${3:-}"
  # python3 with file path and suffix passed as argv — no string
  # interpolation into the source, no injection surface.
  CODE=$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
bc = d["bytecode"]
if isinstance(bc, dict): bc = bc.get("object", bc.get("bytecode"))
if not bc.startswith("0x"): bc = "0x" + bc
print(bc + sys.argv[2])
' "$path" "$extra_args")
  # HL big-block max is 30M gas. Balances/Signatures/HooksTrampoline are
  # all under 1M gas to deploy — 5M gives generous headroom without
  # tripping the big-block cap.
  # ETH_PRIVATE_KEY (cast's standard hook) used instead of --private-key
  # so the PK never appears in ps / /proc/<pid>/cmdline / strace logs.
  local result
  result=$(ETH_PRIVATE_KEY="$OPHIS_MEGAETH_DEPLOYER_PK" \
    cast send --rpc-url "$RPC" --gas-limit 5000000 --create "$CODE" --json)
  echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("contractAddress"))'
}

OPHIS_BALANCES=$(deploy_artifact_create Balances apps/backend/contracts/artifacts/Balances.json)
OPHIS_SIGNATURES=$(deploy_artifact_create Signatures apps/backend/contracts/artifacts/Signatures.json)

SETTLEMENT_HEX=${OPHIS_SETTLEMENT#0x}
PADDED=$(printf '%0*d' 24 0)$SETTLEMENT_HEX
OPHIS_HOOKS_TRAMPOLINE=$(deploy_artifact_create HooksTrampoline \
    apps/backend/contracts/artifacts/HooksTrampoline.json \
    "$PADDED")

echo "  Balances:        $OPHIS_BALANCES"
echo "  Signatures:      $OPHIS_SIGNATURES"
echo "  HooksTrampoline: $OPHIS_HOOKS_TRAMPOLINE"

# --- 3. Allowlist driver-submitter ---
echo ""
echo "=== [3/4] Allowlisting driver-submitter ==="
ETH_PRIVATE_KEY="$OPHIS_MEGAETH_DEPLOYER_PK" \
  cast send --rpc-url "$RPC" \
  "$OPHIS_AUTH" "addSolver(address)" "$DRIVER" \
  --gas-limit 200000 >/dev/null
IS_SOLVER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "isSolver(address)(bool)" "$DRIVER")
echo "  isSolver(driver): $IS_SOLVER"
if [[ "$IS_SOLVER" != "true" ]]; then
  echo "ERROR: driver not allowlisted after addSolver — abort before ownership transfer" >&2
  exit 6
fi

# --- 4. Transfer ownership + manager to the Ophis protocol Safe ---
# CRITICAL: closes the dangerous window where the software deployer still
# has unilateral protocol-level power. After these two txs, only the Safe
# can addSolver / removeSolver / transferOwnership / upgrade.
#
# Interrupt safety: if Ctrl-C between transferOwnership and setManager,
# AuthList is left in a partial state (Safe=owner, deployer=manager). Order
# is transferOwnership FIRST so the partial state leaves the Safe with
# strictly MORE authority than the deployer — a stolen deployer key at
# this intermediate point could only addSolver (bounded), and the Safe can
# immediately removeSolver + setManager(Safe) to recover.
echo ""
echo "=== [4/4] Transferring AuthList ownership to Safe $SAFE ==="

# M3: each stage-4 tx wrapped with explicit 60s timeout so a hung RPC
# (eRPC stall, HL provider 429) doesn't leave the AuthList in a split-
# authority state (Safe=owner, deployer=manager). If a tx hangs, the
# operator sees `timeout` clearly and can re-run from the partial state.
timeout 60 env ETH_PRIVATE_KEY="$OPHIS_MEGAETH_DEPLOYER_PK" \
  cast send --rpc-url "$RPC" \
  "$OPHIS_AUTH" "transferOwnership(address)" "$SAFE" \
  --gas-limit 200000 >/dev/null || {
    echo "ERROR: transferOwnership timed out or failed. AuthList state is unchanged." >&2
    echo "       Verify with: cast call --rpc-url $RPC $OPHIS_AUTH 'owner()(address)'" >&2
    echo "       If owner is still the deployer, re-run this script (idempotent)." >&2
    exit 10
  }
echo "  transferOwnership ✓"

timeout 60 env ETH_PRIVATE_KEY="$OPHIS_MEGAETH_DEPLOYER_PK" \
  cast send --rpc-url "$RPC" \
  "$OPHIS_AUTH" "setManager(address)" "$SAFE" \
  --gas-limit 200000 >/dev/null || {
    echo "ERROR: setManager timed out or failed. AuthList is in SPLIT AUTHORITY state:" >&2
    echo "       owner = Safe ($SAFE) — corrects bounded-blast-radius" >&2
    echo "       manager = deployer ($DEPLOYER_ADDR) — can still addSolver" >&2
    echo "       RECOVERY: re-run manually:" >&2
    echo "         ETH_PRIVATE_KEY=\$PK cast send --rpc-url $RPC $OPHIS_AUTH 'setManager(address)' $SAFE --gas-limit 200000" >&2
    exit 11
  }
echo "  setManager ✓"

NEW_OWNER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "owner()(address)")
NEW_MANAGER=$(cast call --rpc-url "$RPC" "$OPHIS_AUTH" "manager()(address)")
echo ""
echo "  Verified — owner:   $NEW_OWNER"
echo "  Verified — manager: $NEW_MANAGER"

LOWER_SAFE=$(echo "$SAFE" | tr '[:upper:]' '[:lower:]')
LOWER_OWNER=$(echo "$NEW_OWNER" | tr '[:upper:]' '[:lower:]')
LOWER_MANAGER=$(echo "$NEW_MANAGER" | tr '[:upper:]' '[:lower:]')
if [[ "$LOWER_OWNER" != "$LOWER_SAFE" ]]; then
  echo "ERROR: owner is $NEW_OWNER, expected $SAFE" >&2
  exit 7
fi
if [[ "$LOWER_MANAGER" != "$LOWER_SAFE" ]]; then
  echo "ERROR: manager is $NEW_MANAGER, expected $SAFE" >&2
  exit 8
fi
echo "  ✓ Protocol authority handed to Safe"

# --- Persist addresses ---
echo ""
echo "=== Writing addresses to .env ==="
cat <<EOF >> "$ENV_FILE"

# HyperEVM mainnet deploy ($(date +%Y-%m-%d))
GREG_AUTH_HYPEREVM_MAINNET=$OPHIS_AUTH
GREG_AUTH_IMPLEMENTATION_HYPEREVM_MAINNET=$OPHIS_AUTH_IMPL
GREG_SETTLEMENT_HYPEREVM_MAINNET=$OPHIS_SETTLEMENT
GREG_VAULT_RELAYER_HYPEREVM_MAINNET=$OPHIS_VAULT_RELAYER
GREG_BALANCES_HYPEREVM_MAINNET=$OPHIS_BALANCES
GREG_SIGNATURES_HYPEREVM_MAINNET=$OPHIS_SIGNATURES
GREG_HOOKS_TRAMPOLINE_HYPEREVM_MAINNET=$OPHIS_HOOKS_TRAMPOLINE
EOF

echo ""
echo "=== Done. ==="
echo ""
echo "Liquidity routing: KyberSwap aggregator (verified live for chain 999)."
echo "  Baseline solver returns NoSolutions until a UniV2/V3 router is verified live"
echo "  on chain 999 — research flagged HyperSwap V2 router/factory as 0x bytecode."
echo ""
echo "Protocol authority: 2-of-2 Safe $SAFE"
echo "  (Task #104 backlog: add 3rd signer for 2-of-3 quorum)"
