#!/usr/bin/env bash
# Tests for settlement-buffer-watch.sh.
#
# DETERMINISTIC: never touches a real RPC and never contacts Telegram
# (BUFFER_NOTIFY=0 for every case — without it, running this on the Mac mini,
# which holds the bot token, would page a real person about fake buffers).
#
# The per-chain probes are fakes: the watch script resolves them from
# $OPHIS_REPO, so each case builds a repo-shaped tree whose
# check-settlement-buffer.sh scripts print fixture JSON. That is the same
# fake-on-the-path trick container-watchdog.test.sh uses for `docker`.
#
# Every negative case asserts BOTH "no alert fired" AND "the pass completed".
# A crash and a clean pass look identical if you only check for absent output,
# and that is exactly the trap this suite exists to avoid: the bug this monitor
# was written for was three months of silence that everyone read as health.
#
# The clock is injected (BUFFER_NOW_S) because repeat-suppression is a 24h
# window, and a suite that had to sleep a day to cover it would never be run.
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/settlement-buffer-watch.sh"
pass=0; fail=0

ck(){ if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; pass=$((pass+1));
      else echo "  FAIL  $1: expected '$3' got '$2'"; fail=$((fail+1)); fi; }
ckc(){ if grep -qF -- "$3" <<<"$2"; then echo "  PASS  $1"; pass=$((pass+1));
      else echo "  FAIL  $1: output did not contain '$3'"; fail=$((fail+1)); fi; }
ckn(){ if grep -qF -- "$3" <<<"$2"; then echo "  FAIL  $1: output unexpectedly contained '$3'"; fail=$((fail+1));
      else echo "  PASS  $1"; pass=$((pass+1)); fi; }

[ -f "$SRC" ] || { echo "FATAL: cannot find $SRC"; exit 1; }

# --- fixture builders --------------------------------------------------------
# Build a fake repo tree whose three probe scripts print the JSON we hand them.
# rc lets a case simulate a probe that dies rather than reporting.
make_repo() {
  local root="$1"; shift
  local chain dir json rc
  for spec in "$@"; do
    IFS='|' read -r chain json rc <<< "$spec"
    dir="$root/infra/$chain/scripts"
    mkdir -p "$dir"
    { echo '#!/usr/bin/env bash'
      printf 'cat <<%s\n%s\n%s\n' 'JSONEOF' "$json" 'JSONEOF'
      echo "exit ${rc:-0}"
    } > "$dir/check-settlement-buffer.sh"
    chmod +x "$dir/check-settlement-buffer.sh"
  done
}

# A probe report. bal_specs are "symbol:raw:status" triples.
#
# Pads to the chain's FULL expected symbol set with zero rows, because the watcher
# now rejects an incomplete report - a partial one is not a measurement. Tests that
# want a deliberately incomplete report build the JSON by hand instead.
expected_for() {
  case "$1" in
    0xOP)  echo "USDC WETH USDCe DAI WBTC USDT ETH" ;;
    0xUNI) echo "WETH USDC" ;;
    0xRBH) echo "WETH USDG" ;;
    *)     echo "" ;;
  esac
}
report() {
  local settlement="$1"; shift
  local failures="$1"; shift
  local rows="" sym raw status given=""
  for spec in "$@"; do
    IFS=: read -r sym raw status <<< "$spec"
    given="$given $sym"
    [[ -n "$rows" ]] && rows="$rows,"
    rows="$rows{\"symbol\":\"$sym\",\"token\":\"0xtok\",\"raw\":\"$raw\",\"hr\":\"0\",\"status\":\"${status:-ok}\"}"
  done
  for want in $(expected_for "$settlement"); do
    grep -qw -- "$want" <<<"$given" && continue
    [[ -n "$rows" ]] && rows="$rows,"
    rows="$rows{\"symbol\":\"$want\",\"token\":\"0xtok\",\"raw\":\"0\",\"hr\":\"0\",\"status\":\"ok\"}"
  done
  echo "{\"ts\":\"2026-08-27T00:00:00Z\",\"settlement\":\"$settlement\",\"safe\":\"0xsafe\",\"liquidator\":{\"address\":null,\"status\":\"unset\"},\"probe_failures\":$failures,\"balances\":[$rows]}"
}

run_watch() {
  local root="$1"; shift
  OPHIS_REPO="$root" BUFFER_NOTIFY=0 BUFFER_STATE_FILE="$root/state" \
    BUFFER_NOW_S="${NOW:-1000000}" bash "$SRC" 2>&1
}

