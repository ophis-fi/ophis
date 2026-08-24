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
cat > "$WORK/docker" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  ps)      cat "$FAKE_TABLE" ;;
  restart) echo "$2" >> "$FAKE_RESTARTS"; exit "${FAKE_RESTART_RC:-0}" ;;
  *)       exit 0 ;;
esac
FAKE
chmod +x "$WORK/docker"

run(){ # run <now> ; table + state dir already prepared by caller
  WATCHDOG_DOCKER_BIN="$WORK/docker" \
  WATCHDOG_STATE_DIR="$WORK/state" \
  WATCHDOG_NOW_S="$1" \
  WATCHDOG_NOTIFY=0 \
  WATCHDOG_ALLOW="${WATCHDOG_ALLOW:-driver|autopilot|orderbook|rpc-proxy|solver}" \
  FAKE_TABLE="$WORK/table" \
  FAKE_RESTARTS="$WORK/restarts" \
  FAKE_RESTART_RC="${FAKE_RESTART_RC:-0}" \
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

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
