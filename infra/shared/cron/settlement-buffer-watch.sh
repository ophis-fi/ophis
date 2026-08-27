#!/usr/bin/env bash
# Watch the CIP-75 fee buffer accumulating inside the three sovereign Settlement
# contracts, and page when a sweep would actually move something.
#
# Why this exists (2026-08-27 fee audit): on Optimism, Unichain and Robinhood
# Chain the partner fee reduces the user's buy amount but never transfers to the
# recipient. It accrues in Settlement, and as SweepSettlementBuffer.s.sol states
# outright, an unswept buffer is recycled into future traders' price improvement
# — functionally zero Ophis revenue. Every per-chain probe already existed and
# none of them was scheduled, so the buffers sat unmeasured from launch until an
# audit went looking. This is the scheduling and the alerting.
#
# What it alerts on:
#   1. A token at or above its SWEEP threshold — i.e. a sweep run right now
#      would actually move it. Deliberately not "> 0": the sweep script skips
#      sub-threshold tokens, so alerting below it would page about something no
#      runbook can act on, every five minutes, forever. An alert that fires
#      forever gets muted, and a muted alert is the same silence this fixes.
#   2. A token with NO configured threshold. An unrecognised token in the buffer
#      is exactly how value goes unnoticed; it surfaces rather than defaulting.
#   3. A probe that failed, exited non-zero, or emitted something unparseable.
#      Never read an unreachable RPC as an empty buffer — a monitor reporting
#      health it did not measure is worse than no monitor.
#
# Thresholds mirror contracts/script/SweepSettlementBuffer.s.sol per-token
# base-unit defaults, so this alarm and that action cannot drift apart. They are
# per token because a single wei threshold is decimals-blind: at 1e15 base units
# USDC (6 decimals) would need $1B before anyone was told (the HIGH-1 lesson).
#
# Deliberately NO price feed. Base-unit thresholds need no oracle, cannot go
# stale, and cannot fail closed in a cron on a Mac mini.
#
# Runbook: docs/operations/fee-treasury-ops-runbook.md
set -uo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x" >&2
  exit 2
fi

OPHIS_REPO="${OPHIS_REPO:-/Users/scep/greg}"
STATE_FILE="${BUFFER_STATE_FILE:-$HOME/.ophis-settlement-buffer-watch.state}"
LOG_FILE="${BUFFER_LOG_FILE:-}"
NOTIFY="${BUFFER_NOTIFY:-1}"
NOW_S="${BUFFER_NOW_S:-$(date -u +%s)}"
# Re-page at most daily for a condition that is already known. A sweepable
# buffer stays sweepable until a human signs, which can be days.
REPEAT_S="${BUFFER_REPEAT_S:-86400}"

TELEGRAM_BOT_TOKEN_FILE="${TELEGRAM_BOT_TOKEN_FILE:-/Users/scep/greg/infra/optimism-mainnet/observability-rendered/telegram-token}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-735726338}"

# chain-dir:label
CHAINS=(
  "optimism-mainnet:optimism"
  "unichain-mainnet:unichain"
  "robinhood-mainnet:robinhood"
)

# symbol:min-base-units — mirrors the sweep script's defaults.
#   6-decimal stables at 1e7  = $10
#   18-decimal WETH  at 3e15  = ~$7 (the sweep script's DEFAULT_MIN_WETH_BASE_UNITS)
#   8-decimal WBTC   at 1e4   = ~$10
#   18-decimal DAI   at 1e19  = $10   (exceeds int64, so all compares go through bc)
THRESHOLDS=(
  "USDC:10000000"
  "USDCe:10000000"
  "USDT:10000000"
  "USDG:10000000"
  "WETH:3000000000000000"
  "WBTC:10000"
  "DAI:10000000000000000000"
)

# Format an epoch as UTC. BSD date (the Mac mini, where this runs) wants -r;
# GNU date (CI, where the suite runs) wants -d @, and reads -r as "read this
# FILE's mtime" - so a BSD-only call does not error on Linux, it silently
# timestamps with something else. Try both, then fall back to now.
fmt_ts() {
  date -u -r "$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u -d "@$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  local line
  line="[$(fmt_ts "$NOW_S")] $*"
  echo "$line"
  [[ -n "$LOG_FILE" ]] && echo "$line" >> "$LOG_FILE"
  return 0
}

