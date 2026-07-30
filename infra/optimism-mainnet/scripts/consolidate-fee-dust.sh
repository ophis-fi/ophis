#!/usr/bin/env bash
# Prepare a Safe transaction that consolidates multi-denomination fee dust
# held by the Ophis OP Settlement contract into WETH, in place, via
# OphisFeeLiquidator.consolidate().
#
# TRUST BOUNDARY (audit BLOCKER fix): consolidate() is OWNER-ONLY. It routes
# through an arbitrary allowlisted venue with caller-supplied calldata and a
# caller-supplied amountOutMin, so a hot key could pick amountOutMin = 1 and
# venue calldata paying an attacker. The 100 bps cap below binds THIS SCRIPT,
# not a direct contract call, so the contract itself gates consolidate() to
# the owner Safe. This script therefore does NOT sign or broadcast: it fetches
# the venue route, computes amountOutMin, simulates as the owner Safe, and
# emits a Safe Transaction Builder payload for the 2-of-3 signers to review
# and execute. There is no ops-key path here.
#
# Posture (fee-ops decision 52): the venue allowlist DEPLOYS EMPTY. This runner
# HARD-REFUSES until the owner Safe has enabled the venue + output token
# on-chain (setVenue / setOutputToken). No redeploy is needed to activate.
#
# Venue (decision 54): KyberSwap MetaAggregationRouterV2, quoted through the
# KyberSwap Aggregator API with the Settlement contract as BOTH sender and
# recipient, so the output never leaves Settlement; a later sweep moves it to
# the fee Safe. Runner slippage cap: 100 bps (SLIPPAGE_BPS may only lower it).
# amountOutMin = quote * (10000 - SLIPPAGE_BPS) / 10000, and the contract
# additionally requires amountOutMin > 0 and enforces the floor with a balance
# difference, so a lying quote cannot under-deliver.
#
# Route freshness: the emitted Safe payload embeds a SPECIFIC venue calldata
# and amountOutMin from the quote fetched at build time. Aggregator routes go
# stale in minutes and Safe signing takes longer than that, so the emitted
# payload carries the quote timestamp and a warning; re-run this script to
# refresh the route immediately before the signers execute, and confirm the
# on-chain simulation still passes.
#
# Usage:
#   FEE_LIQUIDATOR=0x... TOKEN_IN=0x0b2C… ./scripts/consolidate-fee-dust.sh
#     -> simulates as owner + prints the Safe Transaction Builder payload
#
# Env:
#   FEE_LIQUIDATOR   deployed OphisFeeLiquidator (required)
#   TOKEN_IN         input dust token address (required; ERC20 only, native
#                    ETH is swept, not consolidated)
#   AMOUNT_IN        base units to consolidate (default: full Settlement balance)
#   TOKEN_OUT        output token (default: WETH 0x4200…0006, decision 53)
#   VENUE            venue router (default: KyberSwap MetaAggregationRouterV2)
#   SLIPPAGE_BPS     runner slippage, default 100, HARD CAP 100 (decision 54)
#   OUT_JSON         optional path to write the Safe Transaction Builder JSON
#   OPHIS_RPC        RPC (default local eRPC)

set -euo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x (secret hygiene)." >&2
  exit 2
fi

for arg in "$@"; do
  case "$arg" in
    --help|-h) sed -n '2,48p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 3 ;;
  esac
done

RPC="${OPHIS_RPC:-http://localhost:4001/main/evm/10}"

SETTLEMENT="0x310784c7FCE12d578dA6f53460777bAc9718B859"
FEE_LIQUIDATOR="${FEE_LIQUIDATOR:-}"
TOKEN_IN="${TOKEN_IN:-}"
TOKEN_OUT="${TOKEN_OUT:-0x4200000000000000000000000000000000000006}"  # WETH
# KyberSwap MetaAggregationRouterV2 (same address across chains, incl. OP).
VENUE="${VENUE:-0x6131B5fae19EA4f9D964eAc0408E4408b66337b5}"
SLIPPAGE_BPS="${SLIPPAGE_BPS:-100}"
KYBER_API="${KYBER_API:-https://aggregator-api.kyberswap.com/optimism/api/v1}"
NATIVE="0x0000000000000000000000000000000000000000"

command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) required" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl required" >&2; exit 3; }
[[ -n "$FEE_LIQUIDATOR" ]] || { echo "ERROR: FEE_LIQUIDATOR env required" >&2; exit 3; }
[[ -n "$TOKEN_IN" ]] || { echo "ERROR: TOKEN_IN env required" >&2; exit 3; }

lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

[[ "$(lc "$TOKEN_IN")" != "$(lc "$NATIVE")" ]] || {
  echo "ERROR: native ETH is swept, not consolidated (contract rejects it too)." >&2; exit 3; }