# Thresholds mirror the sweep script: USDC/USDG 1e7 base units (~$10),
# WETH 3e15 wei (~$7). Below them a sweep would skip the token anyway.
BELOW_USDC=354188          # the live OP buffer: $0.35, NOT worth a signature
ABOVE_USDC=50000000        # $50
BELOW_WETH=44067868987906  # the live OP buffer: ~$0.11
ABOVE_WETH=9000000000000000

echo "settlement-buffer-watch.sh"

# --- 1. quiet when nothing is sweepable --------------------------------------
W1="$(mktemp -d)"
make_repo "$W1" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:$BELOW_USDC:ok" "WETH:$BELOW_WETH:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:140666:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1106040:ok")|0"
out1="$(run_watch "$W1")"
ckn "stays quiet when every buffer is below its sweep threshold" "$out1" "ALERT:"
ckc "still reports a completed pass, so silence is provably not a crash" "$out1" "pass complete"
rm -rf "$W1"

# --- 2. alerts when a buffer becomes sweepable -------------------------------
W2="$(mktemp -d)"
make_repo "$W2" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:$ABOVE_USDC:ok" "WETH:$BELOW_WETH:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:140666:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1106040:ok")|0"
out2="$(run_watch "$W2")"
ckc "alerts once a buffer crosses its sweep threshold" "$out2" "ALERT:"
ckc "names the chain so the operator knows which runbook to open" "$out2" "optimism"
ckc "names the token" "$out2" "USDC"
# Assert on the ALERT line itself, not the whole run: every chain legitimately
# appears in the per-chain "measured" log, and grepping all stdout would pass
# for the wrong reason.
alert2="$(grep -F 'ALERT:' <<<"$out2")"
ckn "the alert body leaves out the chains that are still below threshold" "$alert2" "robinhood"
ckn "and leaves out the below-threshold token on the chain it does report" "$alert2" "WETH"
rm -rf "$W2"

# --- 3. a failing probe is louder than a zero balance ------------------------
# The original sin here was a monitor reporting health it had not measured.
W3="$(mktemp -d)"
make_repo "$W3" \
  "optimism-mainnet|$(report 0xOP 2 "USDC:0:error" "WETH:0:error")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out3="$(run_watch "$W3")"
ckc "alerts on probe failure rather than reading it as an empty buffer" "$out3" "ALERT:"
ckc "says the reading is unreliable, not that the buffer is clean" "$out3" "probe"
rm -rf "$W3"

# --- 4. a probe that dies must not pass for a clean chain --------------------
W4="$(mktemp -d)"
make_repo "$W4" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:1:ok")|3" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out4="$(run_watch "$W4")"
ckc "alerts when a probe exits non-zero" "$out4" "ALERT:"
ckc "reaches the end of the pass instead of aborting the other chains" "$out4" "pass complete"
ckc "still measured the chains whose probes worked" "$out4" "unichain"
rm -rf "$W4"

# --- 5. unparseable probe output is a failure, not a silent zero ------------
W5="$(mktemp -d)"
make_repo "$W5" \
  "optimism-mainnet|not json at all|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out5="$(run_watch "$W5")"
ckc "alerts when a probe emits something that is not a report" "$out5" "ALERT:"
rm -rf "$W5"

# --- 6. repeat suppression ---------------------------------------------------
# A sweepable buffer stays sweepable until someone signs. Re-paging every 5
# minutes for a month is how an alert gets muted, and a muted alert is the
# silence this monitor exists to end.
W6="$(mktemp -d)"
make_repo "$W6" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:$ABOVE_USDC:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
first="$(NOW=1000000 run_watch "$W6")"
second="$(NOW=1000600 run_watch "$W6")"
ckc "alerts the first time" "$first" "ALERT:"
ckn "does not re-alert ten minutes later for the same unchanged condition" "$second" "ALERT:"
ckc "the suppressed run still completes and says why it is quiet" "$second" "suppressed"
rm -rf "$W6"

# --- 7. re-alerts after the repeat window ------------------------------------
W7="$(mktemp -d)"
make_repo "$W7" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:$ABOVE_USDC:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
NOW=1000000 run_watch "$W7" >/dev/null
day_later="$(NOW=1090000 run_watch "$W7")"
ckc "re-alerts once a day so an ignored buffer does not fade out entirely" "$day_later" "ALERT:"
rm -rf "$W7"

# --- 8. a NEW chain crossing re-alerts immediately ---------------------------
W8="$(mktemp -d)"
make_repo "$W8" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:$ABOVE_USDC:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
NOW=1000000 run_watch "$W8" >/dev/null
make_repo "$W8" "robinhood-mainnet|$(report 0xRBH 0 "USDG:$ABOVE_USDC:ok")|0"
changed="$(NOW=1000600 run_watch "$W8")"
ckc "a newly-sweepable chain alerts immediately, inside the repeat window" "$changed" "ALERT:"
ckc "and names the chain that just changed" "$changed" "robinhood"
rm -rf "$W8"

