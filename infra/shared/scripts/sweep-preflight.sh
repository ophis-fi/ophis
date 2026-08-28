#!/usr/bin/env bash
# READ-ONLY preflight for a sovereign settlement-buffer sweep.
#
# Runs each chain's OWN sweep-to-safe.sh in dry-run, then adds the single check
# the runners do not perform.
#
# Why delegate instead of re-deriving: an earlier version of this script
# reimplemented every runner's config precedence - destination, Settlement,
# submitter, RPC - and drifted from all three. Twelve review rounds found twelve
# ways the mirror disagreed with the thing it mirrored: each one either a
# preflight that green-lit a ceremony the runner would refuse, or one that
# failed a deployment the runner would have accepted. The runner is the source
# of truth about what the runner does. Ask it.
#
# The dry-run is safe: it never loads a key (the PK is read only under
# --broadcast), never broadcasts, and validates RPC shape and chain id, forge
# availability, the submitter, the Settlement, the destination and its on-chain
# code, the nonce guard, and the per-token thresholds - aborting on any of them.
#
# The one thing no runner checks: they verify the destination has CODE, never
# WHO controls it. A rotated or compromised Safe still has code, and a sweep
# into one is unrecoverable. So owners and threshold are checked here.
#
# Usage:
#   ./sweep-preflight.sh                # all chains
#   ./sweep-preflight.sh robinhood      # one chain
#
# Pass the runner's own environment through exactly as the sweep will be run:
#   OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD=0x... OPHIS_RPC=... ./sweep-preflight.sh robinhood
#
# Exit: 0 = everything PASSED. 1 = at least one FAIL. 2 = at least one UNKNOWN
# and no FAIL (an unverified precondition is not a green light either).
set -uo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x" >&2
  exit 3
fi

FEE_SAFE="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
# Same set the weekly safe-drift-check enforces, lowercase and sorted so the
# comparison is order- and case-insensitive.
EXPECTED_OWNERS='0x0494f503912c101bfd76b88e4f5d8a33de284d1a 0x746ad9c63cca6d3a8588731d60fb87deab4da46a 0xbec5b03ffdcac50071693e87bfdb88baa6710199'

CHAINS=(optimism unichain robinhood)
chain_dir() {
  case "$1" in
    optimism)  echo optimism-mainnet ;;
    unichain)  echo unichain-mainnet ;;
    robinhood) echo robinhood-mainnet ;;
  esac
}

WANT="${1:-all}"
if [[ "$WANT" != "all" ]] && ! printf '%s\n' "${CHAINS[@]}" | grep -qx -- "$WANT"; then
  # A mistyped chain must not reach "0 passed, 0 failed" and exit 0, which the
  # rehearsal reads as "every precondition met".
  echo "ERROR: unknown chain '$WANT'. Known: all ${CHAINS[*]}" >&2
  exit 3
fi

PASSES=0; FAILS=0; UNKNOWNS=0
ok()      { echo "  PASS     $1"; PASSES=$((PASSES+1)); }
bad()     { echo "  FAIL     $1"; FAILS=$((FAILS+1)); }
unknown() { echo "  UNKNOWN  $1"; UNKNOWNS=$((UNKNOWNS+1)); }

command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) required" >&2; exit 3; }
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

for label in "${CHAINS[@]}"; do
  [[ "$WANT" != "all" && "$WANT" != "$label" ]] && continue
  runner="$REPO_ROOT/infra/$(chain_dir "$label")/scripts/sweep-to-safe.sh"

  echo
  echo "=== $label"

  if [[ ! -x "$runner" ]]; then
    bad "$label: sweep runner missing at $runner"
    continue
  fi

  # 1. The runner's own dry-run IS the configuration preflight.
  if out="$("$runner" 2>&1)"; then
    ok "$label: sweep dry-run accepted its configuration"
  else
    reason="$(grep -iE 'ERROR|ABORT' <<<"$out" | tail -1)"
    bad "$label: sweep dry-run REFUSED to run - ${reason:-see runner output}"
  fi

  # 2. The destination's OWNERS, which no runner checks. Resolved the way that
  #    chain's sweep resolves it: robinhood from its own variable (it has no
  #    default and refuses without it), unichain from the ambient SAFE the forge
  #    script consumes, optimism from the liquidator's immutable feeSafe.
  rpc_args=(); [[ -n "${OPHIS_RPC:-}" ]] && rpc_args=(--rpc-url "$OPHIS_RPC")
  case "$label" in
    robinhood) dest="${OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD:-}" ;;
    unichain)  dest="${SAFE:-$FEE_SAFE}" ;;
    optimism)  dest="$(cast call "${FEE_LIQUIDATOR:-0x}" "feeSafe()(address)" "${rpc_args[@]}" 2>/dev/null | awk '{print $1}')" ;;
  esac

  if [[ ! "$dest" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    unknown "$label: could not resolve the sweep destination - owners UNVERIFIED"
    continue
  fi

  if owners=$(cast call "$dest" "getOwners()(address[])" "${rpc_args[@]}" 2>/dev/null) \
     && thr=$(cast call "$dest" "getThreshold()(uint256)" "${rpc_args[@]}" 2>/dev/null | awk '{print $1}'); then
    got="$(tr -d '[]' <<<"$owners" | tr ',' '\n' | tr '[:upper:]' '[:lower:]' \
           | grep -oE '0x[0-9a-f]{40}' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
    if [[ "$got" == "$EXPECTED_OWNERS" ]]; then
      ok "$label: destination $dest is the expected 2-of-3 Safe"
    else
      bad "$label: destination $dest owners DIFFER from expected: [$got]"
    fi
    [[ "$thr" == "2" ]] || bad "$label: destination threshold is $thr, expected 2"
  else
    unknown "$label: destination $dest owners unreadable - UNVERIFIED"
  fi
done

echo
echo "preflight: $PASSES passed, $FAILS failed, $UNKNOWNS unknown"
[[ $FAILS -gt 0 ]] && exit 1
[[ $UNKNOWNS -gt 0 ]] && exit 2
exit 0
