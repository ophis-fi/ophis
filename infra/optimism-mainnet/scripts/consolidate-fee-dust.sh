#!/usr/bin/env bash
# Consolidate multi-denomination fee dust held by the Ophis OP Settlement
# contract into WETH, in place, via OphisFeeLiquidator.consolidate().
#
# Posture (fee-ops decision 52): the venue allowlist DEPLOYS EMPTY. This
# runner is prepared ahead of activation and HARD-REFUSES to do anything
# until the owner Safe has enabled the venue + output token on-chain
# (setVenue / setOutputToken). No redeploy is needed to activate.
#
# Venue (decision 54): KyberSwap MetaAggregationRouterV2, quoted through the
# KyberSwap Aggregator API with the Settlement contract as BOTH sender and
# recipient, the output never leaves Settlement; a later sweep moves it to
# the fee Safe. Runner slippage cap: 100 bps (SLIPPAGE_BPS may only lower
# it). amountOutMin = quote * (10000 - SLIPPAGE_BPS) / 10000, and the
# contract additionally requires amountOutMin > 0 and enforces the floor
# with a balance difference, so a lying quote cannot under-deliver.
#
# Stale-quote refusal: the route is timestamped when fetched; if more than
# QUOTE_MAX_AGE_S (default 30s) elapse before the broadcast step, the runner
# refuses and re-fetches. Never broadcast a quote you paused on.
#
# Usage:
#   FEE_LIQUIDATOR=0x... TOKEN_IN=0x0b2C… ./scripts/consolidate-fee-dust.sh              # dry-run
#   FEE_LIQUIDATOR=0x... TOKEN_IN=0x0b2C… ./scripts/consolidate-fee-dust.sh --broadcast  # live
#
# Env:
#   FEE_LIQUIDATOR   deployed OphisFeeLiquidator (required)
#   TOKEN_IN         input dust token address (required; ERC20 only, native
#                    ETH is swept, not consolidated)
#   AMOUNT_IN        base units to consolidate (default: full Settlement balance)
#   TOKEN_OUT        output token (default: WETH 0x4200…0006, decision 53)
#   VENUE            venue router (default: KyberSwap MetaAggregationRouterV2)
#   SLIPPAGE_BPS     runner slippage, default 100, HARD CAP 100 (decision 54)
#   QUOTE_MAX_AGE_S  stale-quote refusal window, default 30
#   OPHIS_RPC / OPHIS_FEE_OPS_KEY_PATH  as in sweep-to-safe.sh

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
    --help|-h) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 3 ;;
  esac
done

RPC="${OPHIS_RPC:-http://localhost:4001/main/evm/10}"
PK_PATH="${OPHIS_FEE_OPS_KEY_PATH:-/Users/ophis-driver/.config/fee-ops.key}"

SETTLEMENT="0x310784c7FCE12d578dA6f53460777bAc9718B859"
FEE_LIQUIDATOR="${FEE_LIQUIDATOR:-}"
TOKEN_IN="${TOKEN_IN:-}"
TOKEN_OUT="${TOKEN_OUT:-0x4200000000000000000000000000000000000006}"  # WETH
# KyberSwap MetaAggregationRouterV2 (same address across chains, incl. OP).
VENUE="${VENUE:-0x6131B5fae19EA4f9D964eAc0408E4408b66337b5}"
SLIPPAGE_BPS="${SLIPPAGE_BPS:-100}"
QUOTE_MAX_AGE_S="${QUOTE_MAX_AGE_S:-30}"
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

echo "==> Fee-dust consolidation via OphisFeeLiquidator $FEE_LIQUIDATOR"

# --- pre-broadcast checks (read-only) ---

LIQ_SETTLEMENT="$(cast call "$FEE_LIQUIDATOR" "settlement()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call settlement() failed" >&2; exit 6; }
[[ "$(lc "$LIQ_SETTLEMENT")" == "$(lc "$SETTLEMENT")" ]] || {
  echo "ABORT: liquidator.settlement() = $LIQ_SETTLEMENT != pinned $SETTLEMENT" >&2; exit 6; }

