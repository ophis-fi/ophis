#!/usr/bin/env bash
# Tests for container-watchdog.sh.
#
# DETERMINISTIC: never touches a real docker daemon, never restarts a real
# container, never contacts Telegram (WATCHDOG_NOTIFY=0 is set for every case —
# without it, running this on a machine holding the bot token would page a real
# person for fake restarts of fake containers).
#
# `docker` is a fake script that (a) prints a container table the test controls
# and (b) APPENDS every restart it is asked to perform to a log. Asserting on
# that log is what keeps these tests non-vacuous: "no restart happened" and "the
# script crashed before reaching the restart" look identical if you only check
# an exit code, and that is precisely the trap the op-healthcheck suite documents.
# Every negative case here asserts the restart log is empty AND that the run
# reported a completed pass, so a crash cannot masquerade as a pass.
#
# The clock is injected (WATCHDOG_NOW_S) because a suite that had to sleep 600s
# to reach the threshold would never be run, and an untested threshold is the
# same as no threshold.
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/container-watchdog.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ck(){ if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; pass=$((pass+1));
      else echo "  FAIL  $1: expected '$3' got '$2'"; fail=$((fail+1)); fi; }

[ -f "$SRC" ] || { echo "FATAL: cannot find $SRC"; exit 1; }

# --- fake docker -------------------------------------------------------------
# `ps` echoes $WORK/table; `restart <name>` appends to $WORK/restarts.
# `ps` emits <id>\t<name>\t<status>. Fixtures may give only <name>\t<status>,
# in which case a STABLE synthetic id is derived from the name -- so a container
# keeps its identity across passes unless a fixture deliberately supplies a
# different id to simulate a Compose recreate.
cat > "$WORK/docker" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  ps)      awk -F'\t' 'NF==2{print "id-"$1"\t"$1"\t"$2} NF>=3{print}' "$FAKE_TABLE" ;;
  restart) echo "$2" >> "$FAKE_RESTARTS"; exit "${FAKE_RESTART_RC:-0}" ;;
  *)       exit 0 ;;
esac
FAKE
chmod +x "$WORK/docker"

# ⚠️ WATCHDOG_ALLOW is forwarded ONLY when the caller set it. An earlier version
# always passed a hardcoded default, which meant the script's OWN default
# allowlist was never exercised -- so changing it (e.g. re-adding `autopilot`)
# could not fail any test. Mutation testing caught that: the "autopilot re-added
# to allowlist" mutation survived because the harness was overriding the very
# value under test.
run(){ # run <now> ; table + state dir already prepared by caller
  local extra=()
  [ -n "${WATCHDOG_ALLOW:-}" ] && extra+=("WATCHDOG_ALLOW=$WATCHDOG_ALLOW")
  [ -n "${WATCHDOG_DENY:-}" ] && extra+=("WATCHDOG_DENY=$WATCHDOG_DENY")
  env \
    WATCHDOG_DOCKER_BIN="$WORK/docker" \
    WATCHDOG_STATE_DIR="$WORK/state" \
    WATCHDOG_NOW_S="$1" \
    WATCHDOG_NOTIFY=0 \
    WATCHDOG_SIMULATE_STATE_FAIL="${WATCHDOG_SIMULATE_STATE_FAIL:-0}" \
    FAKE_TABLE="$WORK/table" \
    FAKE_RESTARTS="$WORK/restarts" \
    FAKE_RESTART_RC="${FAKE_RESTART_RC:-0}" \
    ${extra[@]+"${extra[@]}"} \
    bash "$SRC" 2>&1
}
reset(){ rm -rf "$WORK/state" "$WORK/restarts"; mkdir -p "$WORK/state"; : > "$WORK/restarts"; }
restarts(){ tr -d ' \n' < "$WORK/restarts"; }
# Guards against a crash being read as "no restart": every run must reach the end.
completed(){ grep -c "watchdog pass complete" <<<"$1"; }

echo "container-watchdog tests"

# 1. healthy container is never touched
reset
printf 'robinhood-mainnet-driver-1\tUp 46 hours (healthy)\n' > "$WORK/table"
out="$(run 1000)"
ck "healthy container not restarted"        "$(restarts)" ""
ck "  (run completed, not crashed)"         "$(completed "$out")" "1"