# --- 9. WETH threshold is denominated in wei, not shared with the 6-dec tokens
W9="$(mktemp -d)"
make_repo "$W9" \
  "optimism-mainnet|$(report 0xOP 0 "WETH:$ABOVE_WETH:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out9="$(run_watch "$W9")"
ckc "0.009 WETH is sweepable even though it is a tiny number of base units next to USDC" "$out9" "ALERT:"
ckc "names WETH" "$out9" "WETH"
rm -rf "$W9"

# --- 10. an unknown token must not be silently ignored -----------------------
# A token with no configured threshold is exactly how value goes unnoticed.
W10="$(mktemp -d)"
make_repo "$W10" \
  "optimism-mainnet|$(report 0xOP 0 "MYSTERY:999999999999999999999:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out10="$(run_watch "$W10")"
ckc "a token with no configured threshold still surfaces" "$out10" "ALERT:"
ckc "and is named" "$out10" "MYSTERY"
rm -rf "$W10"

# --- 11. thresholds are PER CHAIN, mirroring each sweep script ---------------
# unichain sweep-to-safe.sh defaults WETH to 1e15; optimism's defaults it to
# 3e15. A single shared table meant a Unichain balance between the two was
# sweepable by the stock script while the monitor reported clean - the exact
# alarm/action drift this job claims cannot happen.
W11="$(mktemp -d)"
make_repo "$W11" \
  "optimism-mainnet|$(report 0xOP 0 "WETH:2000000000000000:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out11="$(run_watch "$W11")"
ckn "0.002 WETH on optimism is below ITS 3e15 sweep floor, so no alert" "$out11" "ALERT:"
rm -rf "$W11"

W12="$(mktemp -d)"
make_repo "$W12" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:1:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "WETH:2000000000000000:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out12="$(run_watch "$W12")"
ckc "the SAME 0.002 WETH on unichain IS above its 1e15 sweep floor, so it alerts" "$out12" "ALERT:"
ckc "and names unichain" "$out12" "unichain"
rm -rf "$W12"

# --- 12. a token the chain's sweep does not cover must surface ---------------
# Optimism holds USDT but the OP sweep's default token list is USDC/WETH/native.
# Treating it as "no threshold, ignore" is how a balance grows unnoticed forever.
W13="$(mktemp -d)"
make_repo "$W13" \
  "optimism-mainnet|$(report 0xOP 0 "USDT:50000000:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out13="$(run_watch "$W13")"
ckc "a token outside the chain's sweep configuration alerts" "$out13" "ALERT:"
ckc "and is named" "$out13" "USDT"
ckc "and says the sweep does not cover it" "$out13" "not covered"
rm -rf "$W13"

# --- 13. a structurally valid but EMPTY report is not a measurement ----------
W14="$(mktemp -d)"
make_repo "$W14" \
  "optimism-mainnet|{}|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out14="$(run_watch "$W14")"
ckc "a probe emitting {} is rejected, not read as a clean buffer" "$out14" "ALERT:"
rm -rf "$W14"

W15="$(mktemp -d)"
# Raw JSON, not report(): report() pads to the chain's full expected symbol set,
# which is the opposite of what this case needs.
empty_rows='{"ts":"t","settlement":"0xOP","safe":"0xsafe","probe_failures":0,"balances":[]}'
make_repo "$W15" \
  "optimism-mainnet|$empty_rows|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out15="$(run_watch "$W15")"
ckc "a report with zero balance rows measured nothing and is rejected" "$out15" "ALERT:"
rm -rf "$W15"

# --- 13b. a COMPLETE report that still omits probe_failures -----------------
# Deliberately carries every expected optimism symbol, so neither the zero-row nor
# the missing-symbol guard fires. Only schema validation catches it. Without that,
# `.probe_failures // 0` would default a missing field to "no failures" and the
# chain would pass as fully measured.
W15b="$(mktemp -d)"
rows=""
for sym in USDC WETH USDCe DAI WBTC USDT ETH; do
  [[ -n "$rows" ]] && rows="$rows,"
  rows="$rows{\"symbol\":\"$sym\",\"token\":\"0xtok\",\"raw\":\"1\",\"hr\":\"0\",\"status\":\"ok\"}"
done
no_pf="{\"ts\":\"t\",\"settlement\":\"0xOP\",\"safe\":\"0xsafe\",\"balances\":[$rows]}"
make_repo "$W15b" \
  "optimism-mainnet|$no_pf|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out15b="$(run_watch "$W15b")"
