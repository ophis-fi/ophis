#!/usr/bin/env bash
# Ophis Unichain self-node (`ophis-uni-node`) health check.
#
# RUN BY: LaunchAgent ~/Library/LaunchAgents/com.ophis.uninode-healthcheck.plist
#         (StartInterval 300 + RunAtLoad). Logs to ~/Library/Logs/ophis-uninode-healthcheck.*
#
# WHY THIS EXISTS: this node has died twice and gone unnoticed both times, most
# recently for TWO DAYS (2026-08-05 to 08-07: op-node crash-looped 2554 times on
# a DNS failure while op-reth kept serving a frozen head).
#
# ⚠️ WHY A LIVENESS PROBE IS NOT ENOUGH — read before "simplifying" this.
# During that outage the node answered every request correctly:
#   eth_blockNumber   -> a valid number (just never changing)
#   eth_syncing       -> currentBlock == highestBlock, i.e. "fully synced"
#   docker ps         -> op-reth "Up 43 hours"
# A reachability check is GREEN throughout. The signal that betrays it is
# STALENESS, so the primary check is the age of the head block, not whether the
# RPC responds.
#
# Three checks, each catching a failure the others miss:
#   1. REACHABLE  — the RPC answers at all (node box gone / tailnet down).
#   2. FRESH      — head block timestamp is younger than STALE_AFTER. This is
#                   the one that catches derivation stalls. Uses the node's OWN
#                   block timestamp vs wall clock rather than diffing against a
#                   public RPC, so a flaky third party cannot cause a false page.
#   3. TRACEABLE  — debug_traceTransaction works on a recent transaction. The
#                   autopilot HARD-requires this and no public Unichain RPC
#                   serves it, so losing it silently pauses settlement.
#
# Deliberately NO auto-remediation. The real fix on 08-05 was a DNS repair on the
# host; blindly restarting op-node would not have helped and would have masked
# the cause. This pages a human with the specific failing check.
#
# Runs on the Mac mini, NOT on the node: a monitor hosted on the box it watches
# cannot report that box being gone.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

NODE_RPC="${OPHIS_UNI_NODE_RPC:-http://100.90.134.52:8545}"
# ~1s blocks, so 300s of no new block is far beyond any normal jitter while
# still well inside the "nobody noticed for two days" territory this prevents.
STALE_AFTER="${OPHIS_UNI_NODE_STALE_AFTER:-300}"
# How many blocks to walk back looking for a transaction to trace. Unichain has
# ~1s blocks, so 30 covers a very quiet half-minute without hammering the node.
TRACE_LOOKBACK="${OPHIS_UNI_NODE_TRACE_LOOKBACK:-30}"

TG_ENV="${TELEGRAM_BOT_TOKEN_ENV_FILE:-$HOME/.claude/channels/telegram/.env}"
CHAT_ID="${TELEGRAM_CHAT_ID:-735726338}"
STATE_DIR="${OPHIS_STATE_DIR:-$HOME/.local/state/ophis}"
STATE_FILE="$STATE_DIR/uninode-health.state"   # BELIEF (what we last told the recipient)
LOCK_DIR="$STATE_DIR/uninode-health.lock"
mkdir -p "$STATE_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [[ ! -d "$LOCK_DIR" ]]; then
    mkdir "$LOCK_DIR" 2>/dev/null || { echo "FATAL: cannot create $LOCK_DIR" >&2; exit 1; }
  elif [[ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null)" ]]; then
    rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null || { echo "FATAL: could not reclaim lock" >&2; exit 1; }
  else
    echo "another uninode-healthcheck run is in progress — skipping this tick" >&2; exit 0
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

rpc() {
  curl -s -m 15 -X POST "$NODE_RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" 2>/dev/null
}
# Whitespace-tolerant JSON field extraction. `"result":"0x1"` and
# `"result": "0x1"` are both legal JSON, and a proxy in front of the node may
# reformat responses. A parser that only accepts the compact form silently
# reads every response as empty, i.e. reports a HEALTHY node as unreachable —
# which is exactly how this script's own first test run failed.
json_str() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\\1/p"; }
result_of() { json_str result; }

resolve_token() {
  local tok=""
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && { printf '%s' "$TELEGRAM_BOT_TOKEN"; return 0; }
  if [[ "$(uname -s)" == "Darwin" ]]; then
    tok="$(security find-generic-password -a "$USER" -s ophis-telegram-bot -w 2>/dev/null)"
    [[ -n "$tok" ]] && { printf '%s' "$tok"; return 0; }
  fi
  if [[ -f "$TG_ENV" ]]; then
    tok="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" | head -1 | cut -d= -f2-)"
    [[ -n "$tok" ]] && { printf '%s' "$tok"; return 0; }
  fi
  return 1
}

