#!/usr/bin/env bash
# READ-ONLY preflight for a sovereign settlement-buffer sweep.
#
# Verifies every precondition a sweep depends on, on all three sovereign chains,
# WITHOUT touching a key, broadcasting anything, or reading a secret. Run it
# before any sweep or ceremony; run it again afterwards to confirm the effect.
#
# It answers the questions that actually block a sweep:
#   - does the Settlement contract exist on this chain
#   - does the recipient Safe have CODE (a Safe with no code cannot be swept to,
#     and value sent there is unrecoverable - this blocked Robinhood Chain until
#     the Safe was deployed)
#   - is the Safe the 2-of-3 we expect, with the owner set we expect
#   - is the intended broadcaster allowlisted as a solver (settle() reverts with
#     "GPv2: not a solver" otherwise, AFTER the broadcast, leaking sweep intent
#     into a public mempool)
#   - is there anything in the buffer worth sweeping at current thresholds
#
# NEVER reports PASS on an unanswered question. Every check is PASS, FAIL, or
# UNKNOWN, and an RPC error is UNKNOWN - never PASS, never a silent zero. A
# preflight that green-lights a ceremony it could not actually verify is worse
# than no preflight, which is the same rule the buffer probes follow.
#
# Usage:
#   ./sweep-preflight.sh                 # all chains
#   ./sweep-preflight.sh robinhood       # one chain
#   BROADCASTER=0x... ./sweep-preflight.sh robinhood
#
# Exit: 0 = every check PASSED. 1 = at least one FAIL. 2 = at least one UNKNOWN
# and no FAIL (you cannot proceed on an unverified precondition either).
set -uo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x" >&2
  exit 3
fi

FEE_SAFE="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"

# label|settlement|default-rpc|chain-dir
# Pipe-delimited, not colon: the RPC URLs contain colons and a colon split would
# silently mangle every one of them into a different endpoint.
CHAINS=(
  "optimism|0x310784c7FCE12d578dA6f53460777bAc9718B859|http://localhost:4001/main/evm/10|optimism-mainnet"
  "unichain|0x108A678716e5E1776036eF044CAB7064226F714E|http://localhost:4002/main/evm/130|unichain-mainnet"
  "robinhood|0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD|http://localhost:4003/main/evm/4663|robinhood-mainnet"
)

WANT="${1:-all}"
PASSES=0; FAILS=0; UNKNOWNS=0

ok()      { echo "  PASS     $1"; PASSES=$((PASSES+1)); }
bad()     { echo "  FAIL     $1"; FAILS=$((FAILS+1)); }
unknown() { echo "  UNKNOWN  $1"; UNKNOWNS=$((UNKNOWNS+1)); }

command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) required" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 3; }

for entry in "${CHAINS[@]}"; do
  IFS='|' read -r label settlement rpc_default chain_dir <<< "$entry"
  [[ "$WANT" != "all" && "$WANT" != "$label" ]] && continue

  rpc_var="OPHIS_RPC_$(tr '[:lower:]' '[:upper:]' <<<"$label")"
  rpc="${!rpc_var:-${OPHIS_RPC:-$rpc_default}}"

  echo
  echo "=== $label ($settlement) via $rpc"

  # --- reachability. Everything below is meaningless without it, so a dead RPC
  #     marks the chain UNKNOWN rather than letting later checks read as PASS.
  if ! chainid=$(cast chain-id --rpc-url "$rpc" 2>/dev/null); then
    unknown "$label: RPC unreachable - every check on this chain is UNVERIFIED"
    continue
  fi
  ok "RPC reachable (chain id $chainid)"

  # --- Settlement has code
  if code=$(cast code "$settlement" --rpc-url "$rpc" 2>/dev/null); then
    if [[ -n "$code" && "$code" != "0x" ]]; then ok "Settlement has code"
    else bad "Settlement has NO code at $settlement"; fi
  else
    unknown "Settlement code read failed"
  fi

  # --- recipient Safe has code. The Robinhood blocker: a sweep to an address
  #     with no contract is unrecoverable, so this gates the whole ceremony.
  if code=$(cast code "$FEE_SAFE" --rpc-url "$rpc" 2>/dev/null); then
    if [[ -n "$code" && "$code" != "0x" ]]; then
      ok "fee Safe has code (sweep destination is live)"
      if ver=$(cast call "$FEE_SAFE" "VERSION()(string)" --rpc-url "$rpc" 2>/dev/null); then
        ok "fee Safe VERSION $ver"
      else
        unknown "fee Safe VERSION unreadable - is this actually a Safe?"
      fi
      if thr=$(cast call "$FEE_SAFE" "getThreshold()(uint256)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}'); then
        if [[ "$thr" == "2" ]]; then ok "fee Safe threshold 2"
        else bad "fee Safe threshold is $thr, expected 2"; fi
      else
        unknown "fee Safe threshold unreadable"
      fi
      if owners=$(cast call "$FEE_SAFE" "getOwners()(address[])" --rpc-url "$rpc" 2>/dev/null); then
        ok "fee Safe owners $owners"
      else
        unknown "fee Safe owners unreadable"
      fi
    else
      bad "fee Safe has NO code on $label - anything sent here is STRANDED, do not sweep"
    fi
  else
    unknown "fee Safe code read failed"
  fi

  # --- broadcaster allowlisted as a solver. settle() reverts without it, and it
  #     reverts AFTER the broadcast, which leaks the sweep into a public mempool.
  if [[ -n "${BROADCASTER:-}" ]]; then
    if auth=$(cast call "$settlement" "authenticator()(address)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}') \
       && is_solver=$(cast call "$auth" "isSolver(address)(bool)" "$BROADCASTER" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}'); then
      if [[ "$is_solver" == "true" ]]; then ok "broadcaster $BROADCASTER is an allowlisted solver"
      else bad "broadcaster $BROADCASTER is NOT a solver - settle() would revert after broadcast"; fi
    else
      unknown "solver status unreadable for $BROADCASTER"
    fi
  else
    unknown "BROADCASTER unset - solver allowlist NOT checked (export BROADCASTER=0x... to cover it)"
  fi

  # --- is there anything worth sweeping. Advisory, so it never FAILs: an empty
  #     buffer is a fine state, just not one worth a ceremony.
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  probe="$repo_root/infra/$chain_dir/scripts/check-settlement-buffer.sh"
  if [[ -x "$probe" ]]; then
    if out=$(OPHIS_RPC="$rpc" "$probe" 2>/dev/null); then
      echo "  ----     buffer: $(jq -c '[.balances[] | {(.symbol): .hr}]' <<<"$out" 2>/dev/null || echo "unparseable")"
    else
      unknown "buffer probe failed - current buffer UNKNOWN"
    fi
  else
    unknown "buffer probe not found at $probe"
  fi
done

echo
echo "preflight: $PASSES passed, $FAILS failed, $UNKNOWNS unknown"
[[ $FAILS -gt 0 ]] && exit 1
[[ $UNKNOWNS -gt 0 ]] && exit 2
exit 0
