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
# 5. FAIL LOUD, NEVER SILENT. If the container inventory cannot be read, or the
#    cooldown cannot be durably recorded, the run aborts or skips and notifies
#    rather than reporting a clean pass. See the blocks marked FAIL-CLOSED.
# 6. ONE PASS AT A TIME. Serialised with flock, so two overlapping cron ticks
#    cannot both read the same expired timer and restart the same container.
#
# ## Testing
#
# `docker` is injected via WATCHDOG_DOCKER_BIN so container-watchdog.test.sh can
# drive every branch against a fake, with no daemon and no real restarts. The
# clock is injected via WATCHDOG_NOW_S for the same reason — a test that had to
# sleep 600s to exercise the threshold would simply never be written.
set -uo pipefail

STATE_DIR="${WATCHDOG_STATE_DIR:-${HOME:-/tmp}/.local/state/ophis/watchdog}"
STATE_FILE="${STATE_DIR}/unhealthy-state"
LOCK_FILE="${STATE_DIR}/watchdog.lock"
DOCKER_BIN="${WATCHDOG_DOCKER_BIN:-docker}"
THRESHOLD_S="${WATCHDOG_THRESHOLD_S:-600}"
COOLDOWN_S="${WATCHDOG_COOLDOWN_S:-1800}"
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"
# Injected so the lock branch is testable on hosts without flock(1) (macOS).
FLOCK_BIN="${WATCHDOG_FLOCK_BIN:-flock}"

# Stateless services safe to bounce. Chain nodes and databases are NOT here.
#
# ⚠️ `autopilot` is DELIBERATELY ABSENT (Codex review, 2026-08-24). This watchdog
# can only ever act on containers whose docker status says `(unhealthy)`, and
# the autopilot service declares NO healthcheck in optimism-mainnet,
# robinhood-mainnet or unichain-mainnet -- verified in all three compose files.
# A stalled autopilot stays plain `Up`, so `restart: always` does nothing and so
# would this. Listing it would advertise cover for a core auction/settlement
# component that does not exist, which is worse than the gap itself.
# TO ACTUALLY COVER IT: give the autopilot a healthcheck in those stacks, then
# add it here. Until then the gap is stated rather than papered over.
#
# `rpc-proxy` likewise has no healthcheck, but its `rpc-proxy-health` SIDECAR
# does, and restart_target() maps the sidecar onto it -- so the proxy IS covered.
# `driver`, `orderbook` and the solvers all declare their own healthchecks.
ALLOW="${WATCHDOG_ALLOW:-driver|orderbook|rpc-proxy|solver}"
# Explicit veto that wins over ALLOW, so a broad ALLOW pattern can never reach a
# stateful service by accident. Under the DEFAULT allowlist this is redundant --
# neither the databases nor the chain nodes match it anyway. DENY earns its keep
# only when someone widens ALLOW later, which is the realistic operator error and
# the case container-watchdog.test.sh pins (with ALLOW='.*').
# `-chain-` (with both hyphens) matches the local Anvil node `local-chain-1`,
# which HAS a healthcheck, without matching `unichain-mainnet-*` -- there the
# preceding character is `i`, not `-`, so the Unichain driver/orderbook stay
# eligible. Restarting a dev chain discards its state, which is the same class
# of harm as bouncing a real node (Codex review, 2026-08-24).
DENY="${WATCHDOG_DENY:--db-|postgres|-pg-|nitro|-chain-|jaeger|prometheus|alertmanager}"

mkdir -p "$STATE_DIR" 2>/dev/null || true
touch "$STATE_FILE" 2>/dev/null || true

