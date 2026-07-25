#!/usr/bin/env bash
# Sweep accumulated CIP-75 fee buffer from the Ophis OP Settlement contract
# to the fee Safe, v2, via the OphisFeeLiquidator contract.
#
# v2 mechanism (fee-ops Wave 2): `cast send FEE_LIQUIDATOR sweep(tokens,
# amounts)` signed by the DEDICATED fee-ops key. The liquidator contract is
# itself an allowlisted solver and executes an empty-trade settle() with
# post-interactions pinned to the immutable fee Safe. Consequences vs v1:
#   - the driver-submitter PK is no longer touched by fee ops, so the v1
#     30s nonce-contention guard is GONE (dedicated key = no contention;
#     closes the #119-followup);
#   - amounts are passed as 0 = full balance, resolved on-chain against the
#     same-block balance (no TOCTOU between probe and broadcast);
#   - the destination cannot be changed by this script AT ALL (immutable in
#     the contract).
#
# v1 (forge script SweepSettlementBuffer + driver-submitter key) remains the
# documented DISASTER-RECOVERY fallback ONLY, see
# docs/operations/fee-treasury-ops-runbook.md ("DR fallback").
#
# Safety:
#   - Defaults to DRY-RUN (eth_call simulation). `--broadcast` required for
#     live submission.
#   - PK read via subshell capture (never echoed; see
#     feedback_never_dump_keychain_token_to_stdout).
#   - Pre-broadcast checks: liquidator contract is an allowlisted solver;
#     the ops key matches the contract's `liquidator()`; the contract's
#     immutable settlement/feeSafe match the pinned addresses.
#   - Per-token base-unit thresholds (HIGH-1 lesson: a single wei-denominated
#     threshold is decimals-blind). Below threshold = token skipped.
#
# Usage:
#   FEE_LIQUIDATOR=0x... ./scripts/sweep-to-safe.sh               # dry-run
#   FEE_LIQUIDATOR=0x... ./scripts/sweep-to-safe.sh --broadcast   # live
#
#   # Override token list + thresholds (BOTH required together; aligned 1:1;
#   # use 0x0000000000000000000000000000000000000000 for native ETH):
#   TOKENS=0x...,0x... MIN_BASE_UNITS=1e7,3e15 ./scripts/sweep-to-safe.sh

set -euo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: the fee-ops PK would leak." >&2
  exit 2
fi

BROADCAST=0
for arg in "$@"; do
  case "$arg" in
    --broadcast) BROADCAST=1 ;;
    --help|-h)
      sed -n '2,40p' "$0"
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 3 ;;
  esac
done

RPC="${OPHIS_RPC:-http://localhost:4001/main/evm/10}"
PK_PATH="${OPHIS_FEE_OPS_KEY_PATH:-/Users/ophis-driver/.config/fee-ops.key}"

# Pinned addresses (Ophis OP mainnet). FEE_LIQUIDATOR has NO default until
# the deployment lands; the runbook records the deployed address.
SETTLEMENT="0x310784c7FCE12d578dA6f53460777bAc9718B859"
SAFE="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
FEE_LIQUIDATOR="${FEE_LIQUIDATOR:-}"
NATIVE="0x0000000000000000000000000000000000000000"

command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) not in PATH" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 3; }
[[ -n "$FEE_LIQUIDATOR" ]] || {
  echo "ERROR: FEE_LIQUIDATOR env not set (deployed OphisFeeLiquidator address," >&2
  echo "       see docs/operations/fee-treasury-ops-runbook.md)." >&2
  exit 3
}

lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

