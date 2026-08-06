#!/usr/bin/env bash
# Ophis Unichain (chain 130) backend health check + Aleph VM auto-recovery.
#
# RUN BY: LaunchAgent ~/Library/LaunchAgents/com.ophis.unichain-healthcheck.plist
#         (StartInterval 300 + RunAtLoad). Logs to ~/Library/Logs/ophis-unichain-healthcheck.*
#
# WHY THIS EXISTS: the Unichain orderbook VM died 2026-07-28T06:24Z and nobody
# noticed for NINE DAYS. There was no off-box liveness check for chain 130 at all;
# the only canary was Robinhood-only and had never run. This is that check.
#
# ⚠️ THE PLIST HARDCODES THIS FILE'S ABSOLUTE PATH. If the checkout it points at
# moves, launchd logs "No such file or directory" every 5 minutes and ALERTING
# SILENTLY DIES (this already happened once to the OP sibling). After repointing:
#   launchctl kickstart -k gui/$(id -u)/com.ophis.unichain-healthcheck
#
# It deliberately runs on the Mac mini, NOT on the Unichain VM: a monitor that
# lives on the box it watches cannot report that box being gone, which is the
# exact failure mode this incident was.
#
# Two things happen on failure, in order:
#   1. RECOVER — POST /control/allocation/notify to the pinned CRN. This is the
#      unauthenticated call the Aleph scheduler itself makes to start a
#      credit-paid instance, so replaying it is the legitimate restart lever and
#      the ONLY one an instance owner has (aleph instance start/allocate are
#      PAYG+confidential only). It can only start a VM, never erase one.
#      Rate-limited to one attempt per RECOVER_COOLDOWN so a genuinely dead node
#      is not hammered every 5 minutes.
#   2. ALERT — Telegram, transition-only.
#      Recovery NEVER suppresses the alert. A VM that needs kicking is a fact the
#      operator must see even when the kick works, otherwise a box that silently
#      restarts every night looks healthy forever.
#
# Secret-free: bot token read at runtime from the telegram channel .env.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

VERSION_URL="${OPHIS_UNI_VERSION_URL:-https://unichain-mainnet.ophis.fi/api/v1/version}"

# Aleph instance + its PINNED CRN. requirements.node.node_hash is baked into the
# signed INSTANCE message and cannot be edited, so if the instance is ever
# recreated these BOTH change together. Re-read them from:
#   https://scheduler.api.aleph.cloud/api/v0/allocation/<item_hash>
ALEPH_VM_HASH="${OPHIS_UNI_ALEPH_HASH:-1ef857dfe129f9a0796e5bde37b66a14ce0e772288cbcb8d4b3ff712b6c87bb0}"
ALEPH_CRN_URL="${OPHIS_UNI_ALEPH_CRN:-https://crn5.leviathan.so}"
RECOVER_COOLDOWN=3600   # seconds between allocation-notify attempts

TG_ENV="${TELEGRAM_BOT_TOKEN_ENV_FILE:-$HOME/.claude/channels/telegram/.env}"
CHAT_ID="${TELEGRAM_CHAT_ID:-735726338}"

# Overridable so a test run can use a scratch state dir. Do NOT test this script
# by overriding HOME instead: `security` resolves the login Keychain through HOME,
# so a HOME override silently breaks token lookup and makes a WORKING notify path
# look broken (it did, during review of this file).
STATE_DIR="${OPHIS_STATE_DIR:-$HOME/.local/state/ophis}"
# BELIEF, not observation: what the recipient currently thinks is true. Any
# mismatch between belief and observation is a message we still owe, so a failed
# send is retried next run instead of being lost. Conflating "service is down"
# with "we already paged" is a real bug that ate a second outage's page on the OP
# sibling (Codex review, 2026-07-30) — do not collapse these two facts again.
STATE_FILE="$STATE_DIR/unichain-health.state"      # up | down
RECOVER_FILE="$STATE_DIR/unichain-health.recover"  # mtime = last notify attempt
LOCK_DIR="$STATE_DIR/unichain-health.lock"
mkdir -p "$STATE_DIR"

