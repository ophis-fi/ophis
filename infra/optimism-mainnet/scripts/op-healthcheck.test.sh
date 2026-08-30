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
# The two tiers must be controllable INDEPENDENTLY. With a single shared status
# code, any test that wanted "liveness up, pricing failing" could not express it —
# and worse, a test that set 502 exited at the liveness branch before the pricing
# code ran at all, so it passed whether or not the pricing logic was correct. Two
# separate mode files, dispatched on path.
cat > "$WORK/fixture.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE_V, MODE_Q = sys.argv[2], sys.argv[3]
class H(BaseHTTPRequestHandler):
    def _code(self):
        path = MODE_Q if 'quote' in self.path else MODE_V
        try:
            return int(open(path).read().strip())
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
printf '200' > "$WORK/mode"; printf '200' > "$WORK/qmode"
$PYBIN "$WORK/fixture.py" "$PORT" "$WORK/mode" "$WORK/qmode" & FIXPID=$!
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

mode(){ printf '%s' "$1" > "$WORK/mode"; printf '%s' "${2:-$1}" > "$WORK/qmode"; }  # mode <liveness> [quote]
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
mode 502 502                        # liveness still down
run "$SD"
ck "pricing belief survives the outage" "$([ -f "$SD/op-health.qalerted" ] && echo kept || echo erased)" "kept"

# THE case the previous version never reached: liveness back UP but the quote STILL
# failing, with the debounce reset to 0. Before the fix, qfail(1) < threshold(3) made
# this look "ok" and emitted a false pricing RECOVERED. Needs split liveness/quote
# codes to express at all — with one shared code it is inexpressible.
echo 0 > "$SD/op-health.qfail"
echo up > "$SD/op-health.state"     # liveness belief already up: no tier-1 message owed
mode 200 503                        # liveness OK, pricing STILL BROKEN
run "$SD"
# The observable is whether a message was ATTEMPTED, not its text: the alert body
# only ever goes to Telegram, so grepping the log for "pricing RECOVERED" matches
# nothing either way and asserts precisely zero. With the fix, belief(degraded) ==
# observation(degraded) so NOTHING is owed and no send happens. Without it, the
# still-failing quote reads as "ok", a false RECOVERED is attempted, and the failed
# send shows up here. Verified by mutation: disabling the branch makes this fail.
ck "no message attempted — still-degraded matches belief" \
   "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "0"
ck "delivered degradation stays until a real 200" \
   "$([ -f "$SD/op-health.qalerted" ] && echo kept || echo erased)" "kept"

echo
echo "TEST 11 (REGRESSION): corrupt counter '08' must not abort the arithmetic"
# Liveness must be UP or the script exits before the pricing arithmetic ever runs —
# the previous version used 502 and so passed even with the 10# fix reverted.
SD="$WORK/s11"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; printf '08\n' > "$SD/op-health.qfail"
mode 200 503                        # liveness UP, quote FAILING -> arithmetic runs
run "$SD" OPHIS_BOOT_GRACE_SECONDS=0
ck "no octal arithmetic error" "$(grep -ci 'value too great for base\|invalid arithmetic\|syntax error' "$WORK/out.log")" "0"
ck "counter actually incremented past 08 (proves the path ran)" "$(cat "$SD/op-health.qfail")" "9"

echo
echo "TEST 12 (REGRESSION): an uncreatable lock dir must FAIL LOUD, not skip silently"
SD="$WORK/s12"; mkdir -p "$SD"; echo up > "$SD/op-health.state"; mode 200
sed -e "s|^STATE_DIR=.*|STATE_DIR=\"/proc/nonexistent-readonly/ophis\"|" -e "s|^BASE=.*|BASE=\"$BASE_URL\"|" "$SRC" > "$WORK/hc_ro.sh"
( export TELEGRAM_BOT_TOKEN_ENV_FILE="$WORK/bad-tg.env" OPHIS_BOOT_GRACE_SECONDS=0; bash "$WORK/hc_ro.sh" ) >"$WORK/ro.log" 2>&1
rc=$?
ck "exits non-zero rather than pretending success" "$([ "$rc" -ne 0 ] && echo nonzero || echo zero)" "nonzero"

echo
echo "TEST 13 (REGRESSION): a CORRUPT state file must not be treated like an absent"
echo "         one — silently seeding 'up' would discard a pending RECOVERED"
SD="$WORK/s13"; mkdir -p "$SD"; printf 'garbage\n' > "$SD/op-health.state"; mode 200 200
run "$SD"
ck "corruption reported, not silently seeded" "$(grep -c 'present but malformed' "$WORK/out.log")" "1"
ck "healthy + corrupt -> RECOVERED still attempted" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"

echo
echo "TEST 13b (REGRESSION): corrupt state while the service is genuinely DOWN must"
echo "          still page. Guessing prev=down here made observed==prev, so no alert"
echo "          fired and the malformed file was never repaired — the outage would"
echo "          have gone unreported on every tick, forever."
SD="$WORK/s13b"; mkdir -p "$SD"; printf 'garbage\n' > "$SD/op-health.state"; mode 502 502
run "$SD" OPHIS_BOOT_GRACE_SECONDS=0
ck "down + corrupt -> DOWN page attempted" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"
ck "belief not advanced while undelivered" "$(st "$SD")" "garbage"

