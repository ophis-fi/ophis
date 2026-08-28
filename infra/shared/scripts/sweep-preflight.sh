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
# code, and the per-token thresholds - aborting on any of them. It does NOT cover
# the nonce guards: those sit inside each runner's --broadcast branch, so the
# dry-run never reaches them and this script exercises them separately.
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
# The same defaults each runner falls back to when OPHIS_RPC is unset. Without
# these, a dry-run could succeed against localhost:400X while the owner check
# below silently used cast's own default endpoint - a different chain entirely.
default_rpc() {
  case "$1" in
    optimism)  echo "http://localhost:4001/main/evm/10" ;;
    unichain)  echo "http://localhost:4002/main/evm/130" ;;
    robinhood) echo "http://localhost:4003/main/evm/4663" ;;
  esac
}
# Env first, then the chain's .env - the runners' own precedence. Resolving only
# the exported form would force UNKNOWN for a destination the runner reads happily.
cfg() { # var, chain-dir
  local v="${!1:-}" f
  if [[ -z "$v" ]]; then
    f="$REPO_ROOT/infra/$2/.env"
    [[ -f "$f" ]] && v="$(grep -E "^$1=" "$f" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\042\047 ' || true)"
  fi
  printf '%s' "$v"
}
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

# RPC URLs routinely carry a provider credential (a dkey= query param, a token in
# the path, userinfo before the @). Preflight output lives in terminal scrollback
# and ceremony logs, so an ordinary connectivity failure must not put that
# credential there. Print scheme://host and nothing else.
redact_url() {
  sed -E -e 's#(://)[^@/]*@#\1#' -e 's#(://[^/?#]+).*#\1#' <<<"$1"
}

# Shape-check BROADCASTER once, before anything can skip past it. It is meant to
# be the PUBLIC ops EOA; a 64-hex value is almost certainly a pasted private key,
# and every later branch that mentions it would put that secret in the ceremony
# log. Refuse up front and never echo the value. (An earlier version validated
# this deep inside the Optimism branch, behind a `continue` that skipped it.)
if [[ -n "${BROADCASTER:-}" && ! "$BROADCASTER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: BROADCASTER is not a 20-byte address (value withheld)." >&2
  echo "       Pass the fee-ops EOA ADDRESS, never a private key." >&2
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
  # Strip any ambient key before delegating. The runner only loads a PK under
  # --broadcast, but the forge script it invokes reads PRIVATE_KEY from the
  # environment to derive a broadcaster, so a key sitting in the operator's shell
  # would be read during what is advertised as a key-free preflight.
  if out="$(env -u PRIVATE_KEY -u PK "$runner" 2>&1)"; then
    ok "$label: sweep dry-run accepted its configuration"
  else
    reason="$(grep -iE 'ERROR|ABORT' <<<"$out" | tail -1)"
    bad "$label: sweep dry-run REFUSED to run - ${reason:-see runner output}"
  fi

  # 2. The destination's OWNERS, which no runner checks. Resolved the way that
  #    chain's sweep resolves it: robinhood from its own variable (it has no
  #    default and refuses without it), unichain from the ambient SAFE the forge
  #    script consumes, optimism from the liquidator's immutable feeSafe.
  eff_rpc="${OPHIS_RPC:-$(default_rpc "$label")}"
  rpc_args=(--rpc-url "$eff_rpc")
  # Confirm the endpoint is the chain we think it is before trusting anything read
  # through it. A wrong-chain RPC answers every call below happily, just about a
  # different deployment.
  case "$label" in optimism) want_id=10 ;; unichain) want_id=130 ;; robinhood) want_id=4663 ;; esac
  got_id="$(cast chain-id --rpc-url "$eff_rpc" 2>/dev/null)"
  if [[ "$got_id" != "$want_id" ]]; then
    bad "$label: RPC $(redact_url "$eff_rpc") reports chain id ${got_id:-unreachable}, expected $want_id"
    continue
  fi
  case "$label" in
    robinhood) dest="$(cfg OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD "$(chain_dir "$label")")" ;;
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

  # The runner aborts when liquidator() is address(0), but never checks it is the
  # key you meant. Without an expected value this cannot tell a live ops key from
  # a rotated one, so it reports UNKNOWN rather than passing.
  if [[ "$label" == "optimism" && -n "${FEE_LIQUIDATOR:-}" ]]; then
    liq_eoa="$(cast call "$FEE_LIQUIDATOR" "liquidator()(address)" "${rpc_args[@]}" 2>/dev/null | awk '{print $1}')"
    if [[ -z "${BROADCASTER:-}" ]]; then
      unknown "optimism: liquidator() is ${liq_eoa:-unreadable} but no BROADCASTER was given to compare against"
    elif [[ "$(tr '[:upper:]' '[:lower:]' <<<"$liq_eoa")" == "$(tr '[:upper:]' '[:lower:]' <<<"$BROADCASTER")" ]]; then
      ok "optimism: liquidator() is the intended ops key"
    else
      bad "optimism: liquidator() is $liq_eoa, not the intended ops EOA $BROADCASTER"
    fi
  fi

  # 3. The nonce guards live inside each runner's --broadcast branch, so the
  #    dry-run never reaches them. An endpoint that serves every call above while
  #    rejecting eth_getTransactionCount would pass here and abort at broadcast.
  if [[ "$label" != "optimism" ]]; then
    nonce_rpc="$eff_rpc"
    [[ "$label" == "robinhood" && -n "${OPHIS_NONCE_RPC:-}" ]] && nonce_rpc="$OPHIS_NONCE_RPC"
    if cast nonce "$dest" --rpc-url "$nonce_rpc" >/dev/null 2>&1; then
      ok "$label: nonce endpoint serves eth_getTransactionCount"
    else
      bad "$label: nonce endpoint cannot serve eth_getTransactionCount - the broadcast guard would abort"
    fi
  fi
done

echo
echo "preflight: $PASSES passed, $FAILS failed, $UNKNOWNS unknown"
[[ $FAILS -gt 0 ]] && exit 1
[[ $UNKNOWNS -gt 0 ]] && exit 2
exit 0
