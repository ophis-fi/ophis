#!/usr/bin/env bash
# Restart containers that have been UNHEALTHY for too long.
#
# ## Why this exists (2026-08-23/24 Robinhood outage, 8 hours)
#
# Docker does not restart an unhealthy container. `restart: always` fires on
# EXIT, not on a failing HEALTHCHECK. So a container can sit `Up 46 hours
# (unhealthy)` forever while its healthcheck screams into a void.
#
# That is exactly what happened. The Robinhood driver detected its own fault
# precisely and reported it every 10 seconds:
#
#     driver healthz reporting unhealthy
#     failures=["latest block was observed 331s ago, exceeds threshold 30s"]
#
# Correct detection, zero consequence, eight hours of no quotes and no
# settlements. The signal existed the whole time; nothing consumed it.
#
# ## Why NOT the usual autoheal sidecar
#
# The common answer is a container (willfarrell/autoheal and friends) with
# /var/run/docker.sock bind-mounted in. Write access to that socket is
# root-equivalent on the host: it can start a privileged container that mounts
# /. On a box holding settlement submitter keys that is a bad trade for a
# convenience feature, and it would put a third-party image inside the trust
# boundary. This runs on the host from cron instead. No socket is exposed to
# any container, and no new image joins the stack.
#
# ## Safety properties
#
# 1. ALLOWLIST ONLY. A container is restarted only if it matches WATCHDOG_ALLOW.
#    Default covers the stateless services that are designed to be restarted.
#    Databases and chain nodes are deliberately absent: restarting postgres
#    mid-write, or nitro (which then re-syncs for a long time), turns a
#    degradation into a worse outage. "Unhealthy" is not a licence to bounce
#    anything.
# 2. SUSTAINED ONLY. Must be continuously unhealthy for WATCHDOG_THRESHOLD_S.
#    Transient flaps during a deploy or a slow start must not trigger a restart.
# 3. COOLDOWN. At most one restart per container per WATCHDOG_COOLDOWN_S. If a
#    restart does not fix the fault, the answer is a human, not a restart loop
#    that hides the fault while burning the service.
# 4. RECOVERY RESETS STATE. Once a container reports healthy its timer clears,
#    so a later unhealthy episode must serve the full threshold again.
#
# ## Testing
#
# `docker` is injected via WATCHDOG_DOCKER_BIN so container-watchdog.test.sh can
# drive every branch against a fake, with no daemon and no real restarts. The
# clock is injected via WATCHDOG_NOW_S for the same reason — a test that had to
# sleep 600s to exercise the threshold would simply never be written.
set -uo pipefail

STATE_DIR="${WATCHDOG_STATE_DIR:-${HOME}/.local/state/ophis/watchdog}"
STATE_FILE="${STATE_DIR}/unhealthy-state"
DOCKER_BIN="${WATCHDOG_DOCKER_BIN:-docker}"
THRESHOLD_S="${WATCHDOG_THRESHOLD_S:-600}"
COOLDOWN_S="${WATCHDOG_COOLDOWN_S:-1800}"
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"

# Stateless services safe to bounce. Chain nodes and databases are NOT here.
ALLOW="${WATCHDOG_ALLOW:-driver|autopilot|orderbook|rpc-proxy|solver}"
# Explicit veto that wins over ALLOW, so a broad ALLOW pattern can never reach a
# stateful service by accident. Under the DEFAULT allowlist this is redundant --
# neither the databases nor the chain nodes match it anyway. DENY earns its keep
# only when someone widens ALLOW later, which is the realistic operator error and
# the case container-watchdog.test.sh pins (with ALLOW='.*').
DENY="${WATCHDOG_DENY:--db-|postgres|-pg-|nitro|jaeger|prometheus|alertmanager}"

now_s() { echo "${WATCHDOG_NOW_S:-$(date +%s)}"; }

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Telegram is best-effort: a watchdog that dies because a notification failed is
# worse than a silent one. Never let notify() affect the exit status.
#
# WATCHDOG_NOTIFY=0 is a HARD off switch and the test suite sets it. Without it,
# running the tests on a machine that has the bot token in its keychain would
# send real Telegram messages to a real person for fake restarts of fake
# containers. A test suite must not be able to page anyone.
notify() {
  [ "${WATCHDOG_NOTIFY:-1}" = "0" ] && return 0
  local msg="$1" token
  token="$(security find-generic-password -w -s ophis-telegram-bot 2>/dev/null)" || return 0
  [ -z "$token" ] && return 0
  curl -s --max-time 15 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${WATCHDOG_TG_CHAT:-735726338}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
  return 0
}