# OPHIS_NO_NOTIFY=1 prints instead of sending, so testing this script cannot page
# the operator with an outage that is not happening. Always set it when testing.
notify() {
  local tok code
  if [[ "${OPHIS_NO_NOTIFY:-0}" == "1" ]]; then echo "[DRY RUN — not sent] $1"; return 0; fi
  if ! tok="$(resolve_token)"; then
    echo "ALERT UNDELIVERED: no token in \$TELEGRAM_BOT_TOKEN, Keychain (ophis-telegram-bot), or $TG_ENV" >&2
    return 1
  fi
  code="$(curl -sS -m 12 -o /dev/null -w '%{http_code}' \
    "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" --data-urlencode "text=$1" \
    --data-urlencode "disable_web_page_preview=true" 2>/dev/null)"
  [[ "$code" == "200" ]] && return 0
  echo "ALERT UNDELIVERED: telegram HTTP ${code:-000} — state NOT advanced, will retry next run" >&2
  return 1
}

# --- check 1: reachable (retried, so one blip is not an outage) ---
head_hex=""
for _ in 1 2 3; do
  head_hex="$(rpc eth_blockNumber '[]' | result_of)"
  [[ -n "$head_hex" ]] && break
  sleep 5
done

observed=up; detail=""; trace_unverified=0; log_note=""
if [[ -z "$head_hex" ]]; then
  observed=down
  detail="RPC unreachable at ${NODE_RPC} (node box down, or this monitor's tailnet is down)"
else
  head_dec=$((16#${head_hex#0x}))
  # --- check 2: fresh (the one that catches a frozen head) ---
  blk="$(rpc eth_getBlockByNumber "[\"$head_hex\",false]")"
  ts_hex="$(printf '%s' "$blk" | json_str timestamp)"
  if [[ -z "$ts_hex" ]]; then
    observed=down
    detail="head #${head_dec} returned no block body — RPC answering but not serving blocks"
  else
    age=$(( $(date +%s) - $((16#${ts_hex#0x})) ))
    if (( age > STALE_AFTER )); then
      observed=down
      detail="head #${head_dec} is ${age}s old (threshold ${STALE_AFTER}s) — DERIVATION STALLED. op-node is the usual culprit; check it is not crash-looping and that DNS on the host resolves."
    else
      # --- check 3: traceable (autopilot hard-requirement) ---
      # Walk back for a block that actually HAS a transaction. An empty block is
      # not a failure, but it is also not proof of health: treating "no tx to
      # trace" as healthy meant a single transaction-free block could flip a
      # down state to RECOVERED while tracing was still broken, hiding the very
      # settlement pause this monitor exists to catch.
      probe="$head_hex"
      probe_body="$blk"
      tx=""
      for _ in $(seq 1 "$TRACE_LOOKBACK"); do
        tx="$(printf '%s' "$probe_body" | sed -n 's/.*"transactions"[[:space:]]*:[[:space:]]*\[[[:space:]]*"\([^"]*\)".*/\1/p')"
        [[ -n "$tx" ]] && break
        probe_dec=$((16#${probe#0x}))
        (( probe_dec <= 0 )) && break
        probe="$(printf '0x%x' $((probe_dec - 1)))"
        probe_body="$(rpc eth_getBlockByNumber "[\"$probe\",false]")"
      done
      if [[ -n "$tx" ]]; then
        tr="$(rpc debug_traceTransaction "[\"$tx\",{\"tracer\":\"callTracer\"}]")"
        if ! printf '%s' "$tr" | grep -q '"result"'; then
          observed=down
          detail="head is fresh (#${head_dec}, ${age}s) but debug_traceTransaction FAILED — the autopilot cannot decode settlements, so chain 130 settlement is paused."
        fi
      else
        # Nothing to trace in the whole lookback. Freshness passed, so do not
        # page — but tracing is UNPROVEN, so this must not be allowed to clear an
        # existing down state (see the withhold below).
        trace_unverified=1
        log_note="tracing unverified: no transactions in the last ${TRACE_LOOKBACK} blocks"
      fi
    fi
  fi
fi

believed="$(cat "$STATE_FILE" 2>/dev/null || echo up)"
if [[ "$observed" == "up" ]]; then
  msg="✅ ophis-uni-node RECOVERED — head fresh and debug_traceTransaction serving again."
else
  msg="🔴 ophis-uni-node UNHEALTHY — ${detail}
This node is the ONLY source of debug_traceTransaction for chain 130; while it is down the autopilot pauses settlement (fail-closed, by design).
Host: ${NODE_RPC}. It has died silently twice before — 2026-08-05 was op-node crash-looping on a broken DNS resolver."
fi

if [[ "$observed" == "up" && "$believed" == "down" && "$trace_unverified" == "1" ]]; then
  # Do NOT claim recovery on evidence we do not have. The node went down; only a
  # SUCCESSFUL trace proves the capability that matters came back. Stay down and
  # re-check next tick; a real recovery clears this as soon as any block has a tx.
  echo "withholding RECOVERED — ${log_note}"
elif [[ "$observed" != "$believed" ]]; then
  if notify "$msg"; then printf '%s' "$observed" > "$STATE_FILE"; fi
else
  echo "no change (believed=$believed observed=$observed)${detail:+ — $detail}${log_note:+ [$log_note]}"
fi
