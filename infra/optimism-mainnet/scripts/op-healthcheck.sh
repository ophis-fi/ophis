#!/usr/bin/env bash
# Ophis OP backend health check.
#
# RUN BY: LaunchAgent ~/Library/LaunchAgents/com.ophis.op-healthcheck.plist
#         (StartInterval 300 + RunAtLoad). Logs to ~/Library/Logs/ophis-op-healthcheck.*
#
# ⚠️ THE PLIST HARDCODES THIS FILE'S ABSOLUTE PATH. If the checkout it points at is
# moved or deleted, launchd logs "No such file or directory" every 5 minutes and
# ALERTING SILENTLY DIES — this happened once already (the .err.log filled with that
# error for weeks). This file lived UNTRACKED in a stale worktree until 2026-07-30,
# so it existed in exactly one place with no backup. Tracking it here fixes the
# backup half; if you repoint the deploy worktree, update the plist too and confirm
# with:  launchctl kickstart -k gui/$(id -u)/com.ophis.op-healthcheck
#
# Overridable env (set in the plist): TELEGRAM_BOT_TOKEN_ENV_FILE, TELEGRAM_CHAT_ID,
# OPHIS_OP_DEPLOY_DIR.
#
# Two tiers, so a thin route for a small amount can't be mistaken for an outage:
#   1. LIVENESS  — GET /api/v1/version. If the orderbook is unreachable (502 when
#      colima/the tunnel origin is down, or a timeout), that is the real outage →
#      "DOWN" alert. This is what actually failed in the 2026-06-06 incident.
#   2. PRICING   — POST /quote for a REALISTIC amount (0.05 WETH→USDC). A 404
#      NoLiquidity here while the orderbook is UP means the driver/solvers can't
#      price (e.g. driver crashed but orderbook serving). Only alerted as a softer
#      "DEGRADED" after it persists across several runs (cross-run debounce), so a
#      transient solver/eRPC blip or a dust-amount thin route never false-alarms.
#
# Transition-only Telegram alerts (no spam). Secret-free: bot token read at runtime
# from the telegram channel .env. Run by launchd every 5 min.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

BASE="https://optimism-mainnet.ophis.fi/api/v1"
VERSION_URL="$BASE/version"
QUOTE_URL="$BASE/quote"
# 0.05 WETH -> native USDC: a realistic amount that routes reliably when healthy
# (a 0.001 WETH dust probe flaps near the fee-economics edge — do NOT use it).
QUOTE_BODY='{"sellToken":"0x4200000000000000000000000000000000000006","buyToken":"0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85","from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","kind":"sell","sellAmountBeforeFee":"50000000000000000"}'

# Alert channel. Both overridable from the launchd env so this script carries no
# host-specific assumptions; the defaults are the Mac-mini operator setup and match
# the chat id already used by the sibling watchers in this repo.
TG_ENV="${TELEGRAM_BOT_TOKEN_ENV_FILE:-$HOME/.claude/channels/telegram/.env}"
CHAT_ID="${TELEGRAM_CHAT_ID:-735726338}"

# Where an operator should run compose-up.sh from. This MUST be a clean worktree at
# origin/main: compose-up.sh's build guard (#862) refuses to build from anything
# else, because `--build` compiles images from the tree it runs in (the 2026-07-22
# ~7h outage shipped a stale build that way). Overridable as the deploy path moves.
DEPLOY_DIR="${OPHIS_OP_DEPLOY_DIR:-/Users/scep/greg-wt/op-deploy-0730/infra/optimism-mainnet}"
STATE_DIR="$HOME/.local/state/ophis"
# STATE_FILE holds WHAT THE RECIPIENT CURRENTLY BELIEVES (the last state we
# successfully delivered), NOT what we last observed. Any mismatch between belief
# and observation is a message we still owe, so every run retries until it lands.
#
# Getting this wrong is subtle and was a real bug (Codex review, 2026-07-30): the
# first version wrote "down" to mean BOTH "the service is down" AND "we already
# paged". So when a RECOVERED send failed, state stayed "down" — and a genuine
# SECOND outage was then read as "already paged" and never announced. One file
# cannot encode two facts. Modelling belief instead collapses it to one rule:
#   observed != believed  ->  owe a message; send it; on success believe = observed
# The failed-recovery case then resolves correctly on its own: the recipient still
# believes "down", the service is down again, belief already matches reality, so
# nothing is owed and nothing is missed.
STATE_FILE="$STATE_DIR/op-health.state"   # up | down  (BELIEF, not observation)
QFAIL_FILE="$STATE_DIR/op-health.qfail"   # consecutive PRICING-failed runs
QSENT_FILE="$STATE_DIR/op-health.qalerted" # exists => DEGRADED page was DELIVERED
DEGRADED_AFTER=3                          # ~15 min (5-min interval) before a DEGRADED alert
mkdir -p "$STATE_DIR"

