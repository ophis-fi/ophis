#!/usr/bin/env bash
# Ophis — cross-workspace OP partner-fee FLOOR invariant (hard CI gate).
#
# The OP self-hosted backend floors the CIP-75 Volume partner fee
# (app_data.rs partner_fee_floor_bps):
#   * OPHIS_DEFAULT_VOLUME_FEE_BPS (10 bps) for a non-stable, non-boosted pair,
#   * OPHIS_STABLE_VOLUME_FEE_BPS  (1 bp)   for a same-chain stable pair (both
#     tokens in OPTIMISM_STABLECOINS) OR a boosted pair (either token in
#     OPTIMISM_BOOSTED_TOKENS).
# The frontend CHARGES the matching rates from its OWN copies of these sets and
# values, in a SEPARATE pnpm workspace (no shared import is possible). If any of
# them drift, the backend floor REJECTS the legitimate reduced-rate order at
# ingress (PartnerFeeBelowFloor) — an availability regression.
#
# The backend Rust suite (the Rust drift test AND the floor-LOGIC unit tests:
# enforce_partner_fee_floor, the autopilot clamp/neutralization, the
# ProtocolFees::new startup assert) does NOT run in this repo's CI. This pure
# grep/awk script is therefore the hard CI gate for the cross-workspace INPUTS it
# can check without compiling:
#   1. OPTIMISM_STABLECOINS    address set (frontend tokens.ts        <-> backend)
#   2. OPTIMISM_BOOSTED_TOKENS  OP address set (frontend boostedTokens.ts <-> backend)
#   3. the floor VALUES 10 / 1             (backend <-> frontend <-> SDK)
# It does NOT substitute for the floor-LOGIC tests, which stay CI-unverified; the
# runtime code still enforces the floor regardless.
#
# Exit codes: 0 = all invariants hold; 1 = drift / missing file / parse failure.
#
# If you change one side of any invariant, change the others in the SAME PR.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TOKENS_TS="apps/frontend/libs/common-const/src/tokens.ts"
BOOSTED_TS="apps/frontend/apps/cowswap-frontend/src/ophis/boostedTokens.ts"
PARTNERFEE_TS="apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts"
APP_DATA="apps/backend/crates/app-data/src/app_data.rs"
SDK="packages/sdk/src/partner-fee.ts"

for f in "$TOKENS_TS" "$BOOSTED_TS" "$PARTNERFEE_TS" "$APP_DATA" "$SDK"; do
  [[ -f "$f" ]] || { echo "FAIL: source-of-truth file missing: $f" >&2; exit 1; }
done

fail=0

# Lowercased, sorted/uniq 0x-addresses inside a Rust `const <NAME> ... = &[ ... ];`
# block. Handles the empty single-line form `= &[];` and the `&[Address]` `]` on
# the declaration line (greedy strip to the LAST opening bracket; if the
# remainder already closes the array, stop there).
rust_addr_set() { # $1=file  $2=const name
  awk -v n="$2" '
    $0 ~ ("const " n) {
      line = $0
      sub(/.*(&\[|= \[)/, "", line)         # drop up to the opening bracket
      if (line ~ /\]/) { sub(/\].*/, "", line); print line; exit }  # single-line array
      print line
      f = 1
      next
    }
    f && /^[[:space:]]*\]/ { exit }          # array close (].map / ];)
    f { print }
  ' "$1" | grep -oE '0x[0-9a-fA-F]{40}' | tr 'A-F' 'a-f' | sort -u
}

# Lowercased, sorted/uniq 0x-addresses inside the frontend `const <NAME> = [ ... ]`.
ts_addr_set() { # $1=file  $2=const name
  awk -v n="$2" '
    $0 ~ ("const " n) { f=1; next }
    f && /^[[:space:]]*\]/ { exit }
    f { print }
  ' "$1" | grep -oE '0x[0-9a-fA-F]{40}' | tr 'A-F' 'a-f' | sort -u
}

compare_sets() { # $1=label $2=frontend-set $3=backend-set
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1 drift between frontend and backend." >&2
    echo "  frontend:" >&2; echo "${2:-  <empty>}" | sed 's/^/    /' >&2
    echo "  backend :" >&2; echo "${3:-  <empty>}" | sed 's/^/    /' >&2
    fail=1
  fi
}

