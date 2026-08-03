#!/bin/bash
# Mutation tests for the CoW-arrival tripwire's two source-parsing probes.
#
# Both probes read PROSE-ADJACENT upstream source (a TypeScript enum, a JSDoc
# comment) that CoW formats however it likes. A purely cosmetic upstream
# reformat has already moved a signal once, on 2026-08-03, when networks_stub
# fired GONE ("CoW frontend migration started") because a comment reflowed.
#
# So these probes get mutation tests. Two rules learned building this file, both
# the hard way:
#   1. Every case asserts the mutation was ACTUALLY APPLIED. The first draft
#      used unanchored s/// against a file whose first match is a commented-out
#      decoy enum of the same name, so the fixtures mutated the decoy and every
#      assertion was vacuously true.
#   2. No case may run the assertion inside a pipeline. `mutate | run` puts run
#      in a subshell, discarding the failure counter, and the suite reported
#      "all passed" with a visible FAIL on screen. Assertions use here-strings.
#
# Offline by design: fixtures are inline, no network, safe for CI.
set -uo pipefail

SCRIPT="${1:-$(dirname "$0")/cow-arrival-tripwire.sh}"
[[ -f "$SCRIPT" ]] || { echo "FATAL: no script at $SCRIPT"; exit 1; }
fails=0

# --- extract the real functions from the shipped script ---------------------
# Deliberately NOT a reimplementation: a checker that reimplements what it
# checks cannot fail on a bug in the original.
extract() { awk -v fn="^$1\\\\(\\\\)" '$0 ~ fn{f=1} f{print} f&&/^\}/{exit}' "$SCRIPT"; }
for fn in sdk_signal stub_signal; do
  body=$(extract "$fn")
  [[ -z "$body" ]] && { echo "FATAL: could not extract $fn() from $SCRIPT"; exit 1; }
  eval "$body"
done
# Guard against extracting a stale line-based version.
extract sdk_signal  | grep -q 'perl -0777' || { echo "FATAL: sdk_signal is not the slurp version"; exit 1; }
extract stub_signal | grep -q 'perl -0777' || { echo "FATAL: stub_signal is not the slurp version"; exit 1; }

FIXTURE=""
fetch_raw() { printf '%s' "$FIXTURE"; }   # stub: no network

# --- fixtures ---------------------------------------------------------------
# Mirrors the real upstream shape, including the commented-out decoy enum of
# the SAME NAME that precedes the real declaration, and the neighbouring
# EvmChains enum that legitimately lists OPTIMISM. Any mutation not ^-anchored
# hits the decoy instead of the real enum and proves nothing.
read -r -d '' TYPES_TS <<'EOF'
import { MAINNET_ID, BNB_ID } from './const'

// Legacy shape, kept for reference:
// export enum SupportedChainId {
//   MAINNET = 1,
// }

export enum SupportedChainId {
  MAINNET = MAINNET_ID,
  BNB = BNB_ID,
  SEPOLIA = SEPOLIA_ID,
}

/**
 * Chains where you can buy tokens using the bridge functionality.
 * These chains are not supported by CoW Protocol directly.
 */
export enum EvmChains {
  MAINNET = MAINNET_ID,
  OPTIMISM = OPTIMISM_ID,
}
EOF

read -r -d '' NETWORKS_TS <<'EOF'
export const RPC_URL_ENVS = {
  [EvmChains.OPTIMISM]: process.env['REACT_APP_NETWORK_URL_10'],
}

/**
 * Network URLs used when no other source of chain data is available.
 *
 * Includes `OPTIMISM` because it lives in `EvmChains`; on-chain trading there is not
 * supported by CoW Protocol today and its entry is a stub for future migration.
 */
export const RPC_URLS = {}
EOF

# --- runner -----------------------------------------------------------------
# MUST be called with a here-string, never as the right side of a pipeline:
# a pipeline would run this in a subshell and silently drop `fails`.
run() { # $1 probe fn, $2 label, $3 expected, $4 original ('' = not a mutation)
  local fn label expected orig got status
  fn="$1"; label="$2"; expected="$3"; orig="${4:-}"; FIXTURE=$(cat)
  if [[ -n "$orig" && "$FIXTURE" == "$orig" ]]; then
    status="FAIL(MUTATION-NOT-APPLIED)"; got="-"
  else
    got=$("$fn")
    status=$([[ "$got" == "$expected" ]] && echo PASS || echo "FAIL(want:$expected)")
  fi
  [[ "$status" == PASS ]] || fails=$((fails + 1))
  printf '  %-34s %-28s %s\n' "$label" "$got" "$status"
}
mutate() { perl -0777 -pe "$1" <<< "$2"; }   # $1 = expr, $2 = input -> stdout