# Default sweep set: USDC + WETH + native ETH, thresholds ~$10-equivalent
# (HIGH-1: per-token base units, never a shared wei number). When TOKENS is
# overridden, MIN_BASE_UNITS MUST be explicit (Codex re-audit MED, PR #223:
# the unknown-token fallback silently re-created HIGH-1 for 6-decimal
# tokens).
if [[ -n "${TOKENS:-}" ]]; then
  [[ -n "${MIN_BASE_UNITS:-}" ]] || {
    echo "ERROR: MIN_BASE_UNITS must be set when TOKENS is overridden." >&2
    exit 3
  }
  IFS=, read -ra TOKEN_LIST <<< "$TOKENS"
  IFS=, read -ra MIN_LIST <<< "$MIN_BASE_UNITS"
  [[ "${#TOKEN_LIST[@]}" -eq "${#MIN_LIST[@]}" ]] || {
    echo "ERROR: TOKENS and MIN_BASE_UNITS length mismatch." >&2
    exit 3
  }
else
  TOKEN_LIST=(
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"  # USDC (6 dec)
    "0x4200000000000000000000000000000000000006"  # WETH (18 dec)
    "$NATIVE"                                     # native ETH
  )
  MIN_LIST=( 1e7 3e15 3e15 )
fi

to_int() {  # accepts 1e7-style scientific notation
  python3 - "$1" <<'EOF'
import sys
print(int(float(sys.argv[1])))
EOF
}

echo "==> Fee sweep v2 via OphisFeeLiquidator $FEE_LIQUIDATOR"

# --- pre-broadcast checks (all read-only; abort BEFORE any signing) ---

# 1. Contract pins: the deployed liquidator must reference the settlement
#    and Safe this script believes in, catches copy-paste of a rehearsal
#    (Sepolia) address into a mainnet environment and vice versa.
LIQ_SETTLEMENT="$(cast call "$FEE_LIQUIDATOR" "settlement()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call settlement() failed" >&2; exit 6; }
LIQ_SAFE="$(cast call "$FEE_LIQUIDATOR" "feeSafe()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call feeSafe() failed" >&2; exit 6; }
[[ "$(lc "$LIQ_SETTLEMENT")" == "$(lc "$SETTLEMENT")" ]] || {
  echo "ABORT: liquidator.settlement() = $LIQ_SETTLEMENT != pinned $SETTLEMENT" >&2; exit 6; }
[[ "$(lc "$LIQ_SAFE")" == "$(lc "$SAFE")" ]] || {
  echo "ABORT: liquidator.feeSafe() = $LIQ_SAFE != pinned $SAFE" >&2; exit 6; }

# 2. Solver allowlist: broadcasting a sweep for a non-solver contract wastes
#    gas AND leaks the sweep intent into the mempool (HIGH-2 lesson).
AUTH="$(cast call "$SETTLEMENT" "authenticator()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call authenticator() failed" >&2; exit 6; }
IS_SOLVER="$(cast call "$AUTH" "isSolver(address)(bool)" "$FEE_LIQUIDATOR" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call isSolver() failed" >&2; exit 6; }
[[ "$IS_SOLVER" == "true" ]] || {
  echo "ABORT: liquidator not in the solver allowlist (timelock addSolver ceremony" >&2
  echo "       incomplete, or the guardian evicted it). See the runbook." >&2
  exit 6
}

# 3. Ops-key match: the contract's current liquidator() must be the key we
#    are about to sign with (a paused contract or a rotated key aborts here).
LIQ_EOA="$(cast call "$FEE_LIQUIDATOR" "liquidator()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call liquidator() failed" >&2; exit 6; }
if [[ "$(lc "$LIQ_EOA")" == "$(lc "$NATIVE")" ]]; then
  echo "ABORT: liquidator() is address(0), ops-key path is PAUSED." >&2
  exit 6
fi

