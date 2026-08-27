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

# Per-chain sweep coverage: "symbol:min-base-units", mirroring each chain's OWN
# sweep-to-safe.sh defaults. PER CHAIN because they genuinely differ - unichain
# defaults WETH to 1e15 while optimism and robinhood default it to 3e15, so a
# single shared table left a unichain balance between the two sweepable by the
# stock script and invisible to this monitor. That is precisely the alarm/action
# drift this job claims cannot happen.
#
# A symbol a chain's probe reports but this table does NOT list is value the stock
# sweep would not move. It is reported as "not covered", because a token nobody
# configured is exactly how a balance grows unnoticed - which is the whole reason
# this file exists.
#
# Sources: infra/<chain>/scripts/sweep-to-safe.sh
#   optimism  TOKEN_LIST=(USDC WETH native)  MIN_LIST=(1e7 3e15 3e15)
#   unichain  TOKENS=(WETH USDC)             MIN_BASE_UNITS=(1e15 1e7)
#   robinhood TOKENS=(USDG WETH)             MIN_BASE_UNITS=(1e7 3e15)
# One flat chain:symbol:min-base-units list rather than a per-chain array plus a
# nameref. macOS ships bash 3.2 and namerefs are 4.3+, so the array-per-chain form
# fails on the Mac mini this cron actually runs on while passing in CI on bash 5 -
# the worst possible split, since CI would have certified it green.
THRESHOLDS=(
  "optimism:USDC:10000000"
  "optimism:WETH:3000000000000000"
  "optimism:ETH:3000000000000000"
  "unichain:WETH:1000000000000000"
  "unichain:USDC:10000000"
  "robinhood:USDG:10000000"
  "robinhood:WETH:3000000000000000"
)

log() {
  local line
  line="[$(fmt_ts "$NOW_S")] $*"
  echo "$line"
  [[ -n "$LOG_FILE" ]] && echo "$line" >> "$LOG_FILE"
  return 0
}

# Returns 0 only when the page was actually DELIVERED. The caller records the
# repeat-suppression state from this, so a failed send is retried next run rather
# than muting a live condition for 24h on the strength of a page nobody received.
# NOTIFY=0 is log-only mode, where the log IS the delivery.
alert() {
  local msg="$1"
  log "ALERT: $msg"
  [[ "$NOTIFY" == "1" ]] || return 0
  local token
  if ! token="$(< "$TELEGRAM_BOT_TOKEN_FILE")" 2>/dev/null || [[ -z "$token" ]]; then
    log "WARN: no telegram token; alert NOT delivered"
    return 1
  fi
  # --fail is what makes an HTTP error (a revoked token returns 401 with a JSON
  # body) an actual failure. Without it curl exits 0 on any response it received,
  # so a dead bot token would look like successful delivery forever.
  if curl -sm 10 --fail -X POST \
    "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=<b>Ophis settlement buffer</b>%0A${msg}" \
    >/dev/null 2>&1; then
    return 0
  fi
  log "WARN: telegram send failed; alert NOT delivered"
  return 1
}

# Resolve a chain's threshold for a symbol. Returns 1 when the chain's sweep
# configuration does not cover that token at all.
threshold_for() {
  local label="$1" sym="$2" entry c t v
  for entry in "${THRESHOLDS[@]}"; do
    IFS=: read -r c t v <<< "$entry"
    if [[ "$c" == "$label" && "$t" == "$sym" ]]; then echo "$v"; return 0; fi
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

  # Syntactic JSON is not a report. `{}` parses fine, then probe_failures defaults
  # to 0 and balances defaults to no rows, and the chain sails through as "measured"
  # with a clean pass - recreating the silent-monitoring failure this job exists to
  # end. Require the shape, and require that it actually measured something.
  if ! jq -e 'has("probe_failures") and (.balances | type == "array")' <<<"$report" >/dev/null 2>&1; then
    FINDINGS+=("$label: probe report is missing probe_failures or balances - buffer state UNKNOWN")
    KEYS+=("$label/probe-schema")
    log "chain=$label probe report failed schema validation"
    continue
  fi
  if [[ "$(jq -r '.balances | length' <<<"$report")" == "0" ]]; then
    FINDINGS+=("$label: probe returned ZERO balance rows - it measured nothing, buffer state UNKNOWN")
    KEYS+=("$label/probe-empty")
    log "chain=$label probe returned no balance rows"
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
    if ! thr="$(threshold_for "$label" "$sym")"; then
      # Only report a token the sweep cannot move if there is actually something
      # there; a zero balance in an unconfigured token is not news.
      if gte "$rawbal" "1"; then
        FINDINGS+=("$label: $sym $rawbal base units is not covered by the chain's sweep configuration")
        KEYS+=("$label/$sym/uncovered")
      fi
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
  # Record the suppression state ONLY on confirmed delivery. Writing it
  # unconditionally muted a live condition for 24h on the strength of a page that
  # may never have been sent - a silent alert is the failure mode, not the fix.
  if alert "$body"; then
    printf '%s\t%s' "$NOW_S" "$STATE_KEY" > "$STATE_FILE"
  else
    log "alert delivery FAILED; not recording suppression state, will retry next run"
  fi
else
  log "condition unchanged and inside the ${REPEAT_S}s repeat window; alert suppressed"
fi

log "pass complete (${#FINDINGS[@]} finding(s))"