ckc "a complete report missing probe_failures is still rejected" "$out15b" "ALERT:"
ckc "and says the schema is wrong, not that a symbol is missing" "$out15b" "missing probe_failures or balances"
rm -rf "$W15b"

# --- 14. a page that was never delivered must not mute the condition ---------
# NOTIFY=1 with a missing token file: alert() fails WITHOUT touching the network.
# Previously the state file was written regardless, so a send failure silenced a
# live sweepable buffer for 24h on the strength of a page nobody received.
W16="$(mktemp -d)"
make_repo "$W16" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:$ABOVE_USDC:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
run_watch_undeliverable() {
  OPHIS_REPO="$1" BUFFER_NOTIFY=1 BUFFER_STATE_FILE="$1/state" \
    TELEGRAM_BOT_TOKEN_FILE="$1/no-such-token-file" \
    BUFFER_NOW_S="${NOW:-1000000}" bash "$SRC" 2>&1
}
undeliv1="$(NOW=1000000 run_watch_undeliverable "$W16")"
ckc "reports the delivery failure rather than claiming it paged" "$undeliv1" "NOT delivered"
ckn "and does not record suppression state" "$undeliv1" "suppressed"
undeliv2="$(NOW=1000600 run_watch_undeliverable "$W16")"
ckc "so the very next run tries again instead of going quiet for 24h" "$undeliv2" "ALERT:"
rm -rf "$W16"

# --- 15. the log must carry a real timestamp --------------------------------
# A bulk edit once deleted fmt_ts while leaving every call to it. `set -e` is off,
# so the script kept running, wrote "fmt_ts: command not found" to stderr, and
# stamped every line "[]". Nothing failed. Assert the stamp itself.
W17="$(mktemp -d)"
make_repo "$W17" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:1:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out17="$(NOW=1756000000 run_watch "$W17")"
if grep -qE '^\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\] ' <<<"$out17"; then
  echo "  PASS  log lines carry a real ISO timestamp"; pass=$((pass+1))
else
  echo "  FAIL  log lines carry a real ISO timestamp: got '$(head -1 <<<"$out17")'"; fail=$((fail+1))
fi
ckn "and no shell error leaks into the output" "$out17" "command not found"
rm -rf "$W17"

# --- 16. survives launchd's environment (no HOME) ----------------------------
# launchd does not guarantee HOME. Under `set -u` a HOME-derived default aborts on
# the assignment line itself, before any probe, log or alert - a monitor that is
# installed, enabled and completely inert, with nothing in its own log to say so.
W18="$(mktemp -d)"
make_repo "$W18" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:1:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out18="$(env -u HOME OPHIS_REPO="$W18" BUFFER_NOTIFY=0 BUFFER_NOW_S=1000000 bash "$SRC" 2>&1)"
ckc "completes a pass with HOME unset" "$out18" "pass complete"
ckn "and does not die on an unbound variable" "$out18" "unbound variable"
rm -rf "$W18"

# --- 17. a PARTIAL report is not a measurement ------------------------------
# Non-empty is not the same as complete. An optimism probe returning only a
# successful USDC row would otherwise pass, while WETH, native ETH and USDT
# silently disappear - reported health that was never measured, one layer up
# from the zero-row case.
W19="$(mktemp -d)"
partial='{"ts":"t","settlement":"0xOP","safe":"0xsafe","probe_failures":0,"balances":[{"symbol":"USDC","token":"0xtok","raw":"1","hr":"0","status":"ok"}]}'
make_repo "$W19" \
  "optimism-mainnet|$partial|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out19="$(run_watch "$W19")"
ckc "a report missing expected symbols alerts" "$out19" "ALERT:"
ckc "and names what went missing" "$out19" "MISSING"
ckc "specifically the dropped WETH row" "$out19" "WETH"
rm -rf "$W19"

# --- 18. an error row with probe_failures 0 must not be skipped -------------
# The probe contract does not guarantee the two agree. Skipping a non-ok row
# because "probe_failures already counted it" lets a chain reach a clean pass with
# that balance never measured.
W20="$(mktemp -d)"
make_repo "$W20" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:0:error")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out20="$(run_watch "$W20")"
ckc "an error row alerts even when probe_failures says zero" "$out20" "ALERT:"
ckc "and says the balance is unknown rather than zero" "$out20" "UNKNOWN, not zero"
rm -rf "$W20"

# --- 19. a non-numeric balance is not a balance -----------------------------
W21="$(mktemp -d)"
make_repo "$W21" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:notanumber:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
out21="$(run_watch "$W21")"
ckc "a non-numeric raw balance alerts" "$out21" "ALERT:"
rm -rf "$W21"

