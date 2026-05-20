#!/usr/bin/env bash
# Ophis — cross-workspace partner-fee recipient invariant check.
#
# Phase 2.3 (2026-05-20). Prevents the PR #120 drift class:
# the Ophis partner-fee recipient address is declared as
# OPHIS_PARTNER_FEE_RECIPIENT in 3 separate source-of-truth files
# (different pnpm workspaces, so a single shared import isn't possible).
# If any of those 3 literals drifts from the canonical Safe address,
# fees route to the wrong destination silently.
#
# This script greps all 3 files for the address literal and asserts
# byte-identical match. Run in CI on every PR; fail the PR if drift
# detected.
#
# Exit codes:
#   0 — all 3 match the canonical address
#   1 — drift detected (mismatch OR missing file)
#   2 — unexpected: more or fewer matches than 3

set -euo pipefail

# The canonical address — defined here, the 3 source-of-truth files
# MUST match exactly (case-sensitive). EIP-55 mixed-case form (per
# feedback_eip55_check_new_addresses.md from 2026-05-17 incident).
CANONICAL="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The 3 files that MUST declare the canonical address.
FILES=(
  "apps/frontend/libs/common-const/src/feeRecipient.ts"
  "apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts"
  "packages/sdk/src/partner-fee.ts"
)

errors=0
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "FAIL: source-of-truth file missing: $f" >&2
    errors=$((errors + 1))
    continue
  fi
  # Match the canonical literal exactly (case-sensitive).
  if ! grep -qF "$CANONICAL" "$f"; then
    echo "FAIL: $f does not contain canonical literal $CANONICAL" >&2
    # Show what address-shaped strings IT does contain, to aid debugging.
    found=$(grep -oE '0x[a-fA-F0-9]{40}' "$f" | sort -u | tr '\n' ' ' || true)
    echo "       (file contains addresses: $found)" >&2
    errors=$((errors + 1))
  fi
done

if (( errors > 0 )); then
  echo "" >&2
  echo "Partner-fee invariant FAILED ($errors mismatches)." >&2
  echo "" >&2
  echo "Background: the Ophis partner-fee recipient is the Safe at" >&2
  echo "  $CANONICAL" >&2
  echo "It must be declared identically in all 3 files above. They're in" >&2
  echo "different pnpm workspaces so a single shared import isn't viable." >&2
  echo "" >&2
  echo "If you're rotating the partner-fee Safe, update this script's" >&2
  echo "CANONICAL constant AND all 3 source files in the SAME PR. See" >&2
  echo "PR #120 for the prior drift incident." >&2
  exit 1
fi

echo "OK: partner-fee canonical literal ($CANONICAL) present in all 3 source-of-truth files."
exit 0