# 2. unhealthy but under threshold: timer starts, no restart
reset
printf 'robinhood-mainnet-driver-1\tUp 46 hours (unhealthy)\n' > "$WORK/table"
out="$(run 1000)"
ck "first unhealthy sighting does not restart" "$(restarts)" ""
out="$(run 1100)"   # 100s elapsed, threshold is 600
ck "unhealthy 100s < 600s does not restart"    "$(restarts)" ""
ck "  (run completed)"                         "$(completed "$out")" "1"

# 3. sustained past the threshold DOES restart  <-- the whole point
out="$(run 1700)"   # 700s since first sighting at t=1000
ck "unhealthy 700s > 600s RESTARTS"            "$(restarts)" "robinhood-mainnet-driver-1"

# 4. cooldown blocks a second restart
printf 'robinhood-mainnet-driver-1\tUp 1 minute (unhealthy)\n' > "$WORK/table"
out="$(run 1800)"   # re-arms timer at 1800 (state was reset by the restart)
out="$(run 2500)"   # 700s unhealthy again, but only 800s since the restart
ck "restart within 1800s cooldown suppressed" "$(restarts)" "robinhood-mainnet-driver-1"
ck "  (run completed, not crashed)"           "$(completed "$out")" "1"

# 5. past the cooldown, it may restart again
out="$(run 4000)"   # 2200s since the restart at 1800, unhealthy since 1800
ck "restart allowed after cooldown expires"   "$(restarts)" "robinhood-mainnet-driver-1robinhood-mainnet-driver-1"

# 6. a database is never restarted, however long it is unhealthy
reset
printf 'robinhood-mainnet-db-1\tUp 3 days (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null; out="$(run 99000)"
ck "database NEVER restarted (not allowlisted)" "$(restarts)" ""
ck "  (run completed)"                          "$(completed "$out")" "1"

# 7. DENY is the backstop for a MISCONFIGURED allowlist, so it has to be tested
#    under that misconfiguration. Under the default ALLOW neither the db nor
#    nitro matches in the first place, so a naive "nitro is not restarted" case
#    passes without ever exercising DENY — it was vacuous, and mutation testing
#    caught it: deleting the DENY veto left the whole suite green.
#    Here ALLOW is deliberately widened to match everything, which is exactly
#    the operator error DENY exists to survive.
reset
printf 'robinhood-nitro-nitro-1\tUp 4 days (unhealthy)\nrobinhood-mainnet-db-1\tUp 4 days (unhealthy)\nrobinhood-mainnet-driver-1\tUp 4 days (unhealthy)\n' > "$WORK/table"
WATCHDOG_ALLOW='.*' run 1000 >/dev/null
out="$(WATCHDOG_ALLOW='.*' run 99000)"
ck "wide-open ALLOW: DENY still protects nitro+db" "$(restarts)" "robinhood-mainnet-driver-1"
ck "  (run completed)"                             "$(completed "$out")" "1"

# 8. recovery clears the timer, so the next episode serves the FULL threshold.
#    Without this a container that flaps unhealthy/healthy would accumulate
#    credit and get bounced on a brief blip.
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null                                    # timer starts at 1000
printf 'robinhood-mainnet-driver-1\tUp 1 hour (healthy)\n' > "$WORK/table"
run 1300 >/dev/null                                    # recovers -> timer cleared
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1400 >/dev/null                                    # unhealthy again, timer restarts here
out="$(run 1900)"                                      # only 500s since re-arm, < 600
ck "recovery reset the timer (no restart at 500s)"  "$(restarts)" ""
out="$(run 2100)"                                      # now 700s since re-arm
ck "  and it restarts once the full threshold passes" "$(restarts)" "robinhood-mainnet-driver-1"

# 9. a failing `docker restart` is reported, not silently swallowed
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null
FAKE_RESTART_RC=1 out="$(FAKE_RESTART_RC=1 run 1700)"
ck "failed restart logs an ERROR" "$(grep -c 'ERROR: docker restart failed' <<<"$out")" "1"

# 10. multiple unhealthy allowlisted containers are each handled
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\nrobinhood-mainnet-orderbook-1\tUp 1 hour (unhealthy)\nrobinhood-mainnet-db-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null; out="$(run 1700)"
got="$(sort "$WORK/restarts" | tr -d ' \n')"
ck "both allowlisted restarted, db untouched" "$got" "robinhood-mainnet-driver-1robinhood-mainnet-orderbook-1"


