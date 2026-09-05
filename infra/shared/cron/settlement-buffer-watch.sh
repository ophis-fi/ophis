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
# ${HOME:-...} not $HOME: under `set -u` an unset HOME aborts the script on this
# very line, before a single probe, log or alert runs - a monitor that is installed,
# enabled, and completely inert. launchd jobs are not guaranteed a HOME, so the
# plist also pins BUFFER_STATE_FILE explicitly; this default is the backstop.
STATE_FILE="${BUFFER_STATE_FILE:-${HOME:-/var/tmp}/.ophis-settlement-buffer-watch.state}"
LOG_FILE="${BUFFER_LOG_FILE:-}"
NOTIFY="${BUFFER_NOTIFY:-1}"
NOW_S="${BUFFER_NOW_S:-$(date -u +%s)}"
# Re-page at most daily for a condition that is already known. A sweepable
# buffer stays sweepable until a human signs, which can be days.
REPEAT_S="${BUFFER_REPEAT_S:-86400}"

TELEGRAM_BOT_TOKEN_FILE="${TELEGRAM_BOT_TOKEN_FILE:-/Users/scep/greg/infra/optimism-mainnet/observability-rendered/telegram-token}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-735726338}"

# chain-dir:label:expected-settlement
CHAINS=(
  "optimism-mainnet:optimism:0x310784c7fce12d578da6f53460777bac9718b859"
  "unichain-mainnet:unichain:0x108a678716e5e1776036ef044cab7064226f714e"
  "robinhood-mainnet:robinhood:0x886d9fd312f442c4e1f3cdeae7b4ab73493e57cd"
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
# Native ETH is listed for EVERY chain at MIN_ETH_WEI (3e15): the shared
# SweepSettlementBuffer.s.sol sweeps the Settlement's native balance regardless of
# the TOKENS list, so leaving it out left an asset the stock sweep moves entirely
# unmonitored on the two v1 chains.
# One flat chain:symbol:min-base-units list rather than a per-chain array plus a
# nameref. macOS ships bash 3.2 and namerefs are 4.3+, so the array-per-chain form
# fails on the Mac mini this cron actually runs on while passing in CI on bash 5 -
# the worst possible split, since CI would have certified it green.
# Every symbol each chain's probe is expected to report. A report that is merely
# NON-EMPTY is not a complete measurement: an optimism probe returning only a
# successful USDC row passes a length>0 check while WETH, native ETH and USDT
# silently vanish - the same "reported health it did not measure" failure the
# zero-row guard was added for, one layer up. Keep in sync with each probe's
# TOKENS array (plus the native row where the probe emits one).
# Expected token ADDRESSES per chain, not symbols. An impersonator carrying a
# canonical symbol and a zero balance would satisfy a symbol-keyed completeness
# check, then fail the address-keyed threshold lookup and fall into the uncovered
# branch - which stays silent at zero balance. Net effect: a clean pass while the
# real asset was never measured. Keyed by address, that cannot happen.
EXPECTED_ADDRS=(
  "optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85 0x4200000000000000000000000000000000000006 0x7f5c764cbc14f9669b88837ca1490cca17c31607 0xda10009cbd5d07dd0cecc66161fc93d7c9000da1 0x68f180fcce6836688e9084f035309e29bf0a2095 0x94b008aa00579c1307b0ef2c499ad98a8ce58e58 native"
  "unichain:0x4200000000000000000000000000000000000006 0x078d782b760474a361dda0af3839290b0ef57ad6 native"
  "robinhood:0x0bd7d308f8e1639fab988df18a8011f41eacad73 0x5fc5360d0400a0fd4f2af552add042d716f1d168 native"
)

# chain:symbol:token-address:min-base-units
#
# Matched on the token ADDRESS, not the symbol. Robinhood Chain carries five
# 18-decimal USDG impersonators, each with a round 1,000,000,000 supply, sitting in
# the same Settlement contract as the real 6-decimal USDG - so symbol matching would
# happily apply the real token's threshold to a worthless one, and alert that a
# sweep is warranted for tokens that would move nothing. Address is the identity;
# the symbol is a label its deployer chose.
THRESHOLDS=(
  "optimism:USDC:0x0b2c639c533813f4aa9d7837caf62653d097ff85:10000000"
  "optimism:WETH:0x4200000000000000000000000000000000000006:3000000000000000"
  "optimism:ETH:native:3000000000000000"
  "unichain:WETH:0x4200000000000000000000000000000000000006:1000000000000000"
  "unichain:ETH:native:3000000000000000"
  "unichain:USDC:0x078d782b760474a361dda0af3839290b0ef57ad6:10000000"
  "robinhood:USDG:0x5fc5360d0400a0fd4f2af552add042d716f1d168:10000000"
  "robinhood:WETH:0x0bd7d308f8e1639fab988df18a8011f41eacad73:3000000000000000"
  "robinhood:ETH:native:3000000000000000"
)

# Format an epoch as UTC. BSD date (the Mac mini, where this runs) wants -r; GNU
# date (CI, where the suite runs) wants -d @, and reads -r as "this FILE's mtime" -
# so a BSD-only call does not error on Linux, it silently stamps a different time.
# Try both, then fall back to now.
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

# Returns 0 only when the page was actually DELIVERED. The caller records the
# repeat-suppression state from this, so a failed send is retried next run rather
# than muting a live condition for 24h on the strength of a page nobody received.
# NOTIFY=0 is log-only mode, where the log IS the delivery.
# Telegram sends with parse_mode=HTML, so anything angle-bracketed in the body is
# parsed as markup. Two ways that bites: an ERC20 `symbol` is attacker-controllable
# (airdrop a token whose symbol contains markup), and our own diagnostics say things
# like <missing>. Either makes Telegram REJECT the request, so the one condition the
# message exists to report is the one that never gets delivered.
html_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

alert() {
  local msg="$1"
  log "ALERT: $msg"
  msg="$(printf '%s' "$msg" | html_escape)"
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
    --data-urlencode "$(printf 'text=<b>Ophis settlement buffer</b>\n%s' "$msg")" \
    >/dev/null 2>&1; then
    return 0
  fi
  log "WARN: telegram send failed; alert NOT delivered"
  return 1
}

# Resolve a chain's threshold for a symbol. Returns 1 when the chain's sweep
# configuration does not cover that token at all.
threshold_for() { # chain, symbol, token-address
  local label="$1" addr="$3" entry c a v
  addr="$(tr '[:upper:]' '[:lower:]' <<<"$addr")"
  for entry in "${THRESHOLDS[@]}"; do
    # The symbol column is read into `_`: it documents the row for a human but is
    # deliberately NOT part of the match, because the address is the identity.
    IFS=: read -r c _ a v <<< "$entry"
    if [[ "$c" == "$label" && "$a" == "$addr" ]]; then echo "$v"; return 0; fi
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
  IFS=: read -r dir label want_settlement <<< "$entry"
  probe="$OPHIS_REPO/infra/$dir/scripts/check-settlement-buffer.sh"

  if [[ ! -x "$probe" ]]; then
    FINDINGS+=("$label: probe script missing at $probe")
    KEYS+=("$label/probe-missing")
    continue
  fi

  # A probe that dies must not be indistinguishable from a clean chain, and it
  # must not stop the other two from being measured.
  # Per-chain RPC. Each probe defaults to a localhost proxy, but those proxies do
  # not all live on the same host: the Mac mini reaches OP's on :4001 while the
  # Unichain and Robinhood ones run on Cadia. Without an override this job pages
  # hourly with probe failures for two chains it simply cannot reach - a monitor
  # that cries wolf gets muted, which is the failure it exists to prevent. Set
  # OPHIS_RPC_OPTIMISM / OPHIS_RPC_UNICHAIN / OPHIS_RPC_ROBINHOOD to whatever that
  # host can actually reach; unset means keep the probe's own default.
  # A chain with no per-chain override must fall back to the PROBE's own default,
  # not to a generic OPHIS_RPC the operator happens to have exported. Inheriting
  # that would silently point several chains at one endpoint - and the probe reads
  # ${OPHIS_RPC:-<its default>}, so it cannot tell the difference. Unset it.
  rpc_var="OPHIS_RPC_$(tr '[:lower:]' '[:upper:]' <<<"$label")"
  if [[ -n "${!rpc_var:-}" ]]; then
    probe_env=(env "OPHIS_RPC=${!rpc_var}")
  else
    probe_env=(env -u OPHIS_RPC)
  fi
  if ! raw_out="$("${probe_env[@]}" "$probe" 2>&1)"; then
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
  # A partial report is not a measurement either. Name the symbols that went
  # missing rather than quietly monitoring whatever subset happened to arrive.
  expected=""
  # Deliberately NOT `entry`: that is the enclosing CHAINS loop's index variable,
  # and clobbering it here works only by accident of the outer `for` reassigning it.
  for exp_entry in "${EXPECTED_ADDRS[@]}"; do
    IFS=: read -r exp_chain exp_syms <<< "$exp_entry"
    [[ "$exp_chain" == "$label" ]] && expected="$exp_syms"
  done
  if [[ -n "$expected" ]]; then
    got_syms="$(jq -r '.balances[].token // ""' <<<"$report" | tr '[:upper:]' '[:lower:]' | sort -u)"
    missing=""
    for want in $expected; do
      grep -qx -- "$want" <<<"$got_syms" || missing="$missing $want"
    done
    if [[ -n "$missing" ]]; then
      FINDINGS+=("$label: probe report is MISSING expected token(s):${missing} - those balances are UNKNOWN, not zero")
      # The missing set is part of the identity of the incident: losing a different
      # token tomorrow is a NEW condition, and a shared key would suppress it for 24h
      # behind today's page.
      KEYS+=("$label/probe-incomplete/$(tr ' ' ',' <<<"${missing# }")")
      log "chain=$label probe report incomplete, missing:${missing}"
      continue
    fi
  fi

  # The report names the contract it measured. A probe pointed at the wrong
  # Settlement (a copy-paste in its config, an inherited SETTLEMENT in the
  # environment) would otherwise be monitored happily while the real buffer went
  # unwatched - measuring something, just not the thing.
  # The Settlement in the report is a static label the probe echoes. A miswired
  # local proxy pointed at a fork answers balanceOf happily, so the label alone
  # would validate the wrong network's zero balances as a clean pass.
  case "$label" in optimism) want_chain=10 ;; unichain) want_chain=130 ;; robinhood) want_chain=4663 ;; *) want_chain="" ;; esac
  got_chain="$(jq -r '.chain_id // ""' <<<"$report")"
  if [[ -n "$want_chain" && "$got_chain" != "$want_chain" ]]; then
    FINDINGS+=("$label: probe reported chain id '${got_chain:-<missing>}', expected $want_chain - the balances came from the wrong network")
    KEYS+=("$label/wrong-chain")
    log "chain=$label probe reported the wrong chain id"
    continue
  fi

  got_settlement="$(jq -r '.settlement // ""' <<<"$report" | tr '[:upper:]' '[:lower:]')"
  if [[ -n "$want_settlement" && "$got_settlement" != "$want_settlement" ]]; then
    FINDINGS+=("$label: probe measured Settlement $got_settlement, expected $want_settlement - the wrong contract is being watched")
    KEYS+=("$label/wrong-settlement")
    log "chain=$label probe measured the wrong settlement"
    continue
  fi

  failures="$(jq -r '.probe_failures // 0' <<<"$report")"
  if [[ "$failures" != "0" ]]; then
    FINDINGS+=("$label: $failures token probe(s) errored - those balances are UNKNOWN, not zero")
    KEYS+=("$label/probe-failures")
  fi

  # Validate row shape with jq FIRST. The loop below reads a @tsv stream, and @tsv
  # ERRORS on a row whose raw is an object or array - the producer exits non-zero,
  # the loop simply sees fewer lines, and its exit status is not the shell's. The
  # malformed row would vanish and the chain would still finish as measured.
  if ! jq -e '.balances | all(((.symbol|type)=="string") and (((.raw|type)=="string") or ((.raw|type)=="number")) and (((.status|type)=="string") or (.status==null)) and (((.token|type)=="string") or (.token==null)))' <<<"$report" >/dev/null 2>&1; then
    FINDINGS+=("$label: probe report has malformed balance row(s) - buffer state UNKNOWN")
    KEYS+=("$label/probe-malformed-row")
    log "chain=$label probe report has malformed rows"
    continue
  fi

  while IFS=$'\t' read -r sym rawbal status tokaddr; do
    if [[ -z "$sym" ]]; then
      # An empty symbol passes the shape guard (it is still a string) but names
      # nothing, so silently skipping it drops a real balance row from the pass.
      FINDINGS+=("$label: a balance row has an EMPTY symbol (token ${tokaddr:-unknown}) - that balance is UNKNOWN, not zero")
      KEYS+=("$label/${tokaddr:-unknown}/empty-symbol")
      continue
    fi
    # A row is only trustworthy if it says so AND carries a numeric balance. Skipping
    # a non-ok row on the assumption probe_failures already counted it is exactly the
    # gap: a probe can emit status "error" (or omit status entirely) while reporting
    # probe_failures 0, and the chain would then reach a clean pass with that balance
    # never measured.
    if [[ "$status" != "ok" ]]; then
      FINDINGS+=("$label: $sym row has status '${status:-<missing>}' - that balance is UNKNOWN, not zero")
      KEYS+=("$label/$sym/bad-status")
      continue
    fi
    if ! [[ "$rawbal" =~ ^[0-9]+$ ]]; then
      FINDINGS+=("$label: $sym row has a non-numeric balance '${rawbal:-<missing>}' - UNKNOWN, not zero")
      KEYS+=("$label/$sym/bad-balance")
      continue
    fi
    if ! thr="$(threshold_for "$label" "$sym" "$tokaddr")"; then
      # Only report a token the sweep cannot move if there is actually something
      # there; a zero balance in an unconfigured token is not news.
      if gte "$rawbal" "1"; then
        FINDINGS+=("$label: $sym ($tokaddr) $rawbal base units is not covered by the chain's sweep configuration")
        KEYS+=("$label/$tokaddr/uncovered")
      fi
      continue
    fi
    if gte "$rawbal" "$thr"; then
      FINDINGS+=("$label: $sym $rawbal base units is at or above the $thr sweep threshold")
      KEYS+=("$label/$sym/sweepable")
    fi
  done < <(jq -r '.balances[]? | [.symbol, (.raw|tostring), (.status // ""), (.token // "")] | @tsv' <<<"$report")

  log "chain=$label measured"
