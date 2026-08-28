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

RPC="${OPHIS_RPC:-http://localhost:4002/main/evm/130}"
# Unichain (130) Ophis settlement - NOT the OP one (0x310784c7...B859); this
# script previously carried the OP address by copy-paste, silently monitoring
# the wrong contract's buffer.
SETTLEMENT="0x108A678716e5E1776036eF044CAB7064226F714E"
SAFE="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"

# token:symbol:decimals - UNICHAIN canonical tokens (the previous list was
# the OP token set, copy-pasted with the OP settlement address; fees can only
# accrue in tokens the driver actually trades, per configs/baseline.toml.tmpl).
TOKENS=(
  "0x4200000000000000000000000000000000000006:WETH:18"
  "0x078d782b760474a361dda0af3839290b0ef57ad6:USDC:6"
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

# Native ETH. The shared SweepSettlementBuffer.s.sol sweeps the Settlement's
# native balance at MIN_ETH_WEI (3e15) INDEPENDENTLY of the TOKENS list, so a
# probe that reports only ERC20s leaves an asset the stock sweep would move
# completely unmonitored. Same never-silently-zero rule as the ERC20 probes.
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

# The chain the balances actually came from. A miswired local proxy pointing at a
# fork or another network answers balanceOf happily, and the Settlement address in
# this report is a static label - so without this the watcher would validate the
# label rather than the network that supplied the numbers.
CHAIN_ID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || echo "unknown")

cat <<EOF
{
  "ts": "$TS",
  "settlement": "$SETTLEMENT",
  "chain_id": "$CHAIN_ID",
  "safe": "$SAFE",
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
      curl -s --data "ophis_settlement_buffer_raw{symbol=\"$sym\",chain=\"unichain\"} $raw" \
        "$PUSHGATEWAY_URL/metrics/job/settlement-buffer/instance/ophis-unichain" >/dev/null || true
    fi
  done
  curl -s --data "ophis_settlement_buffer_probe_failures{chain=\"unichain\"} $PROBE_FAILURES" \
    "$PUSHGATEWAY_URL/metrics/job/settlement-buffer/instance/ophis-unichain" >/dev/null || true
fi
