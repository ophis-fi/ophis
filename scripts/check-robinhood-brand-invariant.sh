#!/usr/bin/env bash
# Hard CI gate: Robinhood Chain branding (2026-08-02, supplied by the Robinhood
# Chain team) is black #1c180d feather on neon #CCFF00. The retired #00C805
# green must not come back, and the light-mode accent override must stay on the
# light path. The jest assertions mirroring these checks live in
# libs/ui/src/theme/ThemeColorVars.test.ts and libs/common-const/src/robinhood.test.ts,
# but the frontend jest suite is not a repo-root CI gate (see the
# solver-registry-invariant note in security.yml), so this script is the gate
# that actually binds.
set -euo pipefail

fail() {
  echo "check-robinhood-brand-invariant: FAIL — $1" >&2
  exit 1
}

CHAIN_INFO=apps/frontend/libs/common-const/src/chainInfo.ts
THEME=apps/frontend/libs/ui/src/theme/ThemeColorVars.tsx
CONST=apps/frontend/libs/common-const/src/robinhood.const.ts

# 1. The shared chain color (drives token-picker accents) is the brand neon.
#    Scope to the 4663 entry: from its key line to its closing "  }," brace.
#    (An end pattern of /^  \[/ would also match the START line and collapse
#    the range to one line — caught when this check false-failed on main.)
sed -n '/\[4663 as unknown as SupportedChainId\]: {/,/^  },/p' "$CHAIN_INFO" \
  | grep -q "color: '#CCFF00'" \
  || fail "$CHAIN_INFO 4663 entry does not set color: '#CCFF00'"

# 2. Light-mode contrast override present and on the LIGHT path specifically.
awk '/\[4663 as unknown as SupportedChainId\]: \{/,/\}/' "$THEME" \
  | grep -q "lightColor: '#5C7300'" \
  || fail "$THEME 4663 override does not set lightColor: '#5C7300'"

# 3. The chain icon data URI decodes to the brand art (neon ground + dark feather).
B64=$(grep -o "data:image/svg+xml;base64,[A-Za-z0-9+/=]*" "$CONST" | head -1 | cut -d, -f2)
[ -n "$B64" ] || fail "$CONST has no data:image/svg+xml;base64 ROBINHOOD_CHAIN_LOGO"
SVG=$(printf '%s' "$B64" | base64 -d 2>/dev/null || printf '%s' "$B64" | base64 -D)
printf '%s' "$SVG" | grep -q "#ccff00" || fail "decoded chain icon is missing the #ccff00 neon ground"
printf '%s' "$SVG" | grep -q "#1c180d" || fail "decoded chain icon is missing the #1c180d feather"

# 4. The retired green appears nowhere in frontend code (comment lines that
#    explicitly mark it as retired are exempt).
if grep -rn "00[cC]805" \
    apps/frontend/libs \
    apps/frontend/apps/cowswap-frontend/src \
    apps/frontend/apps/cowswap-frontend/public \
    apps/frontend/apps/ophis-landing/src \
    apps/frontend/apps/ophis-landing/public \
    --include='*.ts' --include='*.tsx' --include='*.astro' --include='*.svg' --include='*.html' --include='*.css' --exclude='*.test.*' \
    2>/dev/null | grep -vi "retired" | grep -q .; then
  grep -rn "00[cC]805" \
    apps/frontend/libs \
    apps/frontend/apps/cowswap-frontend/src \
    apps/frontend/apps/cowswap-frontend/public \
    apps/frontend/apps/ophis-landing/src \
    apps/frontend/apps/ophis-landing/public \
    --include='*.ts' --include='*.tsx' --include='*.astro' --include='*.svg' --include='*.html' --include='*.css' --exclude='*.test.*' \
    2>/dev/null | grep -vi "retired" >&2
  fail "retired #00C805 green found in frontend code (above)"
fi

echo "check-robinhood-brand-invariant: OK — neon #CCFF00 + #1c180d feather everywhere, light-mode override in place, no retired green"
