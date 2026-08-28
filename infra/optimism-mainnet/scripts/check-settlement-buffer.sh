#!/usr/bin/env bash
# Probe the Settlement contract's accumulated buffer for the tokens we
# care about (USDC, WETH, etc.). Outputs JSON suitable for Prometheus
# pushgateway OR alerting via Telegram.
#
# Background: CIP-75 partner-fees accumulate in the Settlement contract
# rather than transferring atomically to the configured recipient Safe.
# The accumulated balance funds subsequent traders' price improvements,
# but for Ophis we want to track it as a proxy for "revenue if we ever
# add a sweep". See docs/audits/2026-05-20-cip75-partner-fee-bypass.md.
#
# Run via cron or systemd timer. Default: every 5 minutes.

set -euo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x" >&2
  exit 2
fi

RPC="${OPHIS_RPC:-http://localhost:4001/main/evm/10}"
SETTLEMENT="0x310784c7FCE12d578dA6f53460777bAc9718B859"
SAFE="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
# Fee-ops: deployed OphisFeeLiquidator. Empty = pre-deployment (liquidator
# block reports "unset"). Set in the same release as the first sweep.
FEE_LIQUIDATOR="${FEE_LIQUIDATOR:-}"

# token:symbol:decimals
TOKENS=(
  "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85:USDC:6"
  "0x4200000000000000000000000000000000000006:WETH:18"
  "0x7F5c764cBc14f9669B88837ca1490cCa17c31607:USDCe:6"
  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1:DAI:18"
  "0x68f180fcCe6836688e9084f035309E29Bf0A2095:WBTC:8"
  # USDT was missing while a real USDT balance sat in the buffer (2026-08-27
  # audit found 0.032961). An asset nobody probes is an asset that can grow
  # indefinitely while every monitoring run reports a clean pass.
  "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58:USDT:6"
)

command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) required" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 3; }
command -v bc   >/dev/null 2>&1 || { echo "ERROR: bc required" >&2; exit 3; }

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESULTS_JSON='[]'
PROBE_FAILURES=0

for entry in "${TOKENS[@]}"; do
  IFS=: read -r token sym dec <<< "$entry"

  # Audit (codex + sharp-edges 2026-05-20): never silently substitute 0
  # when the RPC fails. A monitoring tool that reports "$0 in buffer"
  # while the RPC is unreachable is worse than no monitoring — it
  # falsely reassures during exactly the incident where you need
  # accurate state. Capture cast's exit code; surface "error" status
  # in JSON so downstream alerts can branch on probe staleness.
  if cast_output=$(cast call --rpc-url "$RPC" "$token" "balanceOf(address)(uint256)" "$SETTLEMENT" 2>&1); then
    bal=$(echo "$cast_output" | awk '{print $1}')
    [[ -z "$bal" ]] && bal=0
    status="ok"
  else
    bal=0
    status="error"
    PROBE_FAILURES=$((PROBE_FAILURES + 1))
  fi

  if [[ "$bal" == "0" ]]; then
    bal_hr="0"
  else
    bal_hr=$(echo "scale=6; $bal / (10 ^ $dec)" | bc -l)
  fi

  RESULTS_JSON=$(echo "$RESULTS_JSON" | jq \
    --arg sym "$sym" --arg token "$token" --arg raw "$bal" --arg hr "$bal_hr" --arg status "$status" \
    '. + [{symbol: $sym, token: $token, raw: $raw, hr: $hr, status: $status}]')
done

# Native ETH. The sweep's default TOKEN_LIST includes native (its HIGH-3 fix:
# Settlement has an open receive() and accrues ETH from sequencer-fee refunds and
# direct-buy 0xEee orders), so omitting it here would leave one of the three assets
# the sweep actually moves invisible to monitoring. Same never-silently-zero rule
# as the ERC20 probes: an RPC failure is status "error", never a fake 0.
if native_out=$(cast balance "$SETTLEMENT" --rpc-url "$RPC" 2>&1); then
  native_bal=$(echo "$native_out" | awk '{print $1}')
  [[ -z "$native_bal" ]] && native_bal=0
  native_status="ok"
else
  native_bal=0
  native_status="error"
  PROBE_FAILURES=$((PROBE_FAILURES + 1))