# Single-instance lock. Every state update here is an unlocked read-modify-write, so
# two overlapping runs can both read "up", both page, and both write "down" (double
# page), or both miss the QSENT_FILE marker and double-send DEGRADED, or lose a
# QFAIL increment and delay the threshold. launchd will not re-enter a StartInterval
# job on its own, but `launchctl kickstart` and manual operator runs do — and both
# happened during the 2026-07-30 incident while the agent was scheduled.
# mkdir is atomic on every filesystem we care about, so it needs no flock.
LOCK_DIR="$STATE_DIR/op-health.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Reap a lock orphaned by a kill -9 / power loss rather than wedging forever.
  if [[ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null)" ]]; then
    echo "stale lock older than 15min — reclaiming" >&2
    rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else
    echo "another op-healthcheck run is in progress — skipping this tick" >&2
    exit 0
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

# Returns 0 ONLY if Telegram accepted the message (HTTP 200). Callers MUST gate the
# persisted transition state on this — see "delivery-gated state" below.
#
# It previously ended in `|| true` with output discarded, so a timeout, a 401 on a
# rotated token, or a 400 all looked identical to success. The caller then wrote the
# new state anyway, so the next 5-minute run saw "already alerted" and stayed quiet:
# ONE failed send silently suppressed the only page for the whole outage. A monitor
# that can lose its page without saying so is worse than one that pages twice.
notify() {
  local tok code
  if [[ ! -f "$TG_ENV" ]]; then
    echo "ALERT UNDELIVERED: token file $TG_ENV missing" >&2; return 1
  fi
  tok="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" | head -1 | cut -d= -f2-)"
  if [[ -z "$tok" ]]; then
    echo "ALERT UNDELIVERED: no TELEGRAM_BOT_TOKEN in $TG_ENV" >&2; return 1
  fi
  # Capture the HTTP status instead of discarding it. Telegram returns 200 on
  # accept; 401 = bad/rotated token, 400 = malformed, 000 = timeout/DNS.
  code="$(curl -sS -m 12 -o /dev/null -w '%{http_code}' \
    "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" --data-urlencode "text=$1" \
    --data-urlencode "disable_web_page_preview=true" 2>/dev/null)"
  if [[ "$code" != "200" ]]; then
    echo "ALERT UNDELIVERED: telegram HTTP ${code:-000} — state NOT advanced, will retry next run" >&2
    return 1
  fi
  return 0
}

# --- Tier 1: liveness (orderbook reachable?), retried for transient blips ---
vcode=000
for _ in 1 2 3; do
  # NB: no `|| echo 000` here. curl's -w already prints 000 on a connection
  # failure, so the fallback CONCATENATED and the alert read "HTTP 000000".
  vcode="$(curl -sS -m 12 -o /dev/null -w '%{http_code}' "$VERSION_URL" 2>/dev/null)"
  [[ -n "$vcode" ]] || vcode=000
  [[ "$vcode" == "200" ]] && break
  sleep 4
done
prev="$(cat "$STATE_FILE" 2>/dev/null || echo init)"

# --- Boot grace: never page for a cold boot that is still recovering ---
# This LaunchAgent is RunAtLoad, so on a reboot it fires immediately — but
# op-boot-start.sh allows colima's docker daemon up to ~120s, and the containers
# still have to start after that. The retry loop above only covers ~12s, so the
# probe would see a 502, compare against the pre-reboot state ("up"), and page a
# DOWN that resolves itself minutes later. Every reboot would cry wolf.
#
# So during the grace window we stay SILENT and, crucially, do not persist any
# state — the next 5-minute run pages normally if the stack is genuinely broken.
# Cost of a real post-boot outage is therefore at most one extra interval.
# (A tighter alternative is a completion marker written by op-boot-start.sh; uptime
# needs no cross-script coupling, which is why it is used here.)
BOOT_GRACE="${OPHIS_BOOT_GRACE_SECONDS:-600}"
# A non-numeric override must not abort the run inside (( )) and take the monitor
# down; fall back to the default and say so.
if ! [[ "$BOOT_GRACE" =~ ^[0-9]+$ ]]; then
  echo "OPHIS_BOOT_GRACE_SECONDS='${BOOT_GRACE}' is not numeric — using 600" >&2
  BOOT_GRACE=600
fi
# kern.boottime prints: { sec = 1784657227, usec = 380592 } Tue Jul 21 20:07:07 2026
# Take the FIRST number. Matching on "sec" is a trap: a greedy .*sec matches the
# "sec" inside "usec" and yields the microseconds field (caught in testing — it
# parsed 380592 and silently disabled this whole guard).
boot_epoch="$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
if [[ "$vcode" != "200" && "$boot_epoch" =~ ^[0-9]+$ ]]; then
  uptime_s=$(( $(date +%s) - boot_epoch ))
  if (( uptime_s >= 0 && uptime_s < BOOT_GRACE )); then
    echo "boot grace: up ${uptime_s}s (< ${BOOT_GRACE}s) and probe returned ${vcode} — suppressing page, state untouched, will re-probe next run" >&2
    exit 0
  fi
fi

observed=up
[[ "$vcode" == "200" ]] || observed=down

