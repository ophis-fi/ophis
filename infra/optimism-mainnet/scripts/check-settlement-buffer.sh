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

# token:symbol:decimals
TOKENS=(
  "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85:USDC:6"
  "0x4200000000000000000000000000000000000006:WETH:18"
  "0x7F5c764cBc14f9669B88837ca1490cCa17c31607:USDCe:6"
  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1:DAI:18"
  "0x68f180fcCe6836688e9084f035309E29Bf0A2095:WBTC:8"
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

cat <<EOF
{
  "ts": "$TS",
  "settlement": "$SETTLEMENT",
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
      curl -s --data "ophis_settlement_buffer_raw{symbol=\"$sym\",chain=\"optimism\"} $raw" \
        "$PUSHGATEWAY_URL/metrics/job/settlement-buffer/instance/ophis-op" >/dev/null || true
    fi
  done
  curl -s --data "ophis_settlement_buffer_probe_failures{chain=\"optimism\"} $PROBE_FAILURES" \
    "$PUSHGATEWAY_URL/metrics/job/settlement-buffer/instance/ophis-op" >/dev/null || true
fi