[[ "$(lc "$TOKEN_IN")" != "$(lc "$TOKEN_OUT")" ]] || {
  echo "ERROR: TOKEN_IN == TOKEN_OUT (contract rejects input == output)." >&2; exit 3; }

# Runner slippage HARD CAP (decision 54): operators may tighten, never widen.
if (( SLIPPAGE_BPS > 100 )); then
  echo "ERROR: SLIPPAGE_BPS=$SLIPPAGE_BPS exceeds the 100 bps runner cap." >&2
  exit 3
fi

echo "==> Prepare consolidation Safe tx for OphisFeeLiquidator $FEE_LIQUIDATOR"

# --- pre-checks (read-only) ---

LIQ_SETTLEMENT="$(cast call "$FEE_LIQUIDATOR" "settlement()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call settlement() failed" >&2; exit 6; }
[[ "$(lc "$LIQ_SETTLEMENT")" == "$(lc "$SETTLEMENT")" ]] || {
  echo "ABORT: liquidator.settlement() = $LIQ_SETTLEMENT != pinned $SETTLEMENT" >&2; exit 6; }

# The owner Safe is the ONLY address that can execute consolidate(); resolve
# it from the contract so the simulation and the emitted payload target the
# real signer, not a guessed address.
OWNER="$(cast call "$FEE_LIQUIDATOR" "owner()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call owner() failed" >&2; exit 6; }
[[ "$(lc "$OWNER")" != "$(lc "$NATIVE")" ]] || { echo "ABORT: owner() is address(0)." >&2; exit 6; }

VENUE_OK="$(cast call "$FEE_LIQUIDATOR" "venueAllowed(address)(bool)" "$VENUE" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call venueAllowed() failed" >&2; exit 6; }
[[ "$VENUE_OK" == "true" ]] || {
  echo "ABORT: venue $VENUE is NOT allowlisted on-chain." >&2
  echo "       Consolidation is not activated (decision 52 ships it disabled)." >&2
  echo "       Activation is an owner Safe tx: setVenue(venue, true), runbook section 7." >&2
  exit 6
}
OUT_OK="$(cast call "$FEE_LIQUIDATOR" "outputTokenAllowed(address)(bool)" "$TOKEN_OUT" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call outputTokenAllowed() failed" >&2; exit 6; }
[[ "$OUT_OK" == "true" ]] || {
  echo "ABORT: output token $TOKEN_OUT is NOT allowlisted on-chain (setOutputToken)." >&2
  exit 6
}

AUTH="$(cast call "$SETTLEMENT" "authenticator()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call authenticator() failed" >&2; exit 6; }
IS_SOLVER="$(cast call "$AUTH" "isSolver(address)(bool)" "$FEE_LIQUIDATOR" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call isSolver() failed" >&2; exit 6; }
[[ "$IS_SOLVER" == "true" ]] || { echo "ABORT: liquidator not an allowlisted solver." >&2; exit 6; }

# --- amount ---

BAL="$(cast call "$TOKEN_IN" "balanceOf(address)(uint256)" "$SETTLEMENT" --rpc-url "$RPC" | awk '{print $1}')" \
  || { echo "ERROR: balanceOf failed" >&2; exit 6; }
[[ "$BAL" =~ ^[0-9]+$ ]] || { echo "ERROR: non-numeric balance: $BAL" >&2; exit 6; }
AMOUNT_IN="${AMOUNT_IN:-$BAL}"
[[ "$AMOUNT_IN" =~ ^[0-9]+$ && "$AMOUNT_IN" != "0" ]] || {
  echo "ERROR: nothing to consolidate (settlement balance $BAL)." >&2; exit 6; }
python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) <= int(sys.argv[2]) else 1)" "$AMOUNT_IN" "$BAL" || {
  echo "ERROR: AMOUNT_IN $AMOUNT_IN exceeds settlement balance $BAL." >&2; exit 6; }

# --- KyberSwap quote + calldata ---
# API surface: GET /routes then POST /route/build. Re-verify against the
# KyberSwap docs on first activation (runbook step); the shape below is the
# v1 Aggregator API as of 2026-07.

QUOTE_TS="$(date -u +%FT%TZ)"
ROUTE_JSON="$(curl -sfm 15 "$KYBER_API/routes?tokenIn=$TOKEN_IN&tokenOut=$TOKEN_OUT&amountIn=$AMOUNT_IN")" \
  || { echo "ERROR: KyberSwap /routes request failed" >&2; exit 8; }
ROUTE_SUMMARY="$(printf '%s' "$ROUTE_JSON" | jq -ec '.data.routeSummary')" \
  || { echo "ERROR: no routeSummary in KyberSwap response" >&2; exit 8; }
