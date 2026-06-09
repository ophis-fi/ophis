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

set -euo pipefail

A=apps/rebate-indexer/src/tiers.ts
B=packages/sdk/src/tiers.ts
C=apps/frontend/apps/cowswap-frontend/src/ophis/tiers.ts

for f in "$A" "$B" "$C"; do
  [[ -f "$f" ]] || { echo "ERROR: $f missing" >&2; exit 1; }
done

extract() {
  python3 - "$1" <<'PY'
import re, sys, json
with open(sys.argv[1]) as f:
    src = f.read()
# Drop comments so prose never affects the comparison.
src = re.sub(r'/\*[\s\S]*?\*/', '', src)
src = re.sub(r'//[^\n]*', '', src)

m = re.search(r'TIERS\s*:[^=]*=\s*(\[[\s\S]*?\])\s*as\s*const', src)
if not m:
    print('NO_TIERS_FOUND', file=sys.stderr); sys.exit(3)

tiers = []
for blk in re.finditer(r'\{[^{}]*\}', m.group(1)):
    b = blk.group(0)
    name = re.search(r'name\s*:\s*[\'"]([^\'"]+)[\'"]', b)
    minu = re.search(r'min_usd\s*:\s*([0-9_]+)', b)
    pct  = re.search(r'rebate_pct\s*:\s*([0-9._]+)', b)
    if not (name and minu and pct):
        print('TIER_PARSE_ERROR', file=sys.stderr); sys.exit(3)
    # Numeric-normalize: int min_usd, float rebate_pct -> 0.5 == 0.50.
    tiers.append([name.group(1), int(minu.group(1).replace('_', '')), float(pct.group(1))])

pm = re.search(r'POOL_SPLIT_BPS\s*=\s*([0-9_]+)', src)
if not tiers or not pm:
    print('EXTRACT_FAILED', file=sys.stderr); sys.exit(3)
pool = int(pm.group(1).replace('_', ''))

print(json.dumps({'tiers': tiers, 'pool': pool}, separators=(',', ':')))
PY
}

A_C=$(extract "$A")
B_C=$(extract "$B")
C_C=$(extract "$C")

if [[ "$A_C" == "$B_C" && "$B_C" == "$C_C" ]]; then
  echo "OK: TIERS + POOL_SPLIT_BPS semantic mirror across indexer, sdk, and frontend"
  echo "  $A_C"
  exit 0
fi

echo "FATAL: tiers.ts drift across the three mirrors" >&2
echo "  indexer  $A: $A_C" >&2
echo "  sdk      $B: $B_C" >&2
echo "  frontend $C: $C_C" >&2
echo "  Mismatch silently misallocates rebates or misdisplays tiers. Reconcile all three in the same PR." >&2
exit 2