fi
if [[ "$native_bal" == "0" ]]; then native_hr="0"; else native_hr=$(echo "scale=6; $native_bal / (10 ^ 18)" | bc -l); fi
RESULTS_JSON=$(echo "$RESULTS_JSON" | jq \
  --arg sym "ETH" --arg token "native" --arg raw "$native_bal" --arg hr "$native_hr" --arg status "$native_status" \
  '. + [{symbol: $sym, token: $token, raw: $raw, hr: $hr, status: $status}]')

# The chain the balances actually came from (see the v1 probes for why).
CHAIN_ID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || echo "unknown")

# Fee-ops liquidator probe: solver status, current ops key, and the age of
# the last successful sweep (lastSweepAt is set on-chain by every sweep).
# Same never-silently-zero rule as the balance probes: RPC failure surfaces
# as status "error", never as fake data.
LIQ_JSON='{"address": null, "status": "unset"}'
if [[ -n "$FEE_LIQUIDATOR" ]]; then
  NOW_EPOCH=$(date -u +%s)
  if is_solver=$(cast call "$SETTLEMENT" "authenticator()(address)" --rpc-url "$RPC" 2>/dev/null \
       | xargs -I{} cast call {} "isSolver(address)(bool)" "$FEE_LIQUIDATOR" --rpc-url "$RPC" 2>/dev/null) \
     && liq_eoa=$(cast call "$FEE_LIQUIDATOR" "liquidator()(address)" --rpc-url "$RPC" 2>/dev/null) \
     && last_sweep=$(cast call "$FEE_LIQUIDATOR" "lastSweepAt()(uint256)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'); then
    if [[ "$last_sweep" =~ ^[0-9]+$ && "$last_sweep" != "0" ]]; then
      sweep_age=$((NOW_EPOCH - last_sweep))
    else
      sweep_age=null
      last_sweep=null
    fi
    LIQ_JSON=$(jq -nc \
      --arg addr "$FEE_LIQUIDATOR" --arg solver "$is_solver" --arg eoa "$liq_eoa" \
      --argjson last "$last_sweep" --argjson age "$sweep_age" \
      '{address: $addr, status: "ok", is_solver: ($solver == "true"),
        ops_eoa: $eoa, last_sweep_at: $last, last_sweep_age_s: $age}')
  else
    LIQ_JSON=$(jq -nc --arg addr "$FEE_LIQUIDATOR" '{address: $addr, status: "error"}')
    PROBE_FAILURES=$((PROBE_FAILURES + 1))
  fi
fi

cat <<EOF
{
  "ts": "$TS",
  "settlement": "$SETTLEMENT",
  "chain_id": "$CHAIN_ID",
  "safe": "$SAFE",
  "liquidator": $LIQ_JSON,
  "probe_failures": $PROBE_FAILURES,
  "balances": $RESULTS_JSON
}
EOF

# Optional: post to Prometheus pushgateway if URL provided
if [[ -n "${PUSHGATEWAY_URL:-}" ]]; then
  for row in $(echo "$RESULTS_JSON" | jq -c '.[]'); do
    sym=$(echo "$row" | jq -r '.symbol')
    raw=$(echo "$row" | jq -r '.raw')
    status=$(echo "$row" | jq -r '.status')
    # Only push successful probes as the buffer-raw metric; emit a
    # separate failures counter so Prometheus can alert on probe
    # staleness (audit follow-up 2026-05-20).
    if [[ "$status" == "ok" ]]; then
      curl -s --data "ophis_settlement_buffer_raw{symbol=\"$sym\",chain=\"optimism\"} $raw" \
        "$PUSHGATEWAY_URL/metrics/job/settlement-buffer/instance/ophis-op" >/dev/null || true
    fi
  done
  curl -s --data "ophis_settlement_buffer_probe_failures{chain=\"optimism\"} $PROBE_FAILURES" \
    "$PUSHGATEWAY_URL/metrics/job/settlement-buffer/instance/ophis-op" >/dev/null || true
  # Fee-ops: sweep staleness (only when the probe succeeded and a sweep
  # has ever happened; never push a fake 0 age).
  sweep_age_metric=$(echo "$LIQ_JSON" | jq -r 'select(.status == "ok") | .last_sweep_age_s // empty')
  if [[ -n "$sweep_age_metric" && "$sweep_age_metric" != "null" ]]; then
    curl -s --data "ophis_fee_liquidator_last_sweep_age_seconds{chain=\"optimism\"} $sweep_age_metric" \
      "$PUSHGATEWAY_URL/metrics/job/settlement-buffer/instance/ophis-op" >/dev/null || true
  fi
fi
