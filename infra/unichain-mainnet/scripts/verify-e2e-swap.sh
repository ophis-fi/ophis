#!/usr/bin/env bash
# End-to-end pipeline proof for one user-initiated swap.
#
# Run from infra/unichain-mainnet/ — the docker compose paths are relative.
#
# What it watches in parallel:
#   1. autopilot/driver/orderbook/solvers logs (live tail, prefixed)
#   2. Settlement contract on-chain events filtered by driver EOA
#
# Tip-lag (TIP_LAG_BLOCKS): eth_getLogs consensus fails within ~5 blocks of
# tip because not all upstream indexers have ingested the block yet. We scan
# slightly behind tip — adds ~10s latency to verification, doesn't matter.
#
# On Settlement found, decodes the receipt to verify:
#   - Trade event with `owner` matching --owner (the user's wallet)
#   - Transfer event to the partner-fee Safe (if fee-bearing)
#
# Exit codes:
#   0 = Settlement landed AND Trade event matched owner
#   1 = timeout (no Settlement within --timeout seconds)
#   2 = Settlement landed but no Trade for owner (different user filled?)
#   3 = bad args

set -euo pipefail
umask 077

OWNER=""
FROM_BLOCK=""
TIMEOUT_SEC=600
TIP_LAG_BLOCKS=5

SETTLEMENT_ADDR="0x108A678716e5E1776036eF044CAB7064226F714E"
DRIVER_EOA="0x7A956C269a12f1B897367663b536EB5dd29f3fBb"
PARTNER_FEE_SAFE="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"  # cross-chain Ophis fee Safe (same on 130)
RPC="${OPHIS_RPC:-http://localhost:4002/main/evm/130}"

SETTLEMENT_TOPIC="0x40338ce1a7c49204f0099533b1e9a7ee0a3d261f84974ab7af36105b8c4e9db4"
TRADE_TOPIC="0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17"
TRANSFER_TOPIC="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

usage() {
  cat <<EOF >&2
Usage: $0 --owner <0xUserWallet> [--from-block <N>] [--timeout <sec>]

Required:
  --owner ADDR        the user's wallet that signed the order on ophis.fi

Optional:
  --from-block N      start scanning from this OP block (default: current)
  --timeout SEC       give up after this many seconds (default: 600)

Env:
  OPHIS_RPC           override RPC endpoint (default: local eRPC at :4002)
EOF
  exit 3
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)      OWNER="$2"; shift 2 ;;
    --from-block) FROM_BLOCK="$2"; shift 2 ;;
    --timeout)    TIMEOUT_SEC="$2"; shift 2 ;;
    -h|--help)    usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

