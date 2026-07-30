#!/usr/bin/env bash
# Tests for op-healthcheck.sh's alert state machine.
#
# DETERMINISTIC: probes a LOCAL fixture server whose responses we control, never the
# live production endpoint. The earlier version pointed tests 4 and 5 at
# optimism-mainnet.ophis.fi, which made them depend on current production health and
# let Test 4 pass VACUOUSLY — it asserted only that state stayed "down", which is
# also what happens when the probe fails and the notification is suppressed. It could
# not distinguish "recovery path ran and delivery failed" from "never recovered".
#
# Telegram is never contacted for real: TG_ENV points at a token the API rejects, so
# notify() genuinely fails end to end, which IS the condition under test.
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/op-healthcheck.sh"
WORK="$(mktemp -d)"
cleanup(){ [[ -n "${FIXPID:-}" ]] && kill "$FIXPID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
pass=0; fail=0
ck(){ if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; pass=$((pass+1));
      else echo "  FAIL  $1: expected '$3' got '$2'"; fail=$((fail+1)); fi; }

# Find an interpreter that actually RUNS. `command -v python3` is not enough: a
# shim earlier in PATH (e.g. the modern-python plugin's) can exist and then refuse
# to execute, which silently left the fixture dead and made every probe fail — the
# suite still reported passes because most assertions expect the failure path. That
# is precisely the vacuous-test trap this file is supposed to avoid.
PYBIN=""
for cand in "python3" "uv run python"; do
  if $cand -c 'print(1)' >/dev/null 2>&1; then PYBIN="$cand"; break; fi
done
# FAIL, do not skip. A suite that exits 0 having run zero assertions reports green
# while the state machine is entirely untested — the same false-confidence this file
# exists to prevent, and inconsistent with the fail-closed fixture checks below.
[[ -n "$PYBIN" ]] || { echo "FATAL: no working python3 (tried: python3, uv run python) — cannot run the fixture, refusing to report success"; exit 1; }

# --- fixture: replies with whatever status code $WORK/mode contains --------------
cat > "$WORK/fixture.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def _code(self):
        try:
            return int(open(MODE).read().strip())
        except Exception:
            return 500
    def _reply(self):
        c = self._code(); self.send_response(c); self.end_headers(); self.wfile.write(b'{}')
    do_GET = _reply
    do_POST = _reply
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
PORT="$($PYBIN -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()' 2>/dev/null)"
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "FATAL: could not allocate a fixture port via '$PYBIN'"; exit 1; }
printf '200' > "$WORK/mode"
$PYBIN "$WORK/fixture.py" "$PORT" "$WORK/mode" & FIXPID=$!
fixture_up=no
for _ in $(seq 1 40); do
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/"; then fixture_up=yes; break; fi
  sleep 0.25
done
# Refuse to run blind. Without this the fixture can be dead and every probe fails,
# which most assertions here happen to tolerate -> a green suite that proved nothing.
[[ "$fixture_up" == "yes" ]] || { echo "FATAL: fixture server never came up on 127.0.0.1:$PORT — refusing to run tests against a dead endpoint"; exit 1; }
# Sanity-check that the fixture is actually controllable, so a mis-set mode cannot
# masquerade as a code behaviour.
printf '502' > "$WORK/mode"
got="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
[[ "$got" == "502" ]] || { echo "FATAL: fixture ignored mode file (asked 502, got $got)"; exit 1; }
printf '200' > "$WORK/mode"
BASE_URL="http://127.0.0.1:$PORT/api/v1"
printf 'TELEGRAM_BOT_TOKEN=000000:INVALID-TOKEN-FOR-TESTING\n' > "$WORK/bad-tg.env"

mode(){ printf '%s' "$1" > "$WORK/mode"; }
run(){ # statedir [extra env assignments...]
  local sd="$1"; shift
  sed -e "s|^STATE_DIR=.*|STATE_DIR=\"$sd\"|" -e "s|^BASE=.*|BASE=\"$BASE_URL\"|" "$SRC" > "$WORK/hc.sh"
  ( export TELEGRAM_BOT_TOKEN_ENV_FILE="$WORK/bad-tg.env" OPHIS_BOOT_GRACE_SECONDS=0 "$@"; bash "$WORK/hc.sh" ) >"$WORK/out.log" 2>&1
}
st(){ cat "$1/op-health.state" 2>/dev/null; }

echo "TEST 1: undelivered DOWN page must not advance belief (so it retries)"
SD="$WORK/s1"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; mode 502
run "$SD"
ck "belief stays 'up' -> page will retry" "$(st "$SD")" "up"
ck "logged as undelivered" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"

echo
echo "TEST 2: it retries on the next run rather than going quiet"
run "$SD"
ck "still retrying" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"
ck "belief still 'up'" "$(st "$SD")" "up"

echo
echo "TEST 3: boot grace suppresses the cold-boot page and touches no state"
SD="$WORK/s3"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; mode 502
run "$SD" OPHIS_BOOT_GRACE_SECONDS=99999999
ck "grace applied" "$(grep -c 'boot grace' "$WORK/out.log")" "1"
ck "no send attempted" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "0"
ck "state untouched" "$(st "$SD")" "up"

