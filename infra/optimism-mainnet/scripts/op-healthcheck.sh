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
STATE_FILE="$STATE_DIR/op-health.state"   # up | down  (orderbook liveness)
QFAIL_FILE="$STATE_DIR/op-health.qfail"   # consecutive PRICING-failed runs
DEGRADED_AFTER=3                          # ~15 min (5-min interval) before a DEGRADED alert
mkdir -p "$STATE_DIR"

notify() {
  [[ -f "$TG_ENV" ]] || return 0
  local tok
  tok="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" | head -1 | cut -d= -f2-)"
  [[ -n "$tok" ]] || return 0
  curl -sS -m 12 "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" --data-urlencode "text=$1" \
    --data-urlencode "disable_web_page_preview=true" >/dev/null 2>&1 || true
}

# --- Tier 1: liveness (orderbook reachable?), retried for transient blips ---
vcode=000
for _ in 1 2 3; do
  vcode="$(curl -sS -m 12 -o /dev/null -w '%{http_code}' "$VERSION_URL" 2>/dev/null || echo 000)"
  [[ "$vcode" == "200" ]] && break
  sleep 4
done
prev="$(cat "$STATE_FILE" 2>/dev/null || echo init)"

if [[ "$vcode" != "200" ]]; then
  if [[ "$prev" != "down" ]]; then
    # NOTE (2026-07-30): the old text here said "Usual cause: colima stopped. Fix:
    # cd ~/greg/... && ./compose-up.sh". Both halves were wrong and cost real time:
    #   - colima was UP during the 07-30 incident; the actual cause was every eRPC
    #     upstream being rate-limited, so consensus failed closed.
    #   - ~/greg is a stale WIP tree that production no longer builds from; running
    #     compose-up.sh there is what caused the 07-22 outage (it now refuses).
    #   - a compose-up.sh --build takes ~13min with the orderbook down, so it FIRES
    #     THIS ALERT. A page that arrives right after a deploy is probably the deploy.
    notify "🔴 Ophis OP backend DOWN — orderbook unreachable (HTTP ${vcode} on /version @ optimism-mainnet.ophis.fi).
Triage in order, do NOT redeploy first:
1. Deploying right now? A --build takes ~13min with the orderbook down and trips this alert. Wait it out.
2. colima status  (VM down? colima start)
3. docker compose ps  (containers up?)
4. RPC quorum: curl -s -X POST http://127.0.0.1:4001/main/evm/10 -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x4200000000000000000000000000000000000006\",\"data\":\"0x313ce567\"},\"latest\"]}'
   ErrConsensusLowParticipants/Dispute = upstreams rate-limited or a lane is dead.
Only if the stack must be rebuilt: cd ${DEPLOY_DIR} && ./compose-up.sh (needs sudo; must be a clean origin/main worktree)"
  fi
  echo down >"$STATE_FILE"
  echo 0 >"$QFAIL_FILE"
  exit 0
fi

# Orderbook is up.
[[ "$prev" == "down" ]] && notify "✅ Ophis OP backend RECOVERED — orderbook reachable again."
echo up >"$STATE_FILE"

# --- Tier 2: pricing (can it quote a realistic swap?), cross-run debounced ---
qcode=000
for _ in 1 2 3; do
  qcode="$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST "$QUOTE_URL" \
    -H 'content-type: application/json' -d "$QUOTE_BODY" 2>/dev/null || echo 000)"
  [[ "$qcode" == "200" ]] && break
  sleep 5
done
qfail="$(cat "$QFAIL_FILE" 2>/dev/null || echo 0)"

if [[ "$qcode" == "200" ]]; then
  [[ "${qfail:-0}" -ge "$DEGRADED_AFTER" ]] && notify "✅ Ophis OP swap pricing RECOVERED."
  echo 0 >"$QFAIL_FILE"
else
  qfail=$(( ${qfail:-0} + 1 ))
  echo "$qfail" >"$QFAIL_FILE"
  if [[ "$qfail" -eq "$DEGRADED_AFTER" ]]; then
    notify "🟠 Ophis OP swap pricing DEGRADED — orderbook is UP but /quote keeps failing (HTTP ${qcode}) for ~15 min on a realistic amount.
This is the tier that catches an RPC-quorum failure while liveness looks green (2026-07-30: /quote 500 'all gas estimators failed' while /version was 200).
1. Check the eRPC quorum first (see the DOWN-alert command) — a lane rate-limited or dead is the likeliest cause.
2. eth_getTransactionReceipt through the proxy too: with agreementThreshold:2 a dead 3rd lane hides behind the other two.
3. docker logs optimism-mainnet-orderbook-1 | grep -i 'estimator\\|price'
Only if the stack must be rebuilt: cd ${DEPLOY_DIR} && ./compose-up.sh"
  fi
fi