# --- threshold filter (read-only probes; never substitute 0 on RPC error) ---
SWEEP_TOKENS=()
for i in "${!TOKEN_LIST[@]}"; do
  token="${TOKEN_LIST[$i]}"
  min_units="$(to_int "${MIN_LIST[$i]}")"
  if [[ "$(lc "$token")" == "$(lc "$NATIVE")" ]]; then
    bal="$(cast balance "$SETTLEMENT" --rpc-url "$RPC")" \
      || { echo "ERROR: cast balance failed for native ETH" >&2; exit 6; }
  else
    bal="$(cast call "$token" "balanceOf(address)(uint256)" "$SETTLEMENT" --rpc-url "$RPC" | awk '{print $1}')" \
      || { echo "ERROR: balanceOf failed for $token" >&2; exit 6; }
  fi
  [[ "$bal" =~ ^[0-9]+$ ]] || { echo "ERROR: non-numeric balance for $token: $bal" >&2; exit 6; }
  if python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)" "$bal" "$min_units"; then
    echo "    $token balance $bal >= $min_units (sweep full balance)"
    SWEEP_TOKENS+=("$token")
  else
    echo "    $token balance $bal below threshold $min_units (skip)"
  fi
done

if [[ "${#SWEEP_TOKENS[@]}" -eq 0 ]]; then
  echo "Nothing above threshold. Exiting without a transaction."
  exit 0
fi

# amounts are all 0 = full balance, resolved on-chain at execution time.
TOKENS_ARG="[$(IFS=,; echo "${SWEEP_TOKENS[*]}")]"
AMOUNTS_ARG="[$(printf '0,%.0s' $(seq 1 ${#SWEEP_TOKENS[@]}) | sed 's/,$//')]"

if [[ "$BROADCAST" -eq 0 ]]; then
  echo "==> DRY-RUN (eth_call as the on-chain liquidator $LIQ_EOA)"
  cast call "$FEE_LIQUIDATOR" "sweep(address[],uint256[])" \
    "$TOKENS_ARG" "$AMOUNTS_ARG" \
    --from "$LIQ_EOA" --rpc-url "$RPC" >/dev/null \
    && echo "    simulation OK, rerun with --broadcast to send" \
    || { echo "    simulation REVERTED, inspect before broadcasting" >&2; exit 7; }
  exit 0
fi

echo "==> LIVE BROADCAST mode"
echo "    sweep Settlement $SETTLEMENT -> Safe $SAFE"
echo "    via liquidator $FEE_LIQUIDATOR, ops key $LIQ_EOA"
echo "    Press Ctrl-C in next 5s to abort..."
sleep 5

# Trap cleanup BEFORE PK load (HIGH-2 lesson): every exit path unsets the key.
trap 'unset PK' EXIT INT TERM

if [[ ! -r "$PK_PATH" ]]; then
  PK=$(sudo -n cat "$PK_PATH" 2>/dev/null || true)
  [[ -z "$PK" ]] && { echo "ERROR: cannot read PK at $PK_PATH (need sudo?)" >&2; exit 4; }
else
  PK=$(cat "$PK_PATH")
fi
PK="${PK%$'\n'}"
[[ "$PK" =~ ^0x[0-9a-fA-F]{64}$ ]] || {
  echo "ERROR: PK doesn't match expected shape (0x + 64 hex)." >&2
  exit 5
}
echo "    PK loaded (length ${#PK}, hex-validated)"

# The signing key must BE the on-chain liquidator; a mismatch means we would
# broadcast a guaranteed "OFL: caller not ops" revert. The key travels to
# cast ONLY via the ETH_PRIVATE_KEY env var (never argv: argv is world-
# readable in `ps` for the lifetime of the process).
SIGNER="$(ETH_PRIVATE_KEY="$PK" cast wallet address)"
[[ "$(lc "$SIGNER")" == "$(lc "$LIQ_EOA")" ]] || {
  echo "ABORT: key at $PK_PATH derives $SIGNER but liquidator() is $LIQ_EOA." >&2
  exit 5
}

ETH_PRIVATE_KEY="$PK" cast send "$FEE_LIQUIDATOR" "sweep(address[],uint256[])" \
  "$TOKENS_ARG" "$AMOUNTS_ARG" --rpc-url "$RPC"
echo "Sweep tx submitted."
