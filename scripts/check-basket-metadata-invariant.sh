#!/usr/bin/env bash
# Ophis basket-metadata cross-workspace invariant (hard CI gate).
#
# The Ophis basket ("ophis-multi-order") appData marker is defined in two
# source-of-truth files that live in DIFFERENT pnpm workspaces (no shared
# import is possible), so they are hand-mirrored:
#   1. packages/sdk/src/basket-metadata.ts             (the @ophis/sdk source)
#   2. apps/frontend/.../src/ophis/basketMetadata.ts   (the frontend mirror)
#
# If the basket-id GRAMMAR or the composition/leg CAPS drift between them, a
# marker minted on one side would fail validation (or group the wrong rows) on
# the other, and the rebate indexer's basket_id passthrough would attribute
# baskets inconsistently. This pure grep gate fails the PR on any drift.
#
# Pinned invariants (must appear byte-identically in BOTH files):
#   * OPHIS_BASKET_ID_RE grammar : /^[0-9a-f]{32}$/
#   * MAX_BASKET_SELL_TOKENS = 6
#   * MAX_BASKET_BUY_TOKENS  = 6
#   * MAX_BASKET_LEGS        = 6
#
# If you change one side of any invariant, change the other in the SAME PR
# (and this script's pinned literals if the grammar/caps themselves change).
#
# Usage:
#   scripts/check-basket-metadata-invariant.sh            # check the repo files
#   scripts/check-basket-metadata-invariant.sh --self-test # verify the checker itself
#
# Exit codes: 0 = invariants hold (or self-test passed); 1 = drift / missing file.

set -euo pipefail

SDK_REL="packages/sdk/src/basket-metadata.ts"
FE_REL="apps/frontend/apps/cowswap-frontend/src/ophis/basketMetadata.ts"

# Pinned literals both files MUST contain (case-sensitive, fixed-string match).
PINNED=(
  '/^[0-9a-f]{32}$/'
  'MAX_BASKET_SELL_TOKENS = 6'
  'MAX_BASKET_BUY_TOKENS = 6'
  'MAX_BASKET_LEGS = 6'
)

# Check that both given files contain every pinned literal. Returns 1 on any miss.
check_pair() {
  local sdk="$1" fe="$2" quiet="${3:-}"
  local errors=0 f lit
  for f in "$sdk" "$fe"; do
    if [[ ! -f "$f" ]]; then
      [[ -n "$quiet" ]] || echo "FAIL: source-of-truth file missing: $f" >&2
      errors=$((errors + 1))
      continue
    fi
    for lit in "${PINNED[@]}"; do
      if ! grep -qF -- "$lit" "$f"; then
        [[ -n "$quiet" ]] || echo "FAIL: $f is missing the pinned basket invariant: $lit" >&2
        errors=$((errors + 1))
      fi
    done
  done
  [[ $errors -eq 0 ]]
}

self_test() {
  local tmp good_sdk good_fe drift_fe rc=0
  tmp="$(mktemp -d)"
  good_sdk="$tmp/sdk.ts"
  good_fe="$tmp/fe.ts"
  drift_fe="$tmp/fe_drift.ts"

  # A file carrying all four pinned invariants.
  cat > "$good_sdk" <<'EOF'
export const OPHIS_BASKET_ID_RE = /^[0-9a-f]{32}$/
export const MAX_BASKET_SELL_TOKENS = 6
export const MAX_BASKET_BUY_TOKENS = 6
export const MAX_BASKET_LEGS = 6
EOF
  cp "$good_sdk" "$good_fe"
  # A drifted mirror: leg cap widened to 8 (the exact class this gate must catch).
  cat > "$drift_fe" <<'EOF'
export const OPHIS_BASKET_ID_RE = /^[0-9a-f]{32}$/
export const MAX_BASKET_SELL_TOKENS = 6
export const MAX_BASKET_BUY_TOKENS = 6
export const MAX_BASKET_LEGS = 8
EOF

  # Positive: matching pair must PASS.
  if ! check_pair "$good_sdk" "$good_fe" quiet; then
    echo "SELF-TEST FAIL: a matching pair was rejected" >&2
    rc=1
  fi
  # Negative: a drifted mirror must FAIL.
  if check_pair "$good_sdk" "$drift_fe" quiet; then
    echo "SELF-TEST FAIL: a drifted leg cap was NOT caught" >&2
    rc=1
  fi
  # Negative: a missing file must FAIL.
  if check_pair "$good_sdk" "$tmp/does-not-exist.ts" quiet; then
    echo "SELF-TEST FAIL: a missing mirror was NOT caught" >&2
    rc=1
  fi

  rm -rf "$tmp"
  if [[ $rc -eq 0 ]]; then
    echo "OK: basket-metadata invariant self-test passed."
  fi
  return $rc
}

main() {
  if [[ "${1:-}" == "--self-test" ]]; then
    self_test
    return
  fi
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_root"
  if check_pair "$SDK_REL" "$FE_REL"; then
    echo "OK: basket-metadata grammar + caps match across @ophis/sdk and the frontend mirror."
  else
    echo "" >&2
    echo "Basket-metadata invariant FAILED. The basket-id grammar and the 6x6 / 6-leg" >&2
    echo "caps must be byte-identical in:" >&2
    echo "  $SDK_REL" >&2
    echo "  $FE_REL" >&2
    echo "Change both (and this script's pinned literals if the grammar/caps changed)" >&2
    echo "in the SAME PR." >&2
    exit 1
  fi
}

main "$@"