echo
echo "TEST 14 (REGRESSION): the renderer must be EXERCISED, not grepped. Earlier"
echo "         versions of this block only checked that error strings existed in"
echo "         the source, which stays green if the guards become unreachable."
R="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$R/render-configs.sh" ]]; then
  SB="$WORK/render-sandbox"; mkdir -p "$SB"; cp "$R/render-configs.sh" "$SB/"
  # render-configs.sh cd's to its own directory, so the sandbox copy reads the
  # sandbox .env. The zan guard sits after `source .env` and BEFORE the sudo PK
  # read, so these invocations are real and need no privileges.
  runrender(){ ( cd "$SB" && bash ./render-configs.sh >"$SB/out.log" 2>&1 ); echo $?; }

  printf 'POSTGRES_USER=x\nBLOCKDAEMON_OP_KEY=bd\nDRPC_API_KEY=dr\nTENDERLY_OP_KEY=td\n' > "$SB/.env"   # neither zan name
  rc="$(runrender)"
  ck "no zan key at all -> exits 15" "$rc" "15"
  ck "and says why" "$(grep -c 'Refusing to render' "$SB/out.log")" "1"

  printf 'POSTGRES_USER=x\nBLOCKDAEMON_OP_KEY=bd\nDRPC_API_KEY=dr\nTENDERLY_OP_KEY=td\nZAN_OP_KEY=legacy-value\n' > "$SB/.env"  # legacy name only
  rc="$(runrender)"
  ck "legacy name migrates instead of exiting 15" "$([ "$rc" != "15" ] && echo migrated || echo refused)" "migrated"
  ck "and warns to rename it" "$(grep -c 'Migrating to ZAN_API_KEY' "$SB/out.log")" "1"

  # The endpoint validator, invoked directly through its --check-rendered seam.
  printf 'upstreams:\n  - id: zan-op\n    endpoint: https://api.zan.top/node/v1/opt/mainnet/abc123\n' > "$SB/good.yaml"
  ( cd "$SB" && bash ./render-configs.sh --check-rendered "$SB/good.yaml" >/dev/null 2>&1 ); ck "valid rendered config passes" "$?" "0"

  printf 'upstreams:\n  - id: zan-op\n    endpoint: https://api.zan.top/node/v1/opt/mainnet/\n' > "$SB/empty.yaml"
  ( cd "$SB" && bash ./render-configs.sh --check-rendered "$SB/empty.yaml" >/dev/null 2>&1 ); ck "empty key (trailing /) is rejected with 16" "$?" "16"

  printf 'upstreams:\n  - id: vc-op\n    endpoint: https://mainnet.optimism.validationcloud.io/v1//more\n' > "$SB/dbl.yaml"
  ( cd "$SB" && bash ./render-configs.sh --check-rendered "$SB/dbl.yaml" >/dev/null 2>&1 ); ck "empty key mid-path (//) is rejected with 16" "$?" "16"

  # blockdaemon took the single CF slot on 2026-08-29 and is the ONLY full-archive
  # lane, so an empty key there costs eth_getTransactionReceipt + deep eth_getLogs
  # their 3rd voter. Its key rides in a QUERY PARAM, which the trailing-'/' and
  # '//' checks above cannot see — hence its own guard, and hence these tests.
  printf 'POSTGRES_USER=x\nZAN_API_KEY=z\nTENDERLY_OP_KEY=td\n' > "$SB/.env"   # no drpc key
  rc="$(runrender)"
  ck "no drpc key -> exits 15" "$rc" "15"
  ck "and names DRPC_API_KEY" "$(grep -c 'DRPC_API_KEY is unset/empty' "$SB/out.log")" "1"

  printf 'upstreams:\n  - id: drpc-op\n    endpoint: https://lb.drpc.org/ogrpc?network=optimism\&dkey=abc123\n' > "$SB/bdgood.yaml"
  ( cd "$SB" && bash ./render-configs.sh --check-rendered "$SB/bdgood.yaml" >/dev/null 2>&1 ); ck "query-param key present passes" "$?" "0"

  printf 'upstreams:\n  - id: drpc-op\n    endpoint: https://lb.drpc.org/ogrpc?network=optimism\&dkey=\n' > "$SB/bdempty.yaml"
  ( cd "$SB" && bash ./render-configs.sh --check-rendered "$SB/bdempty.yaml" >/dev/null 2>&1 ); ck "EMPTY query-param key is rejected with 16" "$?" "16"

  printf 'upstreams:\n  - id: blockdaemon-op\n    endpoint: https://svc.blockdaemon.com/optimism/mainnet/native?apiKey=&z=1\n' > "$SB/bdempty2.yaml"
  ( cd "$SB" && bash ./render-configs.sh --check-rendered "$SB/bdempty2.yaml" >/dev/null 2>&1 ); ck "EMPTY query-param key before & is rejected with 16" "$?" "16"

  # tenderly-op replaced official-op on 2026-08-29. Its key is PATH-style, so an
  # empty one degrades to the KEYLESS gateway (20 req/s instead of 400, archive
  # guarantee gone) rather than erroring -- fail fast on it too.
  printf 'POSTGRES_USER=x\nZAN_API_KEY=z\nBLOCKDAEMON_OP_KEY=bd\nDRPC_API_KEY=dr\n' > "$SB/.env"   # no tenderly key
  rc="$(runrender)"
  ck "no tenderly key -> exits 15" "$rc" "15"
  ck "and names TENDERLY_OP_KEY" "$(grep -c 'TENDERLY_OP_KEY is unset/empty' "$SB/out.log")" "1"

  printf 'upstreams:\n  - id: tenderly-op\n    endpoint: https://optimism.gateway.tenderly.co/\n' > "$SB/tdempty.yaml"
  ( cd "$SB" && bash ./render-configs.sh --check-rendered "$SB/tdempty.yaml" >/dev/null 2>&1 ); ck "keyless tenderly fallback is rejected with 16" "$?" "16"
else
  echo "  SKIP  render-configs.sh not found next to this suite"
fi

echo
echo "RESULT: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