VENUE_OK="$(cast call "$FEE_LIQUIDATOR" "venueAllowed(address)(bool)" "$VENUE" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call venueAllowed() failed" >&2; exit 6; }
[[ "$VENUE_OK" == "true" ]] || {
  echo "ABORT: venue $VENUE is NOT allowlisted on-chain." >&2
  echo "       Consolidation is not activated (decision 52 ships it disabled)." >&2
  echo "       Activation is an owner Safe tx: setVenue(venue, true), runbook §7." >&2
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

LIQ_EOA="$(cast call "$FEE_LIQUIDATOR" "liquidator()(address)" --rpc-url "$RPC")" \
  || { echo "ERROR: cast call liquidator() failed" >&2; exit 6; }
[[ "$(lc "$LIQ_EOA")" != "$(lc "$NATIVE")" ]] || {
  echo "ABORT: liquidator() is address(0), ops-key path is PAUSED." >&2; exit 6; }

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
# KyberSwap docs on first activation (runbook step), the shape below is the
# v1 Aggregator API as of 2026-07.

QUOTE_TS="$(date +%s)"
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

echo "    amountIn:     $AMOUNT_IN $TOKEN_IN"
echo "    quoted out:   $QUOTE_OUT $TOKEN_OUT"
echo "    amountOutMin: $AMOUNT_OUT_MIN (slippage ${SLIPPAGE_BPS} bps)"

INPUTS_ARG="[($TOKEN_IN,$AMOUNT_IN)]"
CONSOLIDATE_SIG="consolidate((address,uint256)[],address,uint256,address,bytes)"

if [[ "$BROADCAST" -eq 0 ]]; then
  echo "==> DRY-RUN (eth_call as the on-chain liquidator $LIQ_EOA)"
  cast call "$FEE_LIQUIDATOR" "$CONSOLIDATE_SIG" \
    "$INPUTS_ARG" "$TOKEN_OUT" "$AMOUNT_OUT_MIN" "$VENUE" "$VENUE_CALLDATA" \
    --from "$LIQ_EOA" --rpc-url "$RPC" >/dev/null \
    && echo "    simulation OK, rerun with --broadcast to send" \
    || { echo "    simulation REVERTED, inspect before broadcasting" >&2; exit 7; }
  exit 0
fi

echo "==> LIVE BROADCAST mode. Press Ctrl-C in next 5s to abort..."
sleep 5

# Stale-quote refusal: the operator pause above plus key loading must not
# push the quote past its freshness window.
NOW="$(date +%s)"
if (( NOW - QUOTE_TS > QUOTE_MAX_AGE_S )); then
  echo "ABORT: quote is $((NOW - QUOTE_TS))s old (> ${QUOTE_MAX_AGE_S}s). Re-run to re-fetch." >&2
  exit 9
fi

trap 'unset PK' EXIT INT TERM
if [[ ! -r "$PK_PATH" ]]; then
  PK=$(sudo -n cat "$PK_PATH" 2>/dev/null || true)
  [[ -z "$PK" ]] && { echo "ERROR: cannot read PK at $PK_PATH (need sudo?)" >&2; exit 4; }
else
  PK=$(cat "$PK_PATH")
fi
PK="${PK%$'\n'}"
[[ "$PK" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "ERROR: PK shape invalid (0x + 64 hex)." >&2; exit 5; }

# Key only ever reaches cast via ETH_PRIVATE_KEY env (argv leaks via ps).
SIGNER="$(ETH_PRIVATE_KEY="$PK" cast wallet address)"
[[ "$(lc "$SIGNER")" == "$(lc "$LIQ_EOA")" ]] || {
  echo "ABORT: key derives $SIGNER but liquidator() is $LIQ_EOA." >&2; exit 5; }

ETH_PRIVATE_KEY="$PK" cast send "$FEE_LIQUIDATOR" "$CONSOLIDATE_SIG" \
  "$INPUTS_ARG" "$TOKEN_OUT" "$AMOUNT_OUT_MIN" "$VENUE" "$VENUE_CALLDATA" \
  --rpc-url "$RPC"
echo "Consolidation tx submitted. Follow with a sweep to move the WETH to the Safe."