# --- 20. losing a DIFFERENT symbol is a new incident ------------------------
# Both incidents previously shared one suppression key, so the second newly
# unmeasured balance was silenced for 24h behind the first page.
W22="$(mktemp -d)"
miss_weth='{"ts":"t","settlement":"0xOP","safe":"0xsafe","probe_failures":0,"balances":[{"symbol":"USDC","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"USDCe","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"DAI","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"WBTC","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"USDT","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"ETH","token":"0xt","raw":"1","hr":"0","status":"ok"}]}'
miss_usdc='{"ts":"t","settlement":"0xOP","safe":"0xsafe","probe_failures":0,"balances":[{"symbol":"WETH","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"USDCe","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"DAI","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"WBTC","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"USDT","token":"0xt","raw":"1","hr":"0","status":"ok"},{"symbol":"ETH","token":"0xt","raw":"1","hr":"0","status":"ok"}]}'
make_repo "$W22" \
  "optimism-mainnet|$miss_weth|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
NOW=1000000 run_watch "$W22" >/dev/null
make_repo "$W22" "optimism-mainnet|$miss_usdc|0"
out22="$(NOW=1000600 run_watch "$W22")"
ckc "losing a different symbol pages immediately, inside the repeat window" "$out22" "ALERT:"
rm -rf "$W22"

# --- 21. attacker-controlled symbols must not break the page ----------------
# alert() sends parse_mode=HTML. An ERC20 symbol is whatever its deployer chose, so
# an airdropped token with markup in its symbol would make Telegram REJECT the
# request - and the one condition the page exists to report is the one lost.
W23="$(mktemp -d)"
pwn='{"ts":"t","settlement":"0xRBH","safe":"0xsafe","probe_failures":0,"balances":[{"symbol":"<b>PWN</b>","token":"0xt","raw":"50000000","hr":"0","status":"ok"},{"symbol":"WETH","token":"0xt","raw":"0","hr":"0","status":"ok"},{"symbol":"USDG","token":"0xt","raw":"0","hr":"0","status":"ok"}]}'
make_repo "$W23" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:1:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$pwn|0"
out23="$(BUFFER_NOTIFY=1 TELEGRAM_BOT_TOKEN_FILE=/nonexistent OPHIS_REPO="$W23" BUFFER_STATE_FILE="$W23/state" BUFFER_NOW_S=1000000 bash "$SRC" 2>&1)"
ckc "still reports the unrecognised token" "$out23" "PWN"
rm -rf "$W23"

# --- 22. a row jq cannot serialize must not vanish --------------------------
# The reader loop consumes a @tsv stream, and @tsv ERRORS on a row whose raw is an
# object or array: the producer exits non-zero, the loop just sees fewer lines, and
# its status is not the shell's. The malformed row would disappear and the chain
# would still finish as measured.
W24="$(mktemp -d)"
weird='{"ts":"t","settlement":"0xRBH","safe":"0xsafe","probe_failures":0,"balances":[{"symbol":"WETH","token":"0xt","raw":{"oops":1},"hr":"0","status":"ok"},{"symbol":"USDG","token":"0xt","raw":"1","hr":"0","status":"ok"}]}'
make_repo "$W24" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:1:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$weird|0"
out24="$(run_watch "$W24")"
ckc "a row with a non-scalar balance alerts" "$out24" "ALERT:"
ckc "and is called out as malformed" "$out24" "malformed"
rm -rf "$W24"

# --- 23. a corrupt state file must not wedge every future run ---------------
# A non-decimal timestamp is evaluated as an ARITHMETIC EXPRESSION, so a stored
# `x` resolves an unset variable and aborts under `set -u`. The bad file stays
# put, so every hourly run after that crashes before alerting: a monitor silenced
# by its own state, with nothing in its log to say why.
W25="$(mktemp -d)"
make_repo "$W25" \
  "optimism-mainnet|$(report 0xOP 0 "USDC:$ABOVE_USDC:ok")|0" \
  "unichain-mainnet|$(report 0xUNI 0 "USDC:1:ok")|0" \
  "robinhood-mainnet|$(report 0xRBH 0 "USDG:1:ok")|0"
printf 'x\tstale-key' > "$W25/state"
out25="$(run_watch "$W25")"
ckc "completes a pass despite a corrupt state file" "$out25" "pass complete"
ckn "and does not die on an unbound variable" "$out25" "unbound variable"
ckc "and still delivers the alert it was suppressing" "$out25" "ALERT:"
rm -rf "$W25"

echo
echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