now_s() { echo "${WATCHDOG_NOW_S:-$(date +%s)}"; }
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Telegram is best-effort: a watchdog that dies because a notification failed is
# worse than a silent one. Never let notify() affect the exit status.
#
# Credential lookup is deliberately THREE-tiered. The first version called only
# `security find-generic-password`, which is a macOS Keychain command that does
# not exist on Linux — so on Cadia, the host this watchdog most needs to run on,
# every restart would have happened with NO notification at all. The file tier
# matches how settlement-anomaly-watch.sh already reads the token on the Linux
# deploy (secrets/telegram-token, chmod 600, per DEPLOY-RUNBOOK.md).
#
# WATCHDOG_NOTIFY=0 is a HARD off switch and the test suite sets it. Without it,
# running the tests on a machine that has the bot token would send real Telegram
# messages to a real person for fake restarts of fake containers. A test suite
# must not be able to page anyone.
notify() {
  [ "${WATCHDOG_NOTIFY:-1}" = "0" ] && return 0
  local msg="$1" token=""
  if [ -n "${WATCHDOG_TG_TOKEN:-}" ]; then
    token="$WATCHDOG_TG_TOKEN"
  elif [ -n "${WATCHDOG_TG_TOKEN_FILE:-}" ] && [ -r "${WATCHDOG_TG_TOKEN_FILE}" ]; then
    token="$(cat "$WATCHDOG_TG_TOKEN_FILE" 2>/dev/null)"
  elif command -v security >/dev/null 2>&1; then
    token="$(security find-generic-password -w -s ophis-telegram-bot 2>/dev/null)"
  fi
  if [ -z "$token" ]; then
    log "WARN: no Telegram credential (set WATCHDOG_TG_TOKEN or WATCHDOG_TG_TOKEN_FILE) — notification skipped"
    return 0
  fi
  curl -s --max-time 15 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${WATCHDOG_TG_CHAT:-735726338}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
  return 0
}

# ── Serialise passes (safety property 6) ────────────────────────────────────
# A pass that restarts several services and notifies for each can outlast the
# two-minute cron interval, and a double-installed cron entry produces the same
# overlap. Two concurrent passes would each read the same expired timer and both
# restart the container, and their read-modify-write of the state file would
# clobber each other. flock makes the whole pass mutually exclusive.
if [ "${WATCHDOG_SKIP_LOCK:-0}" != "1" ]; then
  if command -v "$FLOCK_BIN" >/dev/null 2>&1; then
    # ⚠️ These two failures MUST NOT be conflated (Codex review, 2026-08-24).
    # The first version was `exec 9>"$LOCK_FILE" 2>/dev/null || true`, which
    # swallowed a failure to OPEN the lock (missing/unwritable STATE_DIR). fd 9
    # then stayed closed, `flock -n 9` returned nonzero, and that was reported as
    # ordinary contention -- so every cron pass exited 0 having inspected nothing
    # and notified no one. A broken state directory silently disabled the
    # watchdog entirely: the same inert-but-healthy-looking failure this script
    # exists to prevent, reintroduced by its own locking fix.
    if ! exec 9>"$LOCK_FILE"; then
      log "FATAL: cannot open lock file ${LOCK_FILE} — state directory missing or unwritable"
      notify "Watchdog on $(hostname) cannot open its lock file at ${LOCK_FILE}. It is protecting nothing. Check that ${STATE_DIR} exists and is writable."
      exit 1
    fi
    # CONTENTION IS ASSIGNED ITS OWN EXIT CODE, rather than inferred.
    # An earlier fix here treated status 1 as contention and everything else as
    # an error, but 1 is not distinctive: util-linux flock also returns it for
    # assorted failures (and 65 for a bad file descriptor). util-linux provides
    # `-E, --conflict-exit-code <number>` precisely so the conflict case can be
    # recognised unambiguously, so we claim 99 for it. Anything else nonzero --
    # locking unsupported on the filesystem, a bad fd, a flock too old to know
    # -E (it would fail with a usage error) -- is an operational failure and is
    # fatal. Reporting any of those as "another pass is running" and exiting 0
    # would silently disable the watchdog on every tick, which is the same
    # failure the open-vs-contention split above exists to prevent, one layer
    # deeper (Codex review, 2026-08-24).
    "$FLOCK_BIN" -n -E 99 9 2>/dev/null; lock_rc=$?
    if [ "$lock_rc" -eq 99 ]; then
      log "another watchdog pass holds the lock; exiting without acting"
      exit 0
    elif [ "$lock_rc" -ne 0 ]; then
      log "FATAL: flock failed with status ${lock_rc} (not contention) — locking may be unsupported on ${STATE_DIR}"
      notify "Watchdog on $(hostname) could not lock: flock exited ${lock_rc}, which is not contention. It is protecting nothing. Check ${STATE_DIR}."
      exit 1
    fi
  else
    # macOS has no flock(1). Not fatal — an unserialised watchdog still beats
    # none — but the at-most-once-per-cooldown guarantee is weakened, so say so
    # rather than letting the operator assume property 6 holds.
    log "WARN: flock(1) unavailable — pass is NOT serialised against a concurrent run"
  fi
