#!/usr/bin/env bash
# Fail CI when public Ophis copy regresses to the retired sovereign fee model or
# reintroduces networks removed from the public product surface.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PUBLIC_PATHS=(
  apps/docs-ophis/docs
  apps/docs-ophis/static
  apps/frontend/apps/ophis-landing/src
  apps/frontend/apps/ophis-landing/public
  apps/frontend/apps/cowswap-frontend/public
)

fail=0

reject() {
  local label="$1"
  local pattern="$2"
  local matches
  matches="$(grep -RInE --include='*.md' --include='*.mdx' --include='*.astro' --include='*.html' --include='*.txt' "$pattern" "${PUBLIC_PATHS[@]}" || true)"
  if [[ -n "$matches" ]]; then
    echo "FAIL: $label" >&2
    echo "$matches" >&2
    fail=1
  fi
}

reject "removed sovereign-chain names remain on a public surface" 'MegaETH|HyperEVM'
reject "retired 100%-surplus promise remains on a public surface" '100% (of (any |the |that )?(price improvement|improvement|surplus)|of it goes to the (wallet|trader)|to you)'
reject "retired flat sovereign pricing remains on a public surface" '(flat 0\.10%|0\.10% flat|Surplus returned in full|takes zero cut of surplus|takes no share of (any )?surplus)'
reject "retired sovereign floor remains on a public surface" '(4 bps non-stable|below \*\*4 bps|always embeds (the )?flat 5 bps)'
reject "retired sovereign capture caps remain on a public surface" '(volatile.{0,100}(30 bps|0\.30%)|(30 bps|0\.30%).{0,100}volatile|stable.{0,100}(10 bps cap|capped at 10 bps|0\.10% stables)|(10 bps cap|capped at 10 bps|0\.10% stables).{0,100}stable)'

require_text() {
  local file="$1"
  local text="$2"
  if ! grep -qF "$text" "$file"; then
    echo "FAIL: $file is missing canonical economics text: $text" >&2
    fail=1
  fi
}

require_text apps/docs-ophis/docs/fees.md "80% of price improvement on volatile pairs"
require_text apps/docs-ophis/docs/fees.md "50% on stablecoin pairs"
require_text apps/docs-ophis/docs/fees.md "capped at 50 bps of volume"
require_text apps/docs-ophis/docs/fees.md "capped at 20 bps"
require_text apps/frontend/apps/ophis-landing/src/content/blog/solver-aligned-pricing.md "The base remains 1 bp in both cases."
require_text apps/frontend/apps/cowswap-frontend/public/business/index.html "Robinhood payout is not"
require_text infra/optimism-mainnet/configs/autopilot.toml "max-volume-factor = 0.005"
require_text infra/unichain-mainnet/configs/autopilot.toml.tmpl "max-volume-factor = 0.005"
require_text infra/robinhood-mainnet/configs/autopilot.toml.tmpl "max-volume-factor = 0.005"
require_text apps/backend/crates/autopilot/src/domain/fee/mod.rs "OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_FACTOR: f64 = 0.002"

if (( fail )); then
  echo "Public economics invariant FAILED." >&2
  exit 1
fi

echo "OK: public surfaces use the current sovereign economics and supported-chain set."