# ── Codex review 2026-08-24: the health-sidecar indirection ──
# In every stack `rpc-proxy` declares NO healthcheck; only `rpc-proxy-health`
# does. So an eRPC outage surfaces as the SIDECAR going unhealthy. Restarting
# the sidecar bounces a BusyBox probe loop and leaves the broken proxy running,
# while burning the cooldown against the wrong name. The restart must land on
# the proxy.
reset
printf 'optimism-mainnet-rpc-proxy-health-1\tUp 13 days (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null; out="$(run 1700)"
ck "health sidecar restarts the PROXY, not the sidecar" "$(restarts)" "optimism-mainnet-rpc-proxy-1"
ck "  (run completed)"                                  "$(completed "$out")" "1"

# The sidecar mapping must not become a way around DENY: a hypothetical
# `<db>-health` sidecar maps to a database, and the database must still win.
reset
printf 'robinhood-mainnet-db-health-1\tUp 3 days (unhealthy)\n' > "$WORK/table"
WATCHDOG_ALLOW='.*' run 1000 >/dev/null
out="$(WATCHDOG_ALLOW='.*' run 99000)"
ck "sidecar cannot smuggle a db past DENY"              "$(restarts)" ""

# ── Codex review 2026-08-24: inventory failure must be LOUD ──
# Previously `done < <(docker ps ...)` discarded the exit status, so a dead
# daemon / missing permission / docker-not-on-PATH produced zero rows and a
# cheerful "0 restart(s)" exit 0. The watchdog would be inert and look healthy.
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
cat > "$WORK/docker-broken" <<'FAKE'
#!/usr/bin/env bash
echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2
exit 1
FAKE
chmod +x "$WORK/docker-broken"
out="$(WATCHDOG_DOCKER_BIN="$WORK/docker-broken" WATCHDOG_STATE_DIR="$WORK/state" \
       WATCHDOG_NOW_S=1000 WATCHDOG_NOTIFY=0 FAKE_TABLE="$WORK/table" \
       FAKE_RESTARTS="$WORK/restarts" bash "$SRC" 2>&1)"
rc=$?
ck "docker ps failure exits NONZERO"                    "$rc" "1"
ck "docker ps failure is logged FATAL"                  "$(grep -c 'FATAL: cannot enumerate containers' <<<"$out")" "1"
ck "docker ps failure does NOT claim a clean pass"      "$(completed "$out")" "0"

# ── Codex review 2026-08-24: unrecordable cooldown must block the restart ──
# If the cooldown cannot be persisted, a restart would repeat every cron tick
# forever. Refusing to restart is the safe failure: the next pass retries.
# ⚠️ The failure is INJECTED, not simulated with chmod. Root bypasses the
# discretionary permission bits, so chmod 500 leaves the directory writable for
# root: on an unprivileged host these cases passed for the wrong reason, and in
# a root container they failed outright. Injection is deterministic under any
# uid (Codex review, 2026-08-24).
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null
out="$(WATCHDOG_SIMULATE_STATE_FAIL=1 run 1700)"
ck "unwritable state REFUSES to restart"                "$(restarts)" ""
ck "  and says so loudly"                               "$(grep -c 'FATAL: cannot persist cooldown' <<<"$out")" "1"

# ── Codex re-review 2026-08-24: a lock we cannot OPEN is not "contention" ──
# The first locking fix used `exec 9>"$LOCK" 2>/dev/null || true`, which
# swallowed a failed open. fd 9 stayed closed, flock then returned nonzero, and
# that was reported as another pass holding the lock -- so a missing or
# unwritable state directory made every cron pass exit 0 having done nothing.
# A fake flock is injected because macOS has no flock(1); without the seam this
# branch would be untested on the machine it was written on.
cat > "$WORK/flock-ok" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "$WORK/flock-ok"
printf 'x' > "$WORK/regularfile"
out="$(WATCHDOG_DOCKER_BIN="$WORK/docker" WATCHDOG_STATE_DIR="$WORK/regularfile/sub" \
      WATCHDOG_FLOCK_BIN="$WORK/flock-ok" WATCHDOG_NOW_S=1000 WATCHDOG_NOTIFY=0 \
      FAKE_TABLE="$WORK/table" FAKE_RESTARTS="$WORK/restarts" bash "$SRC" 2>&1)"