alert() {
  local msg="$1"
  log "ALERT: $msg"
  [[ "$NOTIFY" == "1" ]] || return 0
  local token
  token="$(< "$TELEGRAM_BOT_TOKEN_FILE")" 2>/dev/null || { log "WARN: no telegram token"; return 0; }
  curl -sm 10 -X POST \
    "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=<b>Ophis settlement buffer</b>%0A${msg}" \
    >/dev/null 2>&1 || log "WARN: telegram send failed"
  return 0
}

threshold_for() {
  local sym="$1" entry s v
  for entry in "${THRESHOLDS[@]}"; do
    IFS=: read -r s v <<< "$entry"
    if [[ "$s" == "$sym" ]]; then echo "$v"; return 0; fi
  done
  return 1
}

# Big-integer compare via bc: raw balances exceed what bash arithmetic can hold
# (1e19 > int64), and a silent wraparound here would read as "below threshold".
gte() { [[ "$(echo "$1 >= $2" | bc -l 2>/dev/null)" == "1" ]]; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 3; }
command -v bc >/dev/null 2>&1 || { echo "ERROR: bc required" >&2; exit 3; }

FINDINGS=()   # human-readable lines
KEYS=()       # stable identity of the condition, for repeat-suppression

for entry in "${CHAINS[@]}"; do
  IFS=: read -r dir label <<< "$entry"
  probe="$OPHIS_REPO/infra/$dir/scripts/check-settlement-buffer.sh"

  if [[ ! -x "$probe" ]]; then
    FINDINGS+=("$label: probe script missing at $probe")
    KEYS+=("$label/probe-missing")
    continue
  fi

  # A probe that dies must not be indistinguishable from a clean chain, and it
  # must not stop the other two from being measured.
  if ! raw_out="$("$probe" 2>&1)"; then
    FINDINGS+=("$label: probe FAILED (exit non-zero) - buffer state UNKNOWN, not clean")
    KEYS+=("$label/probe-exit")
    log "chain=$label probe exited non-zero"
    continue
  fi

  if ! report="$(jq -e . <<<"$raw_out" 2>/dev/null)"; then
    FINDINGS+=("$label: probe output was not a JSON report - buffer state UNKNOWN")
    KEYS+=("$label/probe-unparseable")
    log "chain=$label probe emitted unparseable output"
    continue
  fi

  failures="$(jq -r '.probe_failures // 0' <<<"$report")"
  if [[ "$failures" != "0" ]]; then
    FINDINGS+=("$label: $failures token probe(s) errored - those balances are UNKNOWN, not zero")
    KEYS+=("$label/probe-failures")
  fi

  while IFS=$'\t' read -r sym rawbal status; do
    [[ -z "$sym" ]] && continue
    [[ "$status" != "ok" ]] && continue   # already counted via probe_failures
    if ! thr="$(threshold_for "$sym")"; then
      FINDINGS+=("$label: $sym $rawbal base units has NO configured sweep threshold")
      KEYS+=("$label/$sym/unknown")
      continue
    fi
    if gte "$rawbal" "$thr"; then
      FINDINGS+=("$label: $sym $rawbal base units is at or above the $thr sweep threshold")
      KEYS+=("$label/$sym/sweepable")
    fi
  done < <(jq -r '.balances[]? | [.symbol, .raw, .status] | @tsv' <<<"$report")

  log "chain=$label measured"
done

STATE_KEY="$(printf '%s\n' "${KEYS[@]+"${KEYS[@]}"}" | sort | tr '\n' ',')"

if [[ ${#FINDINGS[@]} -eq 0 ]]; then
  # Clear the state so the next real finding pages immediately rather than
  # being suppressed by a stale window.
  rm -f "$STATE_FILE"
  log "all sovereign buffers below their sweep thresholds; pass complete"
  exit 0
fi

prev_key=""; prev_at=0
if [[ -f "$STATE_FILE" ]]; then
  IFS=$'\t' read -r prev_at prev_key < "$STATE_FILE" 2>/dev/null || true
fi

should_alert=1
if [[ "$STATE_KEY" == "$prev_key" ]]; then
  age=$(( NOW_S - ${prev_at:-0} ))
  (( age < REPEAT_S )) && should_alert=0
fi

if [[ "$should_alert" == "1" ]]; then
  body="$(printf '%s%%0A' "${FINDINGS[@]}")"
  alert "$body"
  printf '%s\t%s' "$NOW_S" "$STATE_KEY" > "$STATE_FILE"
else
  log "condition unchanged and inside the ${REPEAT_S}s repeat window; alert suppressed"
fi

log "pass complete (${#FINDINGS[@]} finding(s))"