mkdir -p "$STATE_DIR" 2>/dev/null || true
touch "$STATE_FILE" 2>/dev/null || true

# state line format: <container> <first_unhealthy_epoch> <last_restart_epoch>
get_field() { # container, field-index(2|3)
  awk -v c="$1" -v f="$2" '$1==c {print $f; found=1} END{if(!found) print ""}' "$STATE_FILE"
}
set_state() { # container, first_unhealthy, last_restart
  local tmp; tmp="$(mktemp)"
  awk -v c="$1" '$1!=c' "$STATE_FILE" > "$tmp" 2>/dev/null || true
  echo "$1 $2 $3" >> "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}
clear_unhealthy() { # container — keep last_restart, reset the unhealthy timer
  local last; last="$(get_field "$1" 3)"; [ -z "$last" ] && last=0
  set_state "$1" 0 "$last"
}

NOW="$(now_s)"
restarted=0

# `docker ps` status strings look like: "Up 46 hours (unhealthy)".
# Read every running container, then decide per container.
while IFS=$'\t' read -r name status; do
  [ -z "$name" ] && continue

  if [[ "$status" != *"(unhealthy)"* ]]; then
    # Healthy (or has no healthcheck). Reset any pending timer — property 4.
    prev="$(get_field "$name" 2)"
    if [ -n "$prev" ] && [ "$prev" != "0" ]; then
      log "recovered: $name (clearing unhealthy timer)"
      clear_unhealthy "$name"
    fi
    continue
  fi

  # --- container is unhealthy from here down ---
  if ! [[ "$name" =~ $ALLOW ]] || [[ "$name" =~ $DENY ]]; then
    log "unhealthy but NOT allowlisted, leaving alone: $name"
    continue
  fi

  first="$(get_field "$name" 2)"
  last_restart="$(get_field "$name" 3)"
  [ -z "$first" ] && first=0
  [ -z "$last_restart" ] && last_restart=0

  if [ "$first" = "0" ]; then
    log "now unhealthy: $name (starting ${THRESHOLD_S}s timer)"
    set_state "$name" "$NOW" "$last_restart"
    continue
  fi

  unhealthy_for=$(( NOW - first ))
  if [ "$unhealthy_for" -lt "$THRESHOLD_S" ]; then
    log "unhealthy ${unhealthy_for}s < ${THRESHOLD_S}s threshold, waiting: $name"
    continue
  fi

  since_restart=$(( NOW - last_restart ))
  if [ "$last_restart" != "0" ] && [ "$since_restart" -lt "$COOLDOWN_S" ]; then
    log "unhealthy ${unhealthy_for}s but restarted ${since_restart}s ago (<${COOLDOWN_S}s cooldown), NOT restarting: $name"
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: would restart $name (unhealthy ${unhealthy_for}s)"
    continue
  fi

  log "RESTARTING $name (unhealthy ${unhealthy_for}s)"
  if "$DOCKER_BIN" restart "$name" >/dev/null 2>&1; then
    log "restarted $name"
    notify "Watchdog restarted ${name} on $(hostname): it had been unhealthy for ${unhealthy_for}s (threshold ${THRESHOLD_S}s). Docker does not restart unhealthy containers on its own. If this repeats, the restart is not the fix - look at why the healthcheck fails."
    restarted=$(( restarted + 1 ))
    # Reset the timer and stamp the restart so cooldown applies from here.
    set_state "$name" 0 "$NOW"
  else
    log "ERROR: docker restart failed for $name"
    notify "Watchdog FAILED to restart ${name} on $(hostname) after ${unhealthy_for}s unhealthy. Needs a human."
  fi
done < <("$DOCKER_BIN" ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null)

log "watchdog pass complete, ${restarted} restart(s)"
exit 0