done

STATE_KEY="$(printf '%s\n' "${KEYS[@]+"${KEYS[@]}"}" | sort | tr '\n' ',')"

if [[ ${#FINDINGS[@]} -eq 0 ]]; then
  # Clear the state so the next real finding pages immediately rather than
  # being suppressed by a stale window.
  # A failed clear leaves stale suppression behind, so the NEXT real finding is
  # silently held for up to 24h against a condition that no longer exists.
  if rm -f "$STATE_FILE" 2>/dev/null; then
    log "all sovereign buffers below their sweep thresholds; pass complete"
    exit 0
  fi
  # Do NOT report a clean pass here. The stale key and timestamp survive, so if
  # the same condition recurs inside the repeat window it is suppressed even
  # though the buffer recovered in between - a page silently swallowed by state
  # this run failed to clear.
  alert "could not clear the suppression state at $STATE_FILE; a stale key may swallow the next page" || true
  log "pass complete but DEGRADED: suppression state not cleared"
  exit 1
fi

prev_key=""; prev_at=0
if [[ -f "$STATE_FILE" ]]; then
  IFS=$'\t' read -r prev_at prev_key < "$STATE_FILE" 2>/dev/null || true
fi
# A non-decimal timestamp would be evaluated as an arithmetic EXPRESSION below, so
# a stored value like `x` resolves an unset variable and, under `set -u`, aborts the
# run. The bad file stays put, so every hourly run after that crashes before
# alerting - a monitor silenced by its own state. Treat anything unparseable as
# "no previous state".
[[ "$prev_at" =~ ^[0-9]+$ ]] || { prev_at=0; prev_key=""; }

should_alert=1
if [[ "$STATE_KEY" == "$prev_key" ]]; then
  age=$(( NOW_S - ${prev_at:-0} ))
  (( age < REPEAT_S )) && should_alert=0
fi

if [[ "$should_alert" == "1" ]]; then
  # Real newlines, not literal %0A: --data-urlencode encodes the body once, so a
  # pre-encoded %0A arrives at Telegram as the visible text "%0A" and a multi-chain
  # incident lands as one unreadable line.
  body="$(printf '%s\n' "${FINDINGS[@]}")"
  # Record the suppression state ONLY on confirmed delivery. Writing it
  # unconditionally muted a live condition for 24h on the strength of a page that
  # may never have been sent - a silent alert is the failure mode, not the fix.
  if alert "$body"; then
    # Create the parent first: on a fresh install nothing has made the configured
    # directory, the redirect fails silently (no `set -e`), no state is written, and
    # the job pages every hour forever instead of once a day.
    mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || log "WARN: cannot create state dir for $STATE_FILE"
    # Write via a temp file and rename: a run interrupted mid-write would otherwise
    # leave a truncated state file, which is the malformed-timestamp case above.
    if ! { printf '%s\t%s' "$NOW_S" "$STATE_KEY" > "$STATE_FILE.tmp" 2>/dev/null && mv -f "$STATE_FILE.tmp" "$STATE_FILE" 2>/dev/null; }; then
      log "WARN: could not persist suppression state to $STATE_FILE; will re-page next run"
    fi
  else
    log "alert delivery FAILED; not recording suppression state, will retry next run"
  fi
else
  log "condition unchanged and inside the ${REPEAT_S}s repeat window; alert suppressed"
fi

log "pass complete (${#FINDINGS[@]} finding(s))"