rc=$?
ck "unopenable lock exits NONZERO"                  "$rc" "1"
ck "unopenable lock is FATAL, not 'contention'"     "$(grep -c 'FATAL: cannot open lock file' <<<"$out")" "1"
ck "  and does not claim a completed pass"          "$(completed "$out")" "0"

# Genuine contention still exits 0 quietly.
# Contention is now signalled by the code we pass via -E, not by a bare 1.
cat > "$WORK/flock-busy" <<'FAKE'
#!/usr/bin/env bash
exit 99
FAKE
chmod +x "$WORK/flock-busy"
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
out="$(WATCHDOG_DOCKER_BIN="$WORK/docker" WATCHDOG_STATE_DIR="$WORK/state" \
      WATCHDOG_FLOCK_BIN="$WORK/flock-busy" WATCHDOG_NOW_S=1000 WATCHDOG_NOTIFY=0 \
      FAKE_TABLE="$WORK/table" FAKE_RESTARTS="$WORK/restarts" bash "$SRC" 2>&1)"
rc=$?
ck "genuine lock contention exits 0"                "$rc" "0"
ck "  and reports contention, not a fatal"          "$(grep -c 'another watchdog pass holds the lock' <<<"$out")" "1"

# ── Codex re-review 2026-08-24: Compose recreate must re-arm the timer ──
# Compose reuses the service NAME. Without an identity check a brand-new
# container inherits its predecessor's accumulated unhealthy time and is
# restarted on its FIRST observation, while it is merely still starting.
reset
printf 'id-old\trobinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null            # timer starts at 1000 against id-old
printf 'id-new\trobinhood-mainnet-driver-1\tUp 3 seconds (unhealthy)\n' > "$WORK/table"
out="$(run 1700)"              # 700s later, but this is a DIFFERENT container
ck "recreated container does NOT inherit the timer" "$(restarts)" ""
ck "  and the replacement is logged"                "$(grep -c 'container replaced' <<<"$out")" "1"
out="$(run 2450)"              # 750s after the replacement was first seen
ck "  it restarts once IT has served the threshold" "$(restarts)" "robinhood-mainnet-driver-1"

# ── Codex re-review 2026-08-24: unclearable recovery state fails closed ──
# A stale first_unhealthy left behind on a healthy observation would be
# inherited by the next unhealthy episode and shorten its threshold.
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\nrobinhood-mainnet-orderbook-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null
printf 'robinhood-mainnet-driver-1\tUp 1 hour (healthy)\nrobinhood-mainnet-orderbook-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
out="$(WATCHDOG_SIMULATE_STATE_FAIL=1 run 1700)"
ck "unclearable recovery blocks restarts this pass" "$(restarts)" ""
ck "  and says the timers are untrustworthy"        "$(grep -c 'refusing further restarts this pass' <<<"$out")" "1"

# ── Codex round 3, 2026-08-24: an unreadable state file must not be rewritten ──
# `awk ... || true` used to discard the read error, so the temp file held ONLY
# the container being written and the mv + read-back both succeeded -- erasing
# every OTHER container's cooldown and timer with no error anywhere. Those
# containers could then be restarted again immediately.
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\nrobinhood-mainnet-orderbook-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null                                   # both timers recorded
before=$(wc -l < "$WORK/state/unhealthy-state" | tr -d ' ')
# A DIRECTORY where the state file belongs makes awk's read fail for root too,
# unlike chmod 000. That is what exercises the read guard specifically.
mv "$WORK/state/unhealthy-state" "$WORK/state/real-state"
mkdir -p "$WORK/state/unhealthy-state"
out="$(run 1700)"
rm -rf "$WORK/state/unhealthy-state"   # set_state's mktemp may have landed inside it
mv "$WORK/state/real-state" "$WORK/state/unhealthy-state"
after=$(wc -l < "$WORK/state/unhealthy-state" | tr -d ' ')
ck "unreadable state file is NOT silently rewritten"  "$after" "$before"
ck "  and no restart happens on unreadable state"     "$(restarts)" ""