echo
echo "TEST 4 (REGRESSION, Codex 2026-07-30): a failed RECOVERED must not suppress a"
echo "        later genuine outage. Belief stays 'down', so when the service drops"
echo "        again belief already matches reality and no transition is consumed."
SD="$WORK/s4"; mkdir -p "$SD"; echo down > "$SD/op-health.state"
mode 200                       # service recovers; the RECOVERED send will fail
run "$SD"
ck "recovery path RAN and delivery failed" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"
ck "belief stays 'down' -> recovery ping retries" "$(st "$SD")" "down"
mode 502                       # second outage, before recovery was ever delivered
run "$SD"
ck "belief still 'down' (matches reality; nothing owed)" "$(st "$SD")" "down"
ck "no spurious send attempted" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "0"

echo
echo "TEST 5: healthy service, belief already 'up' -> silent success"
SD="$WORK/s5"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; mode 200
run "$SD"
ck "belief 'up'" "$(st "$SD")" "up"
ck "no alert noise" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "0"
ck "qfail reset" "$(cat "$SD/op-health.qfail")" "0"

echo
echo "TEST 6: corrupt qfail counter must not wedge the run (set -u arithmetic abort)"
SD="$WORK/s6"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; printf 'garbage\n' > "$SD/op-health.qfail"; mode 200
run "$SD"
ck "survived corrupt counter" "$(st "$SD")" "up"
ck "counter reset to a number" "$(cat "$SD/op-health.qfail")" "0"

echo
echo "TEST 7: a concurrent run is skipped rather than racing the state files"
SD="$WORK/s7"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; mkdir -p "$SD/op-health.lock"; mode 502
run "$SD"
ck "second instance backed off" "$(grep -c 'another op-healthcheck run is in progress' "$WORK/out.log")" "1"
ck "state untouched by the skipped run" "$(st "$SD")" "up"
rmdir "$SD/op-health.lock" 2>/dev/null

echo
echo "TEST 8 (REGRESSION): first run on a healthy service must NOT send a phantom"
echo "        RECOVERED just because there is no state file yet"
SD="$WORK/s8"; mkdir -p "$SD"; rm -f "$SD/op-health.state"; mode 200
run "$SD"
ck "no phantom RECOVERED attempted" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "0"
ck "belief seeded to 'up' silently" "$(st "$SD")" "up"

echo
echo "TEST 9 (REGRESSION): first run on a DOWN service must still page"
SD="$WORK/s9"; mkdir -p "$SD"; rm -f "$SD/op-health.state"; mode 502
run "$SD"
ck "DOWN page attempted on first observation" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"
ck "belief not advanced (send failed)" "$(st "$SD")" ""

echo
echo "TEST 10 (REGRESSION): a liveness outage must not erase a DELIVERED pricing"
echo "         belief, and a still-failing quote must not report RECOVERED"
SD="$WORK/s10"; mkdir -p "$SD"; echo down > "$SD/op-health.state"
: > "$SD/op-health.qalerted"        # pricing degradation was already delivered
echo 0 > "$SD/op-health.qfail"      # debounce reset by the outage path
mode 502                            # liveness still down
run "$SD"
ck "pricing belief survives the outage" "$([ -f "$SD/op-health.qalerted" ] && echo kept || echo erased)" "kept"
mode 500                            # liveness ok? no - fixture returns 500 for both; use 200 next
mode 200
# quote endpoint shares the fixture, so a 200 here means pricing genuinely recovered
run "$SD"
ck "delivered degradation cleared only after a real 200 (send failed -> kept)" \
   "$([ -f "$SD/op-health.qalerted" ] && echo kept || echo erased)" "kept"

echo
echo "TEST 11 (REGRESSION): corrupt counter '08' must not abort the arithmetic"
SD="$WORK/s11"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; printf '08\n' > "$SD/op-health.qfail"; mode 502
run "$SD" OPHIS_BOOT_GRACE_SECONDS=0
ck "survived octal-looking counter" "$(grep -c 'value too great for base\|invalid arithmetic' "$WORK/out.log")" "0"

echo
echo "TEST 12 (REGRESSION): an uncreatable lock dir must FAIL LOUD, not skip silently"
SD="$WORK/s12"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; mode 200
sed -e "s|^STATE_DIR=.*|STATE_DIR=\"/proc/nonexistent-readonly/ophis\"|" -e "s|^BASE=.*|BASE=\"$BASE_URL\"|" "$SRC" > "$WORK/hc_ro.sh"
( export TELEGRAM_BOT_TOKEN_ENV_FILE="$WORK/bad-tg.env" OPHIS_BOOT_GRACE_SECONDS=0; bash "$WORK/hc_ro.sh" ) >"$WORK/ro.log" 2>&1
rc=$?
ck "exits non-zero rather than pretending success" "$([ "$rc" -ne 0 ] && echo nonzero || echo zero)" "nonzero"

echo
echo "RESULT: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
