#!/usr/bin/env bash
# Verifies that the TIERS + POOL_SPLIT_BPS constants are semantically identical
# across ALL THREE mirrors:
#   - apps/rebate-indexer/src/tiers.ts                        (the payout engine)
#   - packages/sdk/src/tiers.ts                               (@ophis/sdk)
#   - apps/frontend/apps/cowswap-frontend/src/ophis/tiers.ts  (swap-page display)
# Hard CI gate. Drift would silently misallocate WETH (indexer) or misdisplay
# tiers (frontend). The comparison is NUMERIC-normalized, so pure formatting
# differences (0.5 vs 0.50, 5_000 vs 5000, quote style, comments, whitespace)
# never cause a false mismatch -- only a real semantic divergence fails.
#
# Hardened 2026-06-09 (audit): every numeric value must be a BARE literal —
# the captured number must be terminated by `,` / `}` (object fields) or
# `;` / end-of-line (POOL_SPLIT_BPS). Previously `min_usd: 20_000 * 2` or
# `POOL_SPLIT_BPS = 2_125 + 1_000` canonicalized to the first literal and
# false-PASSED the gate. A built-in self-test now proves on every run that
# such expression drift is rejected, so a regression in the extractor itself
# cannot silently disarm the gate.

set -euo pipefail

A=apps/rebate-indexer/src/tiers.ts
B=packages/sdk/src/tiers.ts
C=apps/frontend/apps/cowswap-frontend/src/ophis/tiers.ts

# Interpreter override for dev machines whose PATH python3 is a policy shim
# (e.g. CHECK_TIER_PYTHON=/usr/bin/python3). CI uses the default.
PYTHON_BIN=${CHECK_TIER_PYTHON:-python3}

for f in "$A" "$B" "$C"; do
  [[ -f "$f" ]] || { echo "ERROR: $f missing" >&2; exit 1; }
done

extract() {
  ${PYTHON_BIN} - "$1" <<'PY'
import re, sys, json
with open(sys.argv[1]) as f:
    src = f.read()
# Drop comments so prose never affects the comparison.
src = re.sub(r'/\*[\s\S]*?\*/', '', src)
src = re.sub(r'//[^\n]*', '', src)

m = re.search(r'TIERS\s*:[^=]*=\s*(\[[\s\S]*?\])\s*as\s*const', src)
if not m:
    print('NO_TIERS_FOUND', file=sys.stderr); sys.exit(3)

# Values must be BARE numeric literals: the capture is anchored to the field's
# terminator (`,` or `}`), so `min_usd: 20_000 * 2` does NOT match and the
# extraction fails loudly instead of silently taking the first literal.
tiers = []
for blk in re.finditer(r'\{[^{}]*\}', m.group(1)):
    b = blk.group(0)
    name = re.search(r'name\s*:\s*[\'"]([^\'"]+)[\'"]', b)
    minu = re.search(r'min_usd\s*:\s*([0-9_]+)\s*[,}]', b)
    pct  = re.search(r'rebate_pct\s*:\s*([0-9._]+)\s*[,}]', b)
    if not (name and minu and pct):
        print('TIER_PARSE_ERROR (field missing or not a bare numeric literal)', file=sys.stderr); sys.exit(3)
    # Numeric-normalize: int min_usd, float rebate_pct -> 0.5 == 0.50.
    tiers.append([name.group(1), int(minu.group(1).replace('_', '')), float(pct.group(1))])

# Bare literal terminated by `;` or end-of-line ([ \t]* only — \s* would let a
# newline smuggle a continuation like `2_125 +\n 1_000` past the anchor).
pm = re.search(r'POOL_SPLIT_BPS\s*=\s*([0-9_]+)[ \t]*(?:;|\r?\n|$)', src)
if not tiers or not pm:
    print('EXTRACT_FAILED (POOL_SPLIT_BPS missing or not a bare numeric literal)', file=sys.stderr); sys.exit(3)
pool = int(pm.group(1).replace('_', ''))

print(json.dumps({'tiers': tiers, 'pool': pool}, separators=(',', ':')))
PY
}

# --- Self-test: the extractor must REJECT expression-valued drift. -----------
# Builds mutated copies of the indexer mirror where a constant is an arithmetic
# expression whose FIRST literal is unchanged (the exact shape the pre-2026-06-09
# extractor false-passed) and asserts extraction fails.
self_test() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' RETURN

  # [[:space:]] not \s, and no 0,/re/ addressing: must run under BSD sed
  # (macOS dev machines) as well as GNU sed (CI).
  sed -E 's/(POOL_SPLIT_BPS[[:space:]]*=[[:space:]]*[0-9_]+)/\1 + 1_000/' "$A" > "$tmpdir/pool_drift.ts"
  if extract "$tmpdir/pool_drift.ts" >/dev/null 2>&1; then
    echo "FATAL: self-test failed — extractor accepted 'POOL_SPLIT_BPS = <n> + 1_000' (expression drift would false-PASS)" >&2
    exit 4
  fi

  sed -E 's/(min_usd[[:space:]]*:[[:space:]]*[0-9_]+)/\1 * 2/' "$A" > "$tmpdir/minusd_drift.ts"
  if extract "$tmpdir/minusd_drift.ts" >/dev/null 2>&1; then
    echo "FATAL: self-test failed — extractor accepted 'min_usd: <n> * 2' (expression drift would false-PASS)" >&2
    exit 4
  fi
}

self_test

A_C=$(extract "$A")
B_C=$(extract "$B")
C_C=$(extract "$C")

if [[ "$A_C" == "$B_C" && "$B_C" == "$C_C" ]]; then
  echo "OK: TIERS + POOL_SPLIT_BPS semantic mirror across indexer, sdk, and frontend (extractor self-test passed)"
  echo "  $A_C"
  exit 0
fi

echo "FATAL: tiers.ts drift across the three mirrors" >&2
echo "  indexer  $A: $A_C" >&2
echo "  sdk      $B: $B_C" >&2
echo "  frontend $C: $C_C" >&2
echo "  Mismatch silently misallocates rebates or misdisplays tiers. Reconcile all three in the same PR." >&2
exit 2