fi

# A failed state write makes every timing decision untrustworthy for the rest of
# the pass, so once it happens we stop taking irreversible actions rather than
# acting on a timer we could not update (Codex review, 2026-08-24).
STATE_DEGRADED=0

# state line format:
#   <container> <first_unhealthy_epoch> <last_restart_epoch> <container_id>
# The container ID is field 4. Compose reuses the NAME when it recreates a
# service, so a name-only key lets a brand-new container inherit its
# predecessor's accumulated unhealthy time and get restarted seconds after it
# starts -- while it is merely still warming up. Comparing the ID detects the
# replacement and restarts the timer. Records written before this field existed
# read back as empty and are treated as "unknown", which re-arms rather than
# assuming continuity.
get_field() { # container, field-index(2|3)
  awk -v c="$1" -v f="$2" '$1==c {print $f; found=1} END{if(!found) print ""}' "$STATE_FILE"
}
# Returns nonzero if the state could not be persisted. Callers that are about to
# take an irreversible action MUST check this (FAIL-CLOSED).
set_state() { # container, first_unhealthy, last_restart, container_id
  # Test seam. chmod-based simulation is useless under root (root bypasses the
  # discretionary permission bits), which made the fail-closed tests pass for
  # the wrong reason on an unprivileged host and FAIL outright in a root
  # container. Injecting the failure makes those cases deterministic under any
  # uid (Codex review, 2026-08-24).
  [ "${WATCHDOG_SIMULATE_STATE_FAIL:-0}" = "1" ] && return 1
  # ⚠️ The temp file MUST live in STATE_DIR (Codex review, 2026-08-24). Bare
  # `mktemp` uses /tmp, and on Linux /tmp is commonly tmpfs while the state dir
  # is on disk -- different filesystems, so the `mv` below silently degrades
  # from an atomic rename into copy-then-unlink. A crash or a full disk mid-copy
  # then leaves a truncated state file: lost cooldowns, and containers eligible
  # for restart again immediately. Same filesystem keeps the rename atomic.
  local tmp; tmp="$(mktemp "${STATE_DIR}/.state.XXXXXX" 2>/dev/null)" || return 1
  # ⚠️ The awk status is CHECKED, not discarded (Codex review, 2026-08-24).
  # It previously ended in `|| true`: if the state file became unreadable while
  # its directory stayed writable, awk produced nothing, the temp file ended up
  # holding ONLY the current container, and the mv + single-record read-back
  # both succeeded -- silently erasing every OTHER container's cooldown and
  # unhealthy timer. Those containers could then be restarted again immediately,
  # cooldown and threshold both lost, with no error anywhere.
  if ! awk -v c="$1" '$1!=c' "$STATE_FILE" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"; return 1
  fi
  echo "$1 $2 $3 ${4:-}" >> "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$STATE_FILE" || { rm -f "$tmp"; return 1; }
  # Prove it landed. A full or read-only filesystem can fail late enough that
  # mv reports success and the record still is not readable back.
  [ "$(get_field "$1" 3)" = "$3" ] || return 1
  return 0
}
clear_unhealthy() { # container, container_id — keep last_restart, reset timer
  local last; last="$(get_field "$1" 3)"; [ -z "$last" ] && last=0
  set_state "$1" 0 "$last" "$2"
}

# Health SIDECARS monitor another container and cannot fix it by restarting.
# In every stack here `rpc-proxy` declares NO healthcheck of its own; only the
# `rpc-proxy-health` sidecar does. So when eRPC stops answering it is the
# SIDECAR that reports unhealthy, and bouncing that sidecar just restarts a
# BusyBox probe loop while the broken proxy keeps running — and burns the
# cooldown against the wrong name. Map a sidecar to the container it reports on.
restart_target() {
  case "$1" in
    *-health-[0-9]*) echo "${1%-health-*}-${1##*-health-}" ;;
    *-health)        echo "${1%-health}" ;;
    *)               echo "$1" ;;
  esac
}

