#!/usr/bin/env bash
# Verifies that the TIERS + POOL_SPLIT_BPS constants in
# apps/rebate-indexer/src/tiers.ts and packages/sdk/src/tiers.ts are
# semantically identical. Hard CI gate matching the comment-only mirror
# enforcement in both files. Drift would silently misallocate WETH.

set -euo pipefail

A=apps/rebate-indexer/src/tiers.ts
B=packages/sdk/src/tiers.ts

if [[ ! -f "$A" ]]; then echo "ERROR: $A missing" >&2; exit 1; fi
if [[ ! -f "$B" ]]; then echo "ERROR: $B missing" >&2; exit 1; fi

extract() {
  python3 - "$1" <<'PY'
import re, sys
with open(sys.argv[1]) as f:
    src = f.read()
src = re.sub(r'/\*[\s\S]*?\*/', '', src)
src = re.sub(r'//[^\n]*', '', src)
tiers_match = re.search(r'TIERS\s*:[^=]*=\s*(\[[\s\S]*?\])\s*as\s*const', src)
tiers = tiers_match.group(1) if tiers_match else 'NO_TIERS_FOUND'
pool_match = re.search(r'POOL_SPLIT_BPS\s*=\s*([0-9_]+)', src)
pool = pool_match.group(1) if pool_match else 'NO_POOL_FOUND'
canon = re.sub(r'\s+', '', tiers + '|' + pool).replace('_', '')
print(canon)
PY
}

A_CANON=$(extract "$A")
B_CANON=$(extract "$B")

if [[ "$A_CANON" == "$B_CANON" ]]; then
  echo "OK: TIERS + POOL_SPLIT_BPS semantic mirror across $A and $B"
  exit 0
fi

echo "FATAL: tiers.ts drift between rebate-indexer and packages/sdk" >&2
echo "  $A canonicalized: $A_CANON" >&2
echo "  $B canonicalized: $B_CANON" >&2
echo "  Mismatch will silently misallocate rebates. Reconcile both files in the same PR." >&2
exit 2
