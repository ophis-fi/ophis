#!/usr/bin/env bash
# Behavioural tests for the two review findings. No real Telegram traffic:
# every case points TG_ENV at a token that Telegram will reject, so notify()
# genuinely fails end-to-end (that IS the condition under test).
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/op-healthcheck.sh"
WORK="$(mktemp -d)"
printf 'TELEGRAM_BOT_TOKEN=000000:INVALID-TOKEN-FOR-TESTING\n' > "$WORK/bad-tg.env"
pass=0; fail=0
ck(){ if [[ "$2" == "$3" ]]; then echo "  PASS  $1 ($2)"; pass=$((pass+1)); else echo "  FAIL  $1: expected '$3' got '$2'"; fail=$((fail+1)); fi; }

run(){ # statedir, base_url, extra env
  local sd="$1" base="$2"; shift 2
  sed -e "s|^STATE_DIR=.*|STATE_DIR=\"$sd\"|" -e "s|^BASE=.*|BASE=\"$base\"|" "$SRC" > "$WORK/hc.sh"
  ( export TELEGRAM_BOT_TOKEN_ENV_FILE="$WORK/bad-tg.env" "$@"; bash "$WORK/hc.sh" ) >"$WORK/out.log" 2>&1
}

echo "TEST 1: DOWN page fails to deliver -> state must NOT advance (so next run retries)"
SD="$WORK/s1"; mkdir -p "$SD"; echo up > "$SD/op-health.state"
run "$SD" "https://invalid.ophis.test/api/v1" OPHIS_BOOT_GRACE_SECONDS=0
ck "state stays 'up' so the page is retried" "$(cat "$SD/op-health.state")" "up"
ck "undelivered alert is logged loudly" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"

echo
echo "TEST 2: same, second run also retries (not silently suppressed forever)"
run "$SD" "https://invalid.ophis.test/api/v1" OPHIS_BOOT_GRACE_SECONDS=0
ck "still 'up', still retrying" "$(cat "$SD/op-health.state")" "up"
ck "retried the send" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "1"

echo
echo "TEST 3: boot grace suppresses the cold-boot page entirely"
SD="$WORK/s3"; mkdir -p "$SD"; echo up > "$SD/op-health.state"
run "$SD" "https://invalid.ophis.test/api/v1" OPHIS_BOOT_GRACE_SECONDS=99999999
ck "grace message emitted" "$(grep -c 'boot grace' "$WORK/out.log")" "1"
ck "no alert attempted during grace" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "0"
ck "state untouched during grace" "$(cat "$SD/op-health.state")" "up"

echo
echo "TEST 4: healthy stack -> state 'up', no alert, marker cleared"
SD="$WORK/s4"; mkdir -p "$SD"; echo down > "$SD/op-health.state"
run "$SD" "https://optimism-mainnet.ophis.fi/api/v1" OPHIS_BOOT_GRACE_SECONDS=0
# prev=down + recovery send fails => state must STAY down so the recovery ping retries
ck "failed RECOVERED ping keeps state 'down' for retry" "$(cat "$SD/op-health.state")" "down"

echo
echo "TEST 5: healthy stack, prev=up -> normal quiet success"
SD="$WORK/s5"; mkdir -p "$SD"; echo up > "$SD/op-health.state"
run "$SD" "https://optimism-mainnet.ophis.fi/api/v1" OPHIS_BOOT_GRACE_SECONDS=0
ck "state 'up'" "$(cat "$SD/op-health.state")" "up"
ck "no undelivered-alert noise" "$(grep -c 'ALERT UNDELIVERED' "$WORK/out.log")" "0"
ck "qfail reset" "$(cat "$SD/op-health.qfail")" "0"

echo
echo "RESULT: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
