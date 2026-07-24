#!/usr/bin/env bash
# Settlement anomaly watcher (#444) — Ophis Robinhood mainnet (chain 4663).
#
# READ-ONLY on-chain detection. Scans new blocks for GPv2Settlement activity and
# alerts (Telegram) on the bounded backend worst case: quiet surplus/MEV skimming
# or settle() from an unexpected party. NO signing, NO state changes — only
# `cast block-number/balance/logs/tx/abi-decode`.
#
# Acceptance (#444):
#   (a) price/surplus bounds  -> oracle-free fee/sell ratio per Trade (skim proxy)
#   (b) unexpected solver/target -> Settlement-event solver + settle() tx from/to
#   (c) submitter-EOA health  -> balance floor
#
# Run every ~60s via launchd (infra/shared/cron/ai.ophis.settlement-anomaly-watch.plist).
# Mirrors safe-drift-check.sh.tmpl (alert/token-file) + check-settlement-buffer.sh (cast).
set -euo pipefail
umask 077
[[ "${-}" == *x* ]] && { echo "REFUSING to run under set -x (secret hygiene)" >&2; exit 2; }

RPC="${OPHIS_RPC:-http://localhost:4003/main/evm/4663}"
SETTLEMENT="__FILL_AFTER_DEPLOY_SETTLEMENT__"
SUBMITTER="__FILL_AFTER_DEPLOY_SUBMITTER_EOA__"   # the ONLY authorized solver/submitter EOA
TRADE_TOPIC0="0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17"
SETTLEMENT_TOPIC0="0x40338ce1a7c49204f0099533b1e9a7ee0a3d261f84974ab7af36105b8c4e9db4"
# Tunables (env-overridable). Conservative defaults to avoid alert fatigue.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BALANCE_FLOOR_WEI="${BALANCE_FLOOR_WEI:-5000000000000000}"  # 0.005 ETH (matches driver min-balance posture)
FEE_BPS_MAX="${FEE_BPS_MAX:-500}"                            # fee > 5% of sell within the same token = skim signal
MAX_BLOCKS="${MAX_BLOCKS:-5000}"                             # per-run catch-up cap
TIP_LAG_BLOCKS="${TIP_LAG_BLOCKS:-8}"                         # stay behind head: fresh blocks fail eRPC consensus while indexers catch up
FIRST_RUN_LOOKBACK="${FIRST_RUN_LOOKBACK:-50}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/ophis/settlement-watch}"
CURSOR="$STATE_DIR/uni-cursor"
LOGFILE="${LOGFILE:-$HOME/Library/Logs/ophis-settlement-anomaly-watch.log}"
TELEGRAM_BOT_TOKEN_FILE="${TELEGRAM_BOT_TOKEN_FILE:-observability-rendered/telegram-token}"
case "$TELEGRAM_BOT_TOKEN_FILE" in
  /*) ;;
  *) TELEGRAM_BOT_TOKEN_FILE="$STACK_DIR/$TELEGRAM_BOT_TOKEN_FILE" ;;
esac
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-735726338}"

command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) required" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 3; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required (big-int fee math)" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl required (Telegram alerts)" >&2; exit 3; }
mkdir -p "$STATE_DIR"

lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }   # bash-3.2-safe lowercase (hex only)
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGFILE" >&2; }
alert() {  # alert <SEVERITY> <message>
  log "ALERT[$1] $2"
  [[ -r "$TELEGRAM_BOT_TOKEN_FILE" ]] || { log "ERROR: telegram token file unreadable; alert not delivered: $TELEGRAM_BOT_TOKEN_FILE"; return 1; }
  [[ -s "$TELEGRAM_BOT_TOKEN_FILE" ]] || { log "ERROR: telegram token file empty; alert not delivered: $TELEGRAM_BOT_TOKEN_FILE"; return 1; }
  local token
  token="$(< "$TELEGRAM_BOT_TOKEN_FILE")" || { log "ERROR: telegram token file read failed; alert not delivered: $TELEGRAM_BOT_TOKEN_FILE"; return 1; }
  curl -sm 10 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=[$1] Ophis Robinhood settlement-watch: $2" >/dev/null 2>&1 \
    || { log "ERROR: telegram send failed"; return 1; }
}
die() { log "ERROR: $1"; exit "${2:-4}"; }   # exit WITHOUT advancing the cursor -> the window is re-scanned next run
critical_alert() { alert CRITICAL "$1" || die "critical alert delivery failed; cursor not advanced"; }
warning_alert() { alert WARNING "$1" || log "WARN: warning alert delivery failed"; }

[[ -r "$TELEGRAM_BOT_TOKEN_FILE" ]] || die "telegram token file unreadable: $TELEGRAM_BOT_TOKEN_FILE. Run ./render-configs.sh or set TELEGRAM_BOT_TOKEN_FILE."
[[ -s "$TELEGRAM_BOT_TOKEN_FILE" ]] || die "telegram token file empty: $TELEGRAM_BOT_TOKEN_FILE. Re-run ./render-configs.sh or set TELEGRAM_BOT_TOKEN_FILE."

SUBMITTER_LC="$(lc "$SUBMITTER")"; SETTLEMENT_LC="$(lc "$SETTLEMENT")"

HEAD="$(cast block-number --rpc-url "$RPC" 2>&1)" || die "cast block-number: $HEAD"
[[ "$HEAD" =~ ^[0-9]+$ ]] || die "non-numeric head: $HEAD"
# Stay TIP_LAG_BLOCKS behind head: the freshest blocks fail eRPC 3-of-4 consensus
# (eth_getLogs) while upstream indexers catch up, so scanning to head would `die`
# every run and never advance the cursor (mirrors verify-e2e-swap.sh's TIP_LAG).
SAFE_HEAD=$(( HEAD - TIP_LAG_BLOCKS )); (( SAFE_HEAD < 0 )) && SAFE_HEAD=0
if [[ -r "$CURSOR" ]]; then FROM=$(( $(cat "$CURSOR") + 1 )); else FROM=$(( SAFE_HEAD - FIRST_RUN_LOOKBACK )); fi
(( FROM < 0 )) && FROM=0
if (( FROM > SAFE_HEAD )); then log "waiting for tip lag (next $FROM > safe_head $SAFE_HEAD, head $HEAD)"; exit 0; fi
TO=$(( FROM + MAX_BLOCKS - 1 )); (( TO > SAFE_HEAD )) && TO=$SAFE_HEAD

# (c) submitter-EOA health — NEVER substitute 0 on RPC failure (check-settlement-buffer.sh lesson).
BAL="$(cast balance "$SUBMITTER" --rpc-url "$RPC" 2>&1)" || die "cast balance: $BAL"
[[ "$BAL" =~ ^[0-9]+$ ]] || die "non-numeric balance: $BAL"
(( BAL < BALANCE_FLOOR_WEI )) && critical_alert "submitter $SUBMITTER balance $(cast from-wei "$BAL") ETH below floor $(cast from-wei "$BALANCE_FLOOR_WEI") ETH"

# (b) unexpected solver/target — every Settlement completion must be our EOA.
SETT="$(cast logs --rpc-url "$RPC" --from-block "$FROM" --to-block "$TO" --address "$SETTLEMENT" "$SETTLEMENT_TOPIC0" --json 2>&1)" \
  || die "cast logs (Settlement): $SETT"
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  solver_topic="$(printf '%s' "$entry" | jq -r '.topics[1] // empty')"
  txh="$(printf '%s' "$entry" | jq -r '.transactionHash // empty')"
  [[ -z "$solver_topic" || -z "$txh" ]] && continue
  solver_lc="$(lc "0x${solver_topic: -40}")"
  if [[ "$solver_lc" != "$SUBMITTER_LC" ]]; then
    critical_alert "settlement by UNEXPECTED solver 0x${solver_topic: -40} (expected $SUBMITTER) in tx $txh"; continue
  fi
  # Fail CLOSED: a cast tx failure must NOT silently skip from/to validation and
  # let the cursor advance — die so the window is rescanned (like balance/logs).
  txfrom="$(cast tx "$txh" from --rpc-url "$RPC" 2>&1)" || die "cast tx from $txh (rescanning): $txfrom"
  txto="$(cast tx "$txh" to --rpc-url "$RPC" 2>&1)" || die "cast tx to $txh (rescanning): $txto"
  [[ "$(lc "$txfrom")" != "$SUBMITTER_LC" ]] && critical_alert "settle() tx $txh sent by UNEXPECTED $txfrom (expected $SUBMITTER)"
  [[ "$(lc "$txto")"   != "$SETTLEMENT_LC" ]] && critical_alert "settle() tx $txh to UNEXPECTED target $txto (expected Settlement)"
done < <(printf '%s' "$SETT" | jq -c '.[]?' 2>/dev/null)

# (a) surplus-skim proxy — fee as bps of sell, within the SAME token (no price
# oracle, so legitimate slippage cannot trigger a false positive).
TRADES="$(cast logs --rpc-url "$RPC" --from-block "$FROM" --to-block "$TO" --address "$SETTLEMENT" "$TRADE_TOPIC0" --json 2>&1)" \
  || die "cast logs (Trade): $TRADES"
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  data="$(printf '%s' "$entry" | jq -r '.data // empty')"
  txh="$(printf '%s' "$entry" | jq -r '.transactionHash // empty')"
  [[ -z "$data" || "$data" == "0x" ]] && continue
  decoded="$(cast abi-decode "trade()(address,address,uint256,uint256,uint256,bytes)" "$data" 2>/dev/null || true)"
  [[ -z "$decoded" ]] && continue
  sell="$(printf '%s' "$decoded" | sed -n '3p' | awk '{print $1}')"
  fee="$(printf '%s' "$decoded" | sed -n '5p' | awk '{print $1}')"
  [[ "$sell" =~ ^[0-9]+$ && "$fee" =~ ^[0-9]+$ ]] || continue
  (( sell == 0 )) && continue
  # bash arithmetic is signed 64-bit; fee*10000 overflows for 18-decimal tokens
  # (fee above ~0.0009 ETH), wrapping to a tiny/negative bps and silently missing
  # the alert. Use python big-ints (fee/sell are regex-validated integers).
  bps="$(python3 -c "import sys; s=int(sys.argv[2]); print(int(sys.argv[1])*10000//s if s else 0)" "$fee" "$sell" 2>/dev/null)"
  [[ "$bps" =~ ^[0-9]+$ ]] && (( bps > FEE_BPS_MAX )) && warning_alert "Trade in tx $txh: fee ${bps}bps of sell (> ${FEE_BPS_MAX}bps) — possible surplus skim"
done < <(printf '%s' "$TRADES" | jq -c '.[]?' 2>/dev/null)

echo "$TO" > "$CURSOR"   # advance only after a fully clean pass
log "ok scanned [$FROM,$TO] head=$HEAD submitter_balance=$(cast from-wei "$BAL")ETH"