# 1. OPTIMISM_STABLECOINS: frontend tokens.ts <-> backend app_data.rs
compare_sets "OPTIMISM_STABLECOINS" \
  "$(ts_addr_set "$TOKENS_TS" OPTIMISM_STABLECOINS)" \
  "$(rust_addr_set "$APP_DATA" OPTIMISM_STABLECOINS)"

# 2. OPTIMISM_BOOSTED_TOKENS (OP / chain 10 only): frontend boostedTokens.ts <-> backend.
# The per-chain map keys OP either by the enum (`[SupportedChainId.OPTIMISM]`) or
# by the numeric-cast style the repo also uses elsewhere (e.g. tokens.ts STABLECOINS
# uses `[10 as unknown as SupportedChainId]`), or a bare `[10]`. Match all three so
# an OP boosted entry added in any of them is seen (one line per chain, per the
# file's documented convention); no OP entry today.
fe_boosted_op="$(grep -E '\[(SupportedChainId\.OPTIMISM|10( as [^]]*)?)\]' "$BOOSTED_TS" | grep -oE '0x[0-9a-fA-F]{40}' | tr 'A-F' 'a-f' | sort -u || true)"
compare_sets "OPTIMISM_BOOSTED_TOKENS (OP)" \
  "$fe_boosted_op" \
  "$(rust_addr_set "$APP_DATA" OPTIMISM_BOOSTED_TOKENS)"

# 3. Floor VALUES. The 10 bps non-stable floor and the 1 bp reduced floor are
# hand-mirrored as literals across backend / frontend / SDK. Anchor each grep on
# the const DECLARATION (pub const / const / export const) so doc-comment
# mentions of the same name are not matched; head -1 as a belt-and-suspenders.
decl_num() { # $1=file  $2=anchored declaration regex (must end in the numeric literal)
  grep -oE "$2"' [0-9]+' "$1" | grep -oE '[0-9]+$' | head -1
}

be_default="$(decl_num "$APP_DATA"      'pub const OPHIS_DEFAULT_VOLUME_FEE_BPS: u64 =')"
be_stable="$(decl_num  "$APP_DATA"      'pub const OPHIS_STABLE_VOLUME_FEE_BPS: u64 =')"
fe_default="$(decl_num  "$PARTNERFEE_TS" 'const BACKEND_NON_STABLE_FLOOR_BPS =')"
fe_reduced="$(decl_num  "$BOOSTED_TS"    'const OPHIS_BOOSTED_VOLUME_BPS =')"
sdk_default="$(decl_num "$SDK"           'export const OPHIS_VOLUME_FEE_BPS =')"
sdk_stable="$(decl_num  "$SDK"           'export const OPHIS_STABLE_VOLUME_FEE_BPS =')"

check_value() { # $1=label $2=expected-nonempty ; remaining = actuals "name:val"
  local label="$1"; shift
  local ref="" name val
  for pair in "$@"; do
    name="${pair%%:*}"; val="${pair#*:}"
    if [[ -z "$val" ]]; then echo "FAIL: $label — could not parse $name" >&2; fail=1; continue; fi
    if [[ -z "$ref" ]]; then ref="$val"; continue; fi
    if [[ "$val" != "$ref" ]]; then
      echo "FAIL: $label drift — expected all equal, got $* " >&2; fail=1; break
    fi
  done
}

check_value "non-stable floor (10 bps)" \
  "backend:$be_default" "frontend:$fe_default" "sdk:$sdk_default"
check_value "reduced floor (1 bp)" \
  "backend:$be_stable" "sdk:$sdk_stable" "frontend-boosted:$fe_reduced"

if (( fail )); then
  echo "" >&2
  echo "Partner-fee floor invariant FAILED. These inputs drive the OP backend's" >&2
  echo "token-pair fee floor; the frontend/SDK must charge the same. Update all" >&2
  echo "sides (and the Rust drift test) in the SAME PR." >&2
  exit 1
fi

echo "OK: partner-fee floor invariants hold:"
echo "  - OPTIMISM_STABLECOINS match (frontend <-> backend)"
echo "  - OPTIMISM_BOOSTED_TOKENS[OP] match (frontend <-> backend)"
echo "  - floor values: non-stable=${be_default} bps, reduced=${be_stable} bp (backend/frontend/SDK agree)"
exit 0