# ── Codex round 3: the local Anvil chain is behind the deny veto ──
# infra/local/docker-compose.fork.yml defines `chain` WITH a healthcheck, so
# `local-chain-1` is restartable under a widened allowlist. Restarting a dev
# chain discards its state.
reset
printf 'local-chain-1\tUp 2 hours (unhealthy)\nunichain-mainnet-driver-1\tUp 2 hours (unhealthy)\n' > "$WORK/table"
WATCHDOG_ALLOW='.*' run 1000 >/dev/null
out="$(WATCHDOG_ALLOW='.*' run 99000)"
ck "local-chain denied, unichain driver still eligible" "$(restarts)" "unichain-mainnet-driver-1"

# ── Codex round 3: a sidecar must track the TARGET's identity ──
# compose-up.sh force-recreates rpc-proxy while leaving rpc-proxy-health running,
# so the sidecar keeps its own ID across a proxy replacement. Keying on the
# sidecar would carry an expired timer onto a brand-new proxy.
reset
printf 'sc-1\toptimism-mainnet-rpc-proxy-health-1\tUp 13 days (unhealthy)\nprox-old\toptimism-mainnet-rpc-proxy-1\tUp 13 days (healthy)\n' > "$WORK/table"
run 1000 >/dev/null                                   # timer armed against prox-old
# proxy recreated (new id), sidecar untouched (same id)
printf 'sc-1\toptimism-mainnet-rpc-proxy-health-1\tUp 13 days (unhealthy)\nprox-new\toptimism-mainnet-rpc-proxy-1\tUp 2 seconds (healthy)\n' > "$WORK/table"
out="$(run 1700)"
ck "proxy replaced under a stable sidecar: timer re-arms" "$(restarts)" ""
ck "  and the replacement is noticed"                    "$(grep -c 'container replaced' <<<"$out")" "1"
out="$(run 2450)"
ck "  restarts only after the NEW proxy serves the threshold" "$(restarts)" "optimism-mainnet-rpc-proxy-1"

# ── Codex round 4: failing to ARM the timer must be as loud as a failed cooldown ──
# Previously a WARN, and the pass still ended "watchdog pass complete" exit 0.
# But `first` stays 0, so every later pass retakes the same branch: the container
# never reaches the threshold, is never restarted, and nobody is told. A watchdog
# that can never act is precisely the failure this script exists to remove.
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
out="$(WATCHDOG_SIMULATE_STATE_FAIL=1 run 1000)"
ck "un-armable timer is FATAL, not a WARN"        "$(grep -c 'FATAL: cannot arm the timer' <<<"$out")" "1"
ck "  and no restart is attempted"                "$(restarts)" ""
# ...and it must still be un-armed on the next pass, i.e. it never silently
# accumulates credit it did not earn.
out="$(WATCHDOG_SIMULATE_STATE_FAIL=1 run 9000)"
ck "  still refuses hours later (never armed)"    "$(restarts)" ""

# ── Codex round 4: autopilot must NOT be allowlisted ──
# It declares no healthcheck in optimism-mainnet, robinhood-mainnet or
# unichain-mainnet, so it can never report "(unhealthy)" and this watchdog can
# never help it. Listing it would advertise cover that does not exist. If a
# healthcheck is added to those stacks, add it here and delete this case.
reset
printf 'robinhood-mainnet-autopilot-1\tUp 2 days (unhealthy)\nrobinhood-mainnet-driver-1\tUp 2 days (unhealthy)\n' > "$WORK/table"
run 1000 >/dev/null; out="$(run 1700)"
ck "autopilot NOT restarted (no healthcheck exists)" "$(restarts)" "robinhood-mainnet-driver-1"

# ── Codex round 5: a degraded pass must not report success ──
# It ran, but every timing decision was made against state it could not update.
# Exiting 0 lets cron and any wrapper treat a watchdog that is protecting
# nothing as healthy.
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
WATCHDOG_SIMULATE_STATE_FAIL=1 run 1000 >/dev/null 2>&1
rc=$?
ck "degraded pass exits NONZERO"                  "$rc" "1"
out="$(WATCHDOG_SIMULATE_STATE_FAIL=1 run 1000)"
ck "  and says DEGRADED, not a clean completion"  "$(grep -c 'DEGRADED' <<<"$out")" "1"