# ── Read the container inventory (safety property 5) ────────────────────────
# FAIL-CLOSED. This was previously `done < <(docker ps ...)`, where process
# substitution discards the exit status: if the daemon was down, the cron user
# lacked docker permission, or docker was absent from PATH, the loop saw zero
# rows and the script logged "watchdog pass complete, 0 restart(s)" and exited 0.
# The watchdog could be entirely inert while looking perfectly healthy — the
# exact class of silent-guard failure it exists to prevent.
INVENTORY="$("$DOCKER_BIN" ps --format '{{.ID}}\t{{.Names}}\t{{.Status}}' 2>&1)"
INV_RC=$?
if [ "$INV_RC" -ne 0 ]; then
  log "FATAL: cannot enumerate containers (docker ps exited ${INV_RC}): ${INVENTORY}"
  notify "Watchdog on $(hostname) CANNOT SEE CONTAINERS: docker ps exited ${INV_RC}. It is protecting nothing right now. ${INVENTORY}"
  exit 1
fi

NOW="$(now_s)"
restarted=0

# name -> container id, for the whole inventory. Needed because a health sidecar
# reports on a DIFFERENT container than the one we restart, and it is that other
# container's identity that decides whether the timer should re-arm.
declare_ids() { awk -F'\t' 'NF>=3 {print $2" "$1}' <<< "$INVENTORY"; }
IDS="$(declare_ids)"
id_of() { awk -v n="$1" '$1==n {print $2; found=1} END{if(!found) print ""}' <<< "$IDS"; }