[[ -z "$OWNER" ]] && usage
# Validate arg shapes (audit 2026-05-20: codex + sharp-edges flagged
# unvalidated args producing silent false-negatives on malformed input).
[[ "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "ERROR: --owner must be 0x + 40 hex chars" >&2; exit 3; }
[[ -z "$FROM_BLOCK" || "$FROM_BLOCK" =~ ^[0-9]+$ ]] || { echo "ERROR: --from-block must be a positive integer" >&2; exit 3; }
[[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || { echo "ERROR: --timeout must be a positive integer (seconds)" >&2; exit 3; }
[[ "$RPC" =~ ^https?:// ]] || { echo "ERROR: \$OPHIS_RPC must be http(s):// URL" >&2; exit 3; }
command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) not in PATH" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq not in PATH" >&2; exit 3; }

# Topic-encode owner (left-pad to 32 bytes, lowercased)
OWNER_LC=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')
OWNER_TOPIC="0x000000000000000000000000${OWNER_LC#0x}"
SAFE_LC=$(echo "$PARTNER_FEE_SAFE" | tr '[:upper:]' '[:lower:]')
SAFE_TOPIC="0x000000000000000000000000${SAFE_LC#0x}"
DRIVER_LC=$(echo "$DRIVER_EOA" | tr '[:upper:]' '[:lower:]')
DRIVER_TOPIC="0x000000000000000000000000${DRIVER_LC#0x}"

if [[ -z "$FROM_BLOCK" ]]; then
  FROM_BLOCK=$(cast block-number --rpc-url "$RPC")
fi

cat <<EOF
════════════════════════════════════════════
  Ophis E2E Swap Verification
════════════════════════════════════════════
  Owner:            $OWNER
  From block:       $FROM_BLOCK
  Settlement:       $SETTLEMENT_ADDR
  Driver EOA:       $DRIVER_EOA
  Partner-fee Safe: $PARTNER_FEE_SAFE
  Timeout:          ${TIMEOUT_SEC}s
  RPC:              $RPC
════════════════════════════════════════════
EOF

# Live log tail. Capture PID so cleanup kills the subprocess.
TAIL_PID=""
cleanup() {
  [[ -n "$TAIL_PID" ]] && kill "$TAIL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

docker compose logs --since 1s -f \
  autopilot driver orderbook okx-solver kyberswap-solver velora-solver 2>&1 &
TAIL_PID=$!

verify_receipt() {
  local tx="$1"
  local receipt
  receipt=$(cast receipt "$tx" --rpc-url "$RPC" --json 2>/dev/null || echo '{}')

  local owner_match
  owner_match=$(echo "$receipt" \
    | jq --arg t "$TRADE_TOPIC" --arg o "$OWNER_TOPIC" \
        '[.logs[]? | select((.topics[0] // "") | ascii_downcase == ($t | ascii_downcase))
                   | select((.topics[1] // "") | ascii_downcase == ($o | ascii_downcase))] | length')

  local fee_transfers
  fee_transfers=$(echo "$receipt" \
    | jq --arg t "$TRANSFER_TOPIC" --arg s "$SAFE_TOPIC" \
        '[.logs[]? | select((.topics[0] // "") | ascii_downcase == ($t | ascii_downcase))
                   | select((.topics[2] // "") | ascii_downcase == ($s | ascii_downcase))] | length')

  local block gas_used
  block=$(echo "$receipt" | jq -r '.blockNumber // "?"')
  gas_used=$(echo "$receipt" | jq -r '.gasUsed // "?"')

  echo "  Block:                    $block"
  echo "  Gas used:                 $gas_used"
  echo "  Trade events for owner:   $owner_match"
  echo "  Transfer→partner-fee:     $fee_transfers"
  echo ""

  if [[ "$owner_match" == "0" ]]; then
    echo "⚠️  Settlement landed but no Trade event for $OWNER."
    echo "    Pipeline works, but this batch did NOT include your order."
    echo "    (Possible: your order is still pending in a future auction.)"
    return 2
  fi

  echo "✅ END-TO-END VERIFIED"
  echo "    Order from $OWNER landed in tx $tx (block $block)"
  if [[ "$fee_transfers" != "0" ]]; then
    echo "    Partner-fee accrued to Safe ✓"
  else
    echo "    No partner-fee in this batch (sub-threshold or pure routing)"
  fi
  return 0
}

start=$(date +%s)
latest=$FROM_BLOCK

while true; do
  now=$(date +%s)
  elapsed=$((now - start))
  if (( elapsed > TIMEOUT_SEC )); then
    echo ""
    echo "❌ TIMEOUT after ${TIMEOUT_SEC}s. No Settlement event for driver EOA."
    exit 1
  fi

  # Scan up to (tip - TIP_LAG_BLOCKS) — see header comment on tip-lag.
  tip=$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo "$latest")
  current=$((tip - TIP_LAG_BLOCKS))
  if (( current > latest )); then
    logs_json=$(cast rpc eth_getLogs --rpc-url "$RPC" "$(jq -c -n \
      --arg from "$(printf '0x%x' "$latest")" \
      --arg to   "$(printf '0x%x' "$current")" \
      --arg addr "$SETTLEMENT_ADDR" \
      --arg t0   "$SETTLEMENT_TOPIC" \
      --arg t1   "$DRIVER_TOPIC" \
      '{fromBlock:$from, toBlock:$to, address:$addr, topics:[$t0, $t1]}')" 2>/dev/null || echo '[]')

    tx_count=$(echo "$logs_json" | jq 'length // 0' 2>/dev/null || echo 0)
    if [[ "$tx_count" -gt 0 ]]; then
      echo ""
      echo "════════════════════════════════════════════"
      echo "  ✓ SETTLEMENT EVENT DETECTED ($tx_count this scan)"
      echo "════════════════════════════════════════════"
      # Process each (newest first usually doesn't matter — verify all)
      mapfile -t tx_hashes < <(echo "$logs_json" | jq -r '.[].transactionHash')
      final_rc=2
      for tx in "${tx_hashes[@]}"; do
        echo "  Tx: $tx"
        if verify_receipt "$tx"; then
          final_rc=0
        fi
      done
      exit "$final_rc"
    fi
    latest=$current
  fi
  sleep 3
done
