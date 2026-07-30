#!/usr/bin/env bash
# Ophis basket-metadata cross-workspace invariant (hard CI gate).
#
# The Ophis basket ("ophis-multi-order") appData marker is defined in source-of-
# truth files that live in DIFFERENT pnpm workspaces (no shared import is
# possible), so they are hand-mirrored:
#   1. packages/sdk/src/basket-metadata.ts             (the @ophis/sdk source: grammar + caps)
#   2. apps/frontend/.../src/ophis/basketMetadata.ts   (the frontend mirror: grammar + caps)
#   3. apps/rebate-indexer/src/fetcher.ts              (the indexer's basket_id grammar copy)
#
# If the basket-id GRAMMAR or the composition/leg CAPS drift between these, a
# marker minted on one side would fail validation (or group the wrong rows) on
# the other, and the rebate indexer's basket_id passthrough would attribute
# baskets inconsistently. This pure grep gate fails the PR on any drift.
#
# Pinned invariants:
#   * OPHIS_BASKET_ID_RE grammar : /^[0-9a-f]{32}$/   (all THREE files above)
#   * MAX_BASKET_SELL_TOKENS = 6                      (SDK + frontend mirror)
#   * MAX_BASKET_BUY_TOKENS  = 6                      (SDK + frontend mirror)
#   * MAX_BASKET_LEGS        = 6                      (SDK + frontend mirror)
#
# If you change one side of any invariant, change the others in the SAME PR
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
INDEXER_REL="apps/rebate-indexer/src/fetcher.ts"

# The basket-id grammar literal. This one must appear in ALL THREE files (the
# indexer parses metadata.ophisBasket.id with a third hardcoded copy).
GRAMMAR='/^[0-9a-f]{32}$/'

# Pinned literals the SDK source + frontend mirror MUST both contain (the grammar
# plus the caps). The indexer carries only the grammar, checked separately.
PINNED=(
  "$GRAMMAR"
  'MAX_BASKET_SELL_TOKENS = 6'
  'MAX_BASKET_BUY_TOKENS = 6'
  'MAX_BASKET_LEGS = 6'
)

# Assert one file contains a given fixed-string literal. Returns 1 on miss/absent file.
check_file_has() { # $1=file $2=literal $3=quiet?
  local f="$1" lit="$2" quiet="${3:-}"
  if [[ ! -f "$f" ]]; then
    [[ -n "$quiet" ]] || echo "FAIL: source-of-truth file missing: $f" >&2
    return 1
  fi
  if ! grep -qF -- "$lit" "$f"; then
    [[ -n "$quiet" ]] || echo "FAIL: $f is missing the pinned basket invariant: $lit" >&2
    return 1
  fi
  return 0
}

# Check the SDK source + frontend mirror both carry every pinned literal, and the
# indexer carries the grammar. Returns 1 on any miss.
check_all() { # $1=sdk $2=fe $3=indexer $4=quiet?
  local sdk="$1" fe="$2" indexer="$3" quiet="${4:-}"
  local errors=0 lit
  for lit in "${PINNED[@]}"; do
    check_file_has "$sdk" "$lit" "$quiet" || errors=$((errors + 1))
    check_file_has "$fe" "$lit" "$quiet" || errors=$((errors + 1))
  done
  check_file_has "$indexer" "$GRAMMAR" "$quiet" || errors=$((errors + 1))
  [[ $errors -eq 0 ]]
}

self_test() {
  local tmp good_sdk good_fe good_idx drift_fe drift_idx rc=0
  tmp="$(mktemp -d)"
  good_sdk="$tmp/sdk.ts"; good_fe="$tmp/fe.ts"; good_idx="$tmp/fetcher.ts"
  drift_fe="$tmp/fe_drift.ts"; drift_idx="$tmp/idx_drift.ts"

  # SDK + mirror carry the grammar and all caps.
  cat > "$good_sdk" <<'EOF'
export const OPHIS_BASKET_ID_RE = /^[0-9a-f]{32}$/
export const MAX_BASKET_SELL_TOKENS = 6
export const MAX_BASKET_BUY_TOKENS = 6
export const MAX_BASKET_LEGS = 6
EOF
  cp "$good_sdk" "$good_fe"
  # The indexer carries only the grammar copy.
  printf 'if (/^[0-9a-f]{32}$/.test(rawBasket)) basketId = rawBasket;\n' > "$good_idx"
  # A drifted mirror: leg cap widened to 8 (the exact class this gate must catch).
  cat > "$drift_fe" <<'EOF'
export const OPHIS_BASKET_ID_RE = /^[0-9a-f]{32}$/
export const MAX_BASKET_SELL_TOKENS = 6
export const MAX_BASKET_BUY_TOKENS = 6
export const MAX_BASKET_LEGS = 8
EOF
  # A drifted indexer grammar (wrong length): must be caught.
  printf 'if (/^[0-9a-f]{40}$/.test(rawBasket)) basketId = rawBasket;\n' > "$drift_idx"

  # Positive: matching trio must PASS.
  check_all "$good_sdk" "$good_fe" "$good_idx" quiet || { echo "SELF-TEST FAIL: a matching trio was rejected" >&2; rc=1; }
  # Negative: a drifted mirror cap must FAIL.
  check_all "$good_sdk" "$drift_fe" "$good_idx" quiet && { echo "SELF-TEST FAIL: a drifted leg cap was NOT caught" >&2; rc=1; }
  # Negative: a drifted indexer grammar must FAIL.
  check_all "$good_sdk" "$good_fe" "$drift_idx" quiet && { echo "SELF-TEST FAIL: a drifted indexer grammar was NOT caught" >&2; rc=1; }
  # Negative: a missing file must FAIL.
  check_all "$good_sdk" "$tmp/nope.ts" "$good_idx" quiet && { echo "SELF-TEST FAIL: a missing mirror was NOT caught" >&2; rc=1; }

  rm -rf "$tmp"
  [[ $rc -eq 0 ]] && echo "OK: basket-metadata invariant self-test passed."
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
  if check_all "$SDK_REL" "$FE_REL" "$INDEXER_REL"; then
    echo "OK: basket-metadata grammar + caps match across @ophis/sdk, the frontend mirror, and the indexer."
  else
    echo "" >&2
    echo "Basket-metadata invariant FAILED. The basket-id grammar must be byte-identical in:" >&2
    echo "  $SDK_REL" >&2
    echo "  $FE_REL" >&2
    echo "  $INDEXER_REL" >&2
    echo "and the 6x6 / 6-leg caps must match in the first two. Change them together in" >&2
    echo "the SAME PR (and this script's pinned literals if the grammar/caps changed)." >&2
    exit 1
  fi
}

main "$@"