while IFS=$'\t' read -r cid name status; do
  [ -z "$name" ] && continue

  if [[ "$status" != *"(unhealthy)"* ]]; then
    prev="$(get_field "$name" 2)"
    if [ -n "$prev" ] && [ "$prev" != "0" ]; then
      log "recovered: $name (clearing unhealthy timer)"
      if ! clear_unhealthy "$name" "$cid"; then
        # FAIL-CLOSED. A stale first_unhealthy left behind here would be
        # inherited by the NEXT unhealthy episode, which could then be restarted
        # before serving the full threshold. Refuse to act on timers we could
        # not update.
        log "FATAL: could not clear recovery state for $name — timers are now untrustworthy, refusing further restarts this pass"
        notify "Watchdog on $(hostname) could not clear recovery state for ${name}. Refusing to restart anything this pass because its timers can no longer be trusted. Check ${STATE_DIR}."
        STATE_DEGRADED=1
      fi
    fi
    continue
  fi

  # --- container is unhealthy from here down ---
  target="$(restart_target "$name")"
  [ "$target" != "$name" ] && log "note: $name is a health sidecar; restart target is $target"

  # ALLOW/DENY is decided on the TARGET, not the reporting sidecar — otherwise a
  # sidecar named `<something-db>-health` could smuggle a database past DENY.
  if ! [[ "$target" =~ $ALLOW ]] || [[ "$target" =~ $DENY ]]; then
    log "unhealthy but NOT allowlisted, leaving alone: $name (target $target)"
    continue
  fi

  first="$(get_field "$name" 2)"
  last_restart="$(get_field "$name" 3)"
  known_id="$(get_field "$name" 4)"
  # ⚠️ Track the identity of the container we would RESTART, not the one that
  # reported (Codex review, 2026-08-24). compose-up.sh force-recreates
  # `rpc-proxy` while leaving `rpc-proxy-health` running, so a sidecar keeps its
  # own ID across a proxy replacement. Keying on the sidecar's ID would carry an
  # expired timer straight onto a brand-new proxy and restart it while it is
  # still warming up -- exactly the case the threshold exists to prevent.
  track_id="$cid"
  if [ "$target" != "$name" ]; then
    track_id="$(id_of "$target")"
    [ -z "$track_id" ] && track_id="missing:$target"
  fi
  [ -z "$first" ] && first=0
  [ -z "$last_restart" ] && last_restart=0

  # Compose reuses the NAME on recreate. If the ID moved (or we never recorded
  # one), this is a different container and must serve the threshold from
  # scratch -- otherwise a freshly started replacement inherits its
  # predecessor's accumulated time and gets restarted while it is still warming
  # up, which is precisely the flap the threshold exists to prevent.
  # FAIL-CLOSED, both branches. A failure to ARM the timer used to log WARN and
  # continue, and the pass still ended "watchdog pass complete" with exit 0. But
  # `first` stays 0 forever, so on EVERY later pass this same branch is retaken:
  # the threshold is never reached, the container is never restarted, and nobody
  # is told. A watchdog that can never act is the failure mode this whole script
  # exists to remove, so it must be as loud as an unrecordable cooldown
  # (Codex review, 2026-08-24).
  if [ "$first" != "0" ] && [ "$known_id" != "$track_id" ]; then
    log "container replaced: $name (restart target id ${known_id:-none} -> ${track_id}); restarting the ${THRESHOLD_S}s timer"
    if ! set_state "$name" "$NOW" "$last_restart" "$track_id"; then
      log "FATAL: cannot arm the timer for $name — it can never reach the restart threshold"
      notify "Watchdog on $(hostname) cannot write its state, so ${name} can never reach its restart threshold. It is unhealthy and unprotected. Check ${STATE_DIR}."
      STATE_DEGRADED=1
    fi
    continue
  fi

  if [ "$first" = "0" ]; then
    log "now unhealthy: $name (starting ${THRESHOLD_S}s timer)"
    if ! set_state "$name" "$NOW" "$last_restart" "$track_id"; then
      log "FATAL: cannot arm the timer for $name — it can never reach the restart threshold"
      notify "Watchdog on $(hostname) cannot write its state, so ${name} can never reach its restart threshold. It is unhealthy and unprotected. Check ${STATE_DIR}."
      STATE_DEGRADED=1
    fi
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

  if [ "$STATE_DEGRADED" = "1" ]; then
    log "state is degraded this pass; NOT restarting $target"
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: would restart $target (reported by $name, unhealthy ${unhealthy_for}s)"
    continue
  fi

  # FAIL-CLOSED. Stamp the cooldown BEFORE restarting. If the state write failed
  # after a successful restart, the stored record would still read
  # last_restart=0 with an expired timer, so every subsequent two-minute pass
  # would restart the same container again — an unbounded restart loop caused by
  # a full disk. Writing first makes the worst case a restart we recorded but
  # did not perform, which the next pass simply retries after the cooldown.
  if ! set_state "$name" 0 "$NOW" "$track_id"; then
    log "FATAL: cannot persist cooldown for $name — refusing to restart (a restart we cannot record becomes a restart loop)"
    notify "Watchdog on $(hostname) could NOT write its state file, so it refused to restart ${target} after ${unhealthy_for}s unhealthy. Check disk and permissions on ${STATE_DIR}. Needs a human."
    continue
  fi

  log "RESTARTING $target (reported by $name, unhealthy ${unhealthy_for}s)"
  if "$DOCKER_BIN" restart "$target" >/dev/null 2>&1; then
    log "restarted $target"
    notify "Watchdog restarted ${target} on $(hostname): it had been unhealthy for ${unhealthy_for}s (threshold ${THRESHOLD_S}s). Docker does not restart unhealthy containers on its own. If this repeats, the restart is not the fix - look at why the healthcheck fails."
    restarted=$(( restarted + 1 ))
  else
    log "ERROR: docker restart failed for $target"
    notify "Watchdog FAILED to restart ${target} on $(hostname) after ${unhealthy_for}s unhealthy. Needs a human."
  fi
done <<< "$INVENTORY"

if [ "$STATE_DEGRADED" = "1" ]; then
  # The pass ran, but its timing decisions were made against state it could not
  # update. Reporting exit 0 would let cron and any wrapper treat a watchdog
  # that is no longer protecting anything as a healthy one (Codex review,
  # 2026-08-24).
  log "watchdog pass complete but DEGRADED (state could not be written), ${restarted} restart(s)"
  exit 1
fi
log "watchdog pass complete, ${restarted} restart(s)"
exit 0