echo "sdk_enum probe:"
run sdk_signal "baseline (no CoW support)" "optimism=no unichain=no" "" <<< "$TYPES_TS"

# The neighbouring EvmChains enum legitimately lists OPTIMISM: must not leak in.
# (Covered by the baseline above: the fixture already contains it.)

# A member commented out with /* */ rather than // must NOT read as arrival.
run sdk_signal "block-commented member" "optimism=no unichain=no" "$TYPES_TS" \
  <<< "$(mutate 's{^(export enum SupportedChainId \{\n)}{$1  /* OPTIMISM = OPTIMISM_ID, */\n}m' "$TYPES_TS")"

run sdk_signal "multiline block comment" "optimism=no unichain=no" "$TYPES_TS" \
  <<< "$(mutate 's{^(export enum SupportedChainId \{\n)}{$1  /* soon:\n     UNICHAIN = UNICHAIN_ID,\n   */\n}m' "$TYPES_TS")"

# A reflowed declaration must not blind the probe. The old line-anchored version
# returned ERR here, and ERR transitions are suppressed by the alerting layer,
# so the probe would have gone permanently silent.
run sdk_signal "reflowed declaration" "optimism=no unichain=no" "$TYPES_TS" \
  <<< "$(mutate 's{^export enum SupportedChainId \{$}{export enum\n  SupportedChainId\n\{}m' "$TYPES_TS")"

run sdk_signal "decoy commented enum ignored" "optimism=no unichain=no" "$TYPES_TS" \
  <<< "$(mutate 's{^(// export enum SupportedChainId \{\n)}{$1//   OPTIMISM = 10,\n}m' "$TYPES_TS")"

# THE POINT OF THE WHOLE TRIPWIRE: a genuine arrival must still fire.
run sdk_signal "REAL optimism arrival" "optimism=YES unichain=no" "$TYPES_TS" \
  <<< "$(mutate 's{^(export enum SupportedChainId \{\n)}{$1  OPTIMISM = OPTIMISM_ID,\n}m' "$TYPES_TS")"

# ...even if upstream reflows in the same release.
run sdk_signal "REAL arrival + reflow" "optimism=no unichain=YES" "$TYPES_TS" \
  <<< "$(mutate 's{^(export enum SupportedChainId \{\n)}{$1  UNICHAIN = UNICHAIN_ID,\n}m; s{^export enum SupportedChainId \{$}{export enum\n  SupportedChainId\n\{}m' "$TYPES_TS")"

# Structural change must surface as PARSE, not hide behind ERR suppression.
run sdk_signal "enum renamed -> PARSE" "PARSE" "$TYPES_TS" \
  <<< "$(mutate 's{^export enum SupportedChainId\b}{export enum SupportedChainIdX}m' "$TYPES_TS")"

run sdk_signal "fetch failure -> ERR" "ERR" "" <<< ""

echo "networks_stub probe:"
run stub_signal "baseline (comment present)" "present" "" <<< "$NETWORKS_TS"

# The 2026-08-03 false positive: comment reflowed, meaning unchanged. Note the
# wrap falls BETWEEN "future" and "migration", so collapsing whitespace alone
# still leaves "future * migration" - the JSDoc markers must be stripped too.
run stub_signal "comment reflowed -> present" "present" "$NETWORKS_TS" \
  <<< "$(mutate 's{OPTIMISM` because it lives in `EvmChains`; on-chain trading there is not\n \* supported by CoW Protocol today and its entry is a stub for future migration}{OPTIMISM`\n * lives in `EvmChains`; trading there is not supported today and the entry\n * is a stub for future\n * migration}' "$NETWORKS_TS")"

# Genuine removal must still read GONE.
run stub_signal "comment removed -> GONE" "GONE" "$NETWORKS_TS" \
  <<< "$(mutate 's{^.*(?:future migration|Includes .OPTIMISM.).*$}{}mg' "$NETWORKS_TS")"

# A bridge-only note about some OTHER chain must not hold the signal present.
run stub_signal "other chain only -> GONE" "GONE" "" \
  <<< "export const X = 1 // BASE is bridge-only for now."

run stub_signal "fetch failure -> ERR" "ERR" "" <<< ""

echo
if [[ $fails -eq 0 ]]; then echo "all probe tests passed"; else echo "$fails FAILING"; fi
exit $(( fails > 0 ))