# ── Codex round 5: an operational flock error is not contention ──
# flock -n exits 1 when it cannot ACQUIRE. Any other status is an error
# (unsupported filesystem, bad fd, missing binary). Treating those as "another
# pass is running" silently disables the watchdog on every tick.
cat > "$WORK/flock-broken" <<'FAKE'
#!/usr/bin/env bash
exit 64
FAKE
chmod +x "$WORK/flock-broken"
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
out="$(WATCHDOG_DOCKER_BIN="$WORK/docker" WATCHDOG_STATE_DIR="$WORK/state" \
      WATCHDOG_FLOCK_BIN="$WORK/flock-broken" WATCHDOG_NOW_S=1000 WATCHDOG_NOTIFY=0 \
      FAKE_TABLE="$WORK/table" FAKE_RESTARTS="$WORK/restarts" bash "$SRC" 2>&1)"
rc=$?
ck "flock error (rc=64) exits NONZERO"            "$rc" "1"
# A bare 1 is NOT contention any more: util-linux returns it for assorted
# failures, which is why contention gets its own code via -E.
cat > "$WORK/flock-one" <<'FAKE'
#!/usr/bin/env bash
exit 1
FAKE
chmod +x "$WORK/flock-one"
out1="$(WATCHDOG_DOCKER_BIN="$WORK/docker" WATCHDOG_STATE_DIR="$WORK/state" \
       WATCHDOG_FLOCK_BIN="$WORK/flock-one" WATCHDOG_NOW_S=1000 WATCHDOG_NOTIFY=0 \
       FAKE_TABLE="$WORK/table" FAKE_RESTARTS="$WORK/restarts" bash "$SRC" 2>&1)"
rc1=$?
ck "bare rc=1 is an ERROR, not contention"       "$rc1" "1"
ck "  and is not reported as contention"         "$(grep -c 'another watchdog pass holds the lock' <<<"$out1")" "0"
ck "  and is NOT reported as contention"          "$(grep -c 'another watchdog pass holds the lock' <<<"$out")" "0"
ck "  it is reported as a lock FAILURE"           "$(grep -c 'FATAL: flock failed with status 64' <<<"$out")" "1"

# ── Codex round 5: the state temp file must share the state dir's filesystem ──
# Bare mktemp uses /tmp; on Linux that is commonly tmpfs while the state dir is
# on disk, so `mv` degrades from an atomic rename to copy-then-unlink and a
# crash mid-copy truncates the state file.
# Behavioural discriminator rather than a grep of the source: point TMPDIR at a
# path that does not exist. A bare `mktemp` honours TMPDIR and fails there; one
# that names STATE_DIR explicitly ignores it and succeeds. So state writes still
# working under a broken TMPDIR proves the temp file shares the state dir's
# filesystem, which is what makes the later `mv` an atomic rename.
#
# ⚠️ PLATFORM CAVEAT, verified 2026-08-24: this case only DISCRIMINATES on Linux.
# macOS mktemp ignores TMPDIR entirely (it uses /var/folders/...), so on a Mac
# the mutated and unmutated scripts both pass and the "temp file back on /tmp"
# mutation appears to survive. On Linux -- which is where CI runs, and where the
# bug actually bites because /tmp is commonly tmpfs while the state dir is on
# disk -- the mutated script fails this case. Confirmed by running this suite in
# an alpine container: 53/53 unmutated, 51/53 with bare mktemp.
# If you are running locally on a Mac and see that mutation survive, that is
# expected; check it in CI or in a Linux container before assuming a gap.
reset
printf 'robinhood-mainnet-driver-1\tUp 1 hour (unhealthy)\n' > "$WORK/table"
TMPDIR=/nonexistent/definitely run 1000 >/dev/null
ck "state is written even with TMPDIR broken"     "$(awk '$1=="robinhood-mainnet-driver-1"{print $2}' "$WORK/state/unhealthy-state")" "1000"
TMPDIR=/nonexistent/definitely run 1700 >/dev/null
ck "  and the restart still fires from that state" "$(restarts)" "robinhood-mainnet-driver-1"
ck "  no stray temp files left behind"            "$(find "$WORK/state" -name '.state.*' | wc -l | tr -d ' ')" "0"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