# One rule for both directions: if belief != observation we owe a message. Sending
# it is what updates the belief, so a failed send simply leaves the debt in place
# and the next run retries. No branch can "consume" a transition without delivering.
if [[ "$observed" != "$prev" ]]; then
  if [[ "$observed" == "down" ]]; then
    # NOTE (2026-07-30): the old text here said "Usual cause: colima stopped. Fix:
    # cd ~/greg/... && ./compose-up.sh". Both halves were wrong and cost real time:
    #   - colima was UP during the 07-30 incident; the actual cause was every eRPC
    #     upstream being rate-limited, so consensus failed closed.
    #   - ~/greg is a stale WIP tree that production no longer builds from; running
    #     compose-up.sh there is what caused the 07-22 outage (it now refuses).
    #   - a compose-up.sh --build takes ~13min with the orderbook down, so it FIRES
    #     THIS ALERT. A page that arrives right after a deploy is probably the deploy.
    if notify "🔴 Ophis OP backend DOWN — orderbook unreachable (HTTP ${vcode} on /version @ optimism-mainnet.ophis.fi).
Triage in order, do NOT redeploy first:
1. Deploying right now? A --build takes ~13min with the orderbook down and trips this alert. Wait it out.
2. colima status  (VM down? colima start)
3. docker compose ps  (containers up?)
4. RPC quorum: curl -s -X POST http://127.0.0.1:4001/main/evm/10 -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x4200000000000000000000000000000000000006\",\"data\":\"0x313ce567\"},\"latest\"]}'
   ErrConsensusLowParticipants/Dispute = upstreams rate-limited or a lane is dead.
Only if the stack must be rebuilt: cd ${DEPLOY_DIR} && ./compose-up.sh (needs sudo; must be a clean origin/main worktree)"; then
      echo down >"$STATE_FILE"
    fi
  else
    if notify "✅ Ophis OP backend RECOVERED — orderbook reachable again."; then
      echo up >"$STATE_FILE"
    fi
  fi
fi

if [[ "$observed" == "down" ]]; then
  # Pricing is meaningless while the orderbook is unreachable; reset the debounce so
  # a recovery does not immediately inherit a stale DEGRADED count.
  echo 0 >"$QFAIL_FILE"
  rm -f "$QSENT_FILE"
  exit 0
fi

# --- Tier 2: pricing (can it quote a realistic swap?), cross-run debounced ---
qcode=000
for _ in 1 2 3; do
  qcode="$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST "$QUOTE_URL" \
    -H 'content-type: application/json' -d "$QUOTE_BODY" 2>/dev/null)"
  [[ -n "$qcode" ]] || qcode=000
  [[ "$qcode" == "200" ]] && break
  sleep 5
done
qfail="$(cat "$QFAIL_FILE" 2>/dev/null || echo 0)"
# Corrupt/blank counter must not wedge the script: under `set -u` a non-numeric
# value here is treated as a variable NAME by the arithmetic below and aborts the
# run, which would take the monitor down silently. Fail back to 0 instead.
[[ "$qfail" =~ ^[0-9]+$ ]] || qfail=0

if [[ "$qcode" == "200" ]]; then
  qobserved=ok
  echo 0 >"$QFAIL_FILE"
else
  qfail=$(( qfail + 1 ))
  echo "$qfail" >"$QFAIL_FILE"
  qobserved=ok
  [[ "$qfail" -ge "$DEGRADED_AFTER" ]] && qobserved=degraded
fi

# Same belief model as tier 1: QSENT_FILE's presence IS the belief ("recipient has
# been told pricing is degraded"). Only a delivered message changes it, so a failed
# send is retried on the next run instead of being silently consumed. `-ge`, not the
# original `-eq`: with equality a send that failed at exactly the threshold was
# unrecoverable, because qfail kept climbing and the equality never held again.
qbelief=ok
[[ -f "$QSENT_FILE" ]] && qbelief=degraded

if [[ "$qobserved" != "$qbelief" ]]; then
  if [[ "$qobserved" == "ok" ]]; then
    if notify "✅ Ophis OP swap pricing RECOVERED."; then rm -f "$QSENT_FILE"; fi
  else
    if notify "🟠 Ophis OP swap pricing DEGRADED — orderbook is UP but /quote keeps failing (HTTP ${qcode}) for ~15 min on a realistic amount.
This is the tier that catches an RPC-quorum failure while liveness looks green (2026-07-30: /quote 500 'all gas estimators failed' while /version was 200).
1. Check the eRPC quorum first (see the DOWN-alert command) — a lane rate-limited or dead is the likeliest cause.
2. eth_getTransactionReceipt through the proxy too: with agreementThreshold:2 a dead 3rd lane hides behind the other two.
3. docker logs optimism-mainnet-orderbook-1 | grep -i 'estimator\\|price'
Only if the stack must be rebuilt: cd ${DEPLOY_DIR} && ./compose-up.sh"; then
      : > "$QSENT_FILE"
    fi
  fi
fi