QUOTE_OUT="$(printf '%s' "$ROUTE_SUMMARY" | jq -er '.amountOut')" \
  || { echo "ERROR: no amountOut in routeSummary" >&2; exit 8; }
[[ "$QUOTE_OUT" =~ ^[0-9]+$ && "$QUOTE_OUT" != "0" ]] || {
  echo "ERROR: bad quote amountOut: $QUOTE_OUT" >&2; exit 8; }

BUILD_JSON="$(curl -sfm 15 -X POST "$KYBER_API/route/build" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --argjson rs "$ROUTE_SUMMARY" --arg s "$SETTLEMENT" --argjson slip "$SLIPPAGE_BPS" \
        '{routeSummary: $rs, sender: $s, recipient: $s, slippageTolerance: $slip}')")" \
  || { echo "ERROR: KyberSwap /route/build request failed" >&2; exit 8; }
VENUE_CALLDATA="$(printf '%s' "$BUILD_JSON" | jq -er '.data.data')" \
  || { echo "ERROR: no calldata in route/build response" >&2; exit 8; }
BUILD_ROUTER="$(printf '%s' "$BUILD_JSON" | jq -er '.data.routerAddress')" \
  || { echo "ERROR: no routerAddress in route/build response" >&2; exit 8; }
[[ "$(lc "$BUILD_ROUTER")" == "$(lc "$VENUE")" ]] || {
  echo "ABORT: KyberSwap built calldata for router $BUILD_ROUTER but VENUE is $VENUE." >&2
  echo "       Router rotation upstream, re-verify and update the on-chain allowlist first." >&2
  exit 8
}

AMOUNT_OUT_MIN="$(python3 -c "import sys; q=int(sys.argv[1]); s=int(sys.argv[2]); print(q*(10000-s)//10000)" "$QUOTE_OUT" "$SLIPPAGE_BPS")"
[[ "$AMOUNT_OUT_MIN" != "0" ]] || { echo "ERROR: amountOutMin computed to 0 (dust too small)." >&2; exit 8; }

echo "    owner Safe:   $OWNER"
echo "    amountIn:     $AMOUNT_IN $TOKEN_IN"
echo "    quoted out:   $QUOTE_OUT $TOKEN_OUT"
echo "    amountOutMin: $AMOUNT_OUT_MIN (slippage ${SLIPPAGE_BPS} bps)"

INPUTS_ARG="[($TOKEN_IN,$AMOUNT_IN)]"
CONSOLIDATE_SIG="consolidate((address,uint256)[],address,uint256,address,bytes)"

# --- simulate as the owner Safe (read-only; catches a bad route BEFORE the
# --- signers waste a Safe ceremony on a reverting payload) ---
echo "==> Simulating consolidate() as the owner Safe $OWNER (eth_call)"
cast call "$FEE_LIQUIDATOR" "$CONSOLIDATE_SIG" \
  "$INPUTS_ARG" "$TOKEN_OUT" "$AMOUNT_OUT_MIN" "$VENUE" "$VENUE_CALLDATA" \
  --from "$OWNER" --rpc-url "$RPC" >/dev/null \
  && echo "    simulation OK" \
  || { echo "    simulation REVERTED, do NOT queue this payload" >&2; exit 7; }

# --- emit the Safe Transaction Builder payload (NO signing here) ---
CONSOLIDATE_CALLDATA="$(cast calldata "$CONSOLIDATE_SIG" \
  "$INPUTS_ARG" "$TOKEN_OUT" "$AMOUNT_OUT_MIN" "$VENUE" "$VENUE_CALLDATA")"

SAFE_TX_JSON="$(jq -nc \
  --arg to "$FEE_LIQUIDATOR" \
  --arg data "$CONSOLIDATE_CALLDATA" \
  --arg owner "$OWNER" \
  --arg ts "$QUOTE_TS" \
  '{
    version: "1.0",
    meta: {
      name: "OphisFeeLiquidator consolidate (fee-dust)",
      description: ("Owner-only fee-dust consolidation. Route quoted at " + $ts
                   + " UTC; re-run consolidate-fee-dust.sh and re-simulate if stale before executing."),
      ownerSafe: $owner
    },
    transactions: [ { to: $to, value: "0", data: $data } ]
  }')"

if [[ -n "${OUT_JSON:-}" ]]; then
  printf '%s\n' "$SAFE_TX_JSON" | jq . > "$OUT_JSON"
  echo "==> Safe Transaction Builder payload written to $OUT_JSON"
else
  echo "==> Safe Transaction Builder payload (import into the owner Safe):"
  printf '%s\n' "$SAFE_TX_JSON" | jq .
fi
echo "    Signers: verify to == liquidator, decode the consolidate() args,"
echo "    confirm amountOutMin and the venue, then sign 2-of-3 and execute."
echo "    Follow with a sweep to move the WETH to the fee Safe."