# Atomic single-instance lock. mkdir needs no flock and is atomic everywhere we
# care about. Distinguish contention (skip quietly) from an unwritable STATE_DIR
# (must be LOUD — otherwise the monitor exits 0 forever and dies silently).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [[ ! -d "$LOCK_DIR" ]]; then
    mkdir "$LOCK_DIR" 2>/dev/null || {
      echo "FATAL: cannot create $LOCK_DIR (STATE_DIR unwritable / disk full?)" >&2; exit 1; }
  elif [[ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null)" ]]; then
    echo "stale lock older than 15min — reclaiming" >&2
    rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null || { echo "FATAL: could not reclaim lock" >&2; exit 1; }
  else
    echo "another unichain-healthcheck run is in progress — skipping this tick" >&2; exit 0
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Returns 0 ONLY if Telegram accepted (HTTP 200). Callers MUST gate the persisted
# state on this: a monitor that loses its page without saying so is worse than one
# that pages twice.
#
# Token resolution order matters. This directory's own setup-telegram-keychain.sh
# exists specifically to REPLACE the cleartext .env, so a host provisioned per the
# documented path has the Keychain entry and NO .env — keying only off the .env
# would mean every transition silently hit the missing-file branch and no page was
# ever delivered on exactly the setup we tell operators to use. Keychain is
# therefore consulted before the legacy file, mirroring render-configs.sh.
resolve_token() {
  local tok=""
  # 1. explicit env (launchd plist / operator override) wins
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then printf '%s' "$TELEGRAM_BOT_TOKEN"; return 0; fi
  # 2. macOS Keychain — the supported store
  if [[ "$(uname -s)" == "Darwin" ]]; then
    tok="$(security find-generic-password -a "$USER" -s ophis-telegram-bot -w 2>/dev/null)"
    [[ -n "$tok" ]] && { printf '%s' "$tok"; return 0; }
  fi
  # 3. legacy channel .env
  if [[ -f "$TG_ENV" ]]; then
    tok="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" | head -1 | cut -d= -f2-)"
    [[ -n "$tok" ]] && { printf '%s' "$tok"; return 0; }
  fi
  return 1
}

notify() {
  local tok code
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

# Ask the pinned CRN to start the instance. Cooldown-gated. Echoes what happened
# so the alert text can carry it (an operator needs to know whether the kick was
# even attempted, and what the CRN said).
attempt_recovery() {
  local now last resp
  now=$(date +%s)
  last=0
  [[ -f "$RECOVER_FILE" ]] && last=$(stat -f %m "$RECOVER_FILE" 2>/dev/null || stat -c %Y "$RECOVER_FILE" 2>/dev/null || echo 0)
  if (( now - last < RECOVER_COOLDOWN )); then
    echo "recovery on cooldown ($(( (RECOVER_COOLDOWN - (now - last)) / 60 ))min left)"; return
  fi
  : > "$RECOVER_FILE"
  resp="$(curl -sS -m 60 -X POST "${ALEPH_CRN_URL}/control/allocation/notify" \
    -H 'Content-Type: application/json' -d "{\"instance\":\"${ALEPH_VM_HASH}\"}" 2>&1 | head -c 200)"
  echo "allocation-notify sent: ${resp:-<no response>}"
}

# --- Liveness. Retried, so a single transient blip is not an outage. ---
code=000
for _ in 1 2 3; do
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$VERSION_URL" 2>/dev/null)"
  [[ "$code" == "200" ]] && break
  sleep 5
done

believed="$(cat "$STATE_FILE" 2>/dev/null || echo up)"

if [[ "$code" == "200" ]]; then
  observed=up
  rm -f "$RECOVER_FILE"   # healthy: next outage may kick immediately
  msg="✅ Ophis Unichain (130) RECOVERED — ${VERSION_URL} is serving again."
else
  observed=down
  # Only ORIGIN-LOSS codes mean "the box is gone": 000 (timeout/DNS), 502/503/504
  # and Cloudflare 530, i.e. the tunnel is registered but no connector is
  # attached. An app-level 401/404/429/500 means the VM is up and answering, so
  # kicking it would be pointless AND harmful: it would burn the 1h cooldown, and
  # if the VM genuinely stopped minutes later the real restart would be skipped as
  # "on cooldown". Page for every non-200; only recover for origin loss.
  case "$code" in
    000|502|503|504|530) recovery="$(attempt_recovery)" ;;
    *) recovery="not attempted — HTTP $code means the VM is answering, so this is an application fault, not a stopped box" ;;
  esac
  msg="🔴 Ophis Unichain (130) DOWN — ${VERSION_URL} returned HTTP ${code:-000}.
Chain 130 cannot quote or settle. Aleph VM ${ALEPH_VM_HASH:0:12} on ${ALEPH_CRN_URL#https://}.
Recovery: ${recovery}
If the CRN reports success but the box stays dead, that is the 2026-07/08 credit-VM failure mode: the owner cannot start it and only Aleph support can."
fi

if [[ "$observed" != "$believed" ]]; then
  if notify "$msg"; then
    printf '%s' "$observed" > "$STATE_FILE"   # delivery-gated: only advance on a delivered page
  fi
else
  echo "no change (believed=$believed observed=$observed http=$code)"
fi
