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
# Same expected set the weekly safe-drift-check enforces, kept lowercase+sorted so
# the comparison is order- and case-insensitive. Printing the owners without
# checking them is not verification: a rotated or compromised Safe still prints
# three addresses, and sweeping into it is unrecoverable.
EXPECTED_PARTNER_OWNERS_SORTED='0x0494f503912c101bfd76b88e4f5d8a33de284d1a 0x746ad9c63cca6d3a8588731d60fb87deab4da46a 0xbec5b03ffdcac50071693e87bfdb88baa6710199'

# Resolve a config value the way the sweep runners do: exported variable first,
# then the chain's .env. A preflight that reads only the exported form validates
# the canonical addresses while a different one sits in .env waiting to be used.
resolve_cfg() { # $1=var name  $2=chain dir
  local v="${!1:-}"
  if [[ -z "$v" ]]; then
    local f
    f="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/infra/$2/.env"
    [[ -f "$f" ]] && v="$(grep -E "^$1=" "$f" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\042\047 ' || true)"
  fi
  printf '%s' "$v"
}

norm_owners() { # normalise a cast address[] into a sorted lowercase space-joined list
  tr -d '[]' | tr ',' '\n' | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^0-9a-fx]//g' | grep -E '^0x[0-9a-f]{40}$' | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

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

# A mistyped chain would otherwise skip every iteration and exit 0 with
# "0 passed, 0 failed" - which the rehearsal reads as "all preconditions met".
# `sweep-preflight.sh robinhod` must never green-light a ceremony.
if [[ "$WANT" != "all" ]]; then
  known=0
  for entry in "${CHAINS[@]}"; do
    IFS='|' read -r l _ _ _ <<< "$entry"
    [[ "$l" == "$WANT" ]] && known=1
  done
  if [[ "$known" != "1" ]]; then
    echo "ERROR: unknown chain '$WANT'. Known: all, optimism, unichain, robinhood" >&2
    exit 3
  fi
fi

ok()      { echo "  PASS     $1"; PASSES=$((PASSES+1)); }
bad()     { echo "  FAIL     $1"; FAILS=$((FAILS+1)); }
unknown() { echo "  UNKNOWN  $1"; UNKNOWNS=$((UNKNOWNS+1)); }

command -v cast >/dev/null 2>&1 || { echo "ERROR: cast (foundry) required" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 3; }

for entry in "${CHAINS[@]}"; do
  IFS='|' read -r label settlement rpc_default chain_dir <<< "$entry"
  [[ "$WANT" != "all" && "$WANT" != "$label" ]] && continue

  # OPHIS_RPC (generic) is honoured ONLY when a single chain was requested. In
  # all-chain mode a shell that already exports it for one network would otherwise
  # send all three checks to that one endpoint, and two healthy deployments would be
  # reported as failed. Per-chain OPHIS_RPC_<CHAIN> always wins.
  rpc_var="OPHIS_RPC_$(tr '[:lower:]' '[:upper:]' <<<"$label")"
  if [[ -n "${!rpc_var:-}" ]]; then
    rpc="${!rpc_var}"
  elif [[ "$WANT" != "all" && -n "${OPHIS_RPC:-}" ]]; then
    rpc="$OPHIS_RPC"
  else
    rpc="$rpc_default"
  fi

  # The destination the sweep will ACTUALLY use. robinhood's sweep-to-safe.sh takes
  # OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD and only checks that it has code, so a typo
  # naming any other deployed contract passes there. Validating only the hardcoded
  # Safe here would then certify a sweep to an unrecoverable destination.
  dest="$FEE_SAFE"
  dest_var="OPHIS_FEE_RECIPIENT_SAFE_$(tr '[:lower:]' '[:upper:]' <<<"$label")"
  # Exported variable first, then the chain's .env - the same two sources, in the
  # same order, that the sweep script itself resolves from. Checking only the
  # exported one would silently validate the canonical Safe while a non-canonical
  # destination sat in .env waiting to receive the funds.
  configured="$(resolve_cfg "$dest_var" "$chain_dir")"
  # ONLY unichain. Its wrapper never sets SAFE, so forge reads whatever is ambient
  # in the operator's shell. robinhood overwrites SAFE from its own resolved value
  # and the optimism v2 path does not shell out to forge at all, so flagging an
  # ambient SAFE there would fail a healthy deployment for a variable nothing reads.
  if [[ "$label" == "unichain" && -z "$configured" && -n "${SAFE:-}" ]]; then
    configured="$SAFE"; dest_var="SAFE (ambient, consumed by the forge script)"
  fi
  if [[ -n "$configured" ]]; then
    dest="$configured"
  fi

  # Settlement can be redirected too: robinhood reads OPHIS_SETTLEMENT_ROBINHOOD
  # (env or .env), unichain honours a bare exported SETTLEMENT. Checking the pinned
  # address while the sweep acts on another contract verifies the wrong deployment.
  case "$label" in
    robinhood) cfg_settlement="$(resolve_cfg OPHIS_SETTLEMENT_ROBINHOOD "$chain_dir")" ;;
    unichain)  cfg_settlement="${SETTLEMENT:-}" ;;
    *)         cfg_settlement="" ;;
  esac
  if [[ -n "$cfg_settlement" && "$(tr '[:upper:]' '[:lower:]' <<<"$cfg_settlement")" != "$(tr '[:upper:]' '[:lower:]' <<<"$settlement")" ]]; then
    bad "configured Settlement for $label is $cfg_settlement, not the canonical $settlement - the sweep would act on that contract"
    settlement="$cfg_settlement"
  fi

  echo
  echo "=== $label ($settlement) via $rpc"
  if [[ "$(tr '[:upper:]' '[:lower:]' <<<"$dest")" != "$(tr '[:upper:]' '[:lower:]' <<<"$FEE_SAFE")" ]]; then
    bad "$dest_var points at $dest, NOT the canonical fee Safe $FEE_SAFE - the sweep would send there"
  fi

  # --- reachability. Everything below is meaningless without it, so a dead RPC
  #     marks the chain UNKNOWN rather than letting later checks read as PASS.
  if ! chainid=$(cast chain-id --rpc-url "$rpc" 2>/dev/null); then
    unknown "$label: RPC unreachable - every check on this chain is UNVERIFIED"
    continue
  fi
  case "$label" in
    optimism)  want_chainid=10 ;;
    unichain)  want_chainid=130 ;;
    robinhood) want_chainid=4663 ;;
    *)         want_chainid="" ;;
  esac
  if [[ -n "$want_chainid" && "$chainid" != "$want_chainid" ]]; then
    bad "RPC for $label reports chain id $chainid, expected $want_chainid - this endpoint is the WRONG CHAIN"
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
  if code=$(cast code "$dest" --rpc-url "$rpc" 2>/dev/null); then
    if [[ -n "$code" && "$code" != "0x" ]]; then
      ok "fee Safe has code (sweep destination is live)"
      if ver=$(cast call "$dest" "VERSION()(string)" --rpc-url "$rpc" 2>/dev/null); then
        ok "fee Safe VERSION $ver"
      else
        unknown "fee Safe VERSION unreadable - is this actually a Safe?"
      fi
      if thr=$(cast call "$dest" "getThreshold()(uint256)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}'); then
        if [[ "$thr" == "2" ]]; then ok "fee Safe threshold 2"
        else bad "fee Safe threshold is $thr, expected 2"; fi
      else
        unknown "fee Safe threshold unreadable"
      fi
      if owners=$(cast call "$dest" "getOwners()(address[])" --rpc-url "$rpc" 2>/dev/null); then
        got="$(printf '%s' "$owners" | norm_owners)"
        if [[ "$got" == "$EXPECTED_PARTNER_OWNERS_SORTED" ]]; then
          ok "fee Safe owners match the expected 2-of-3 set"
        else
          bad "fee Safe owners DIFFER from expected. got: [$got] expected: [$EXPECTED_PARTNER_OWNERS_SORTED]"
        fi
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
  # WHICH identity must be the solver differs by sweep path. On the OP v2 path the
  # allowlisted solver is the FeeLiquidator CONTRACT and BROADCASTER is merely the
  # ops EOA authorised to call it; on the v1 chains the broadcaster EOA signs
  # settle() itself. Checking the EOA on OP would report FAIL for a correctly
  # configured deployment and block the very ceremony this preflight exists to clear.
  # The v1 chains do NOT share a submitter - each settlement-anomaly-watch.sh pins
  # its own sole authorized EOA - so a single BROADCASTER cannot be correct for both
  # and the all-chain run would report a healthy deployment as FAILED on one of them.
  # Default to each chain's pinned submitter; BROADCASTER (or the per-chain override)
  # still wins when an operator is deliberately checking a different key.
  if [[ "$label" == "optimism" ]]; then
    solver_subject="${FEE_LIQUIDATOR:-}"
    solver_what="FeeLiquidator contract"
    solver_hint="export FEE_LIQUIDATOR=0x... (the v2 path allowlists the CONTRACT, not the ops EOA)"
  else
    case "$label" in
      unichain)  default_submitter="0x7A956C269a12f1B897367663b536EB5dd29f3fBb" ;;
      robinhood) default_submitter="0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665" ;;
      *)         default_submitter="" ;;
    esac
    # Each runner has its OWN override, and a configured replacement key can be
    # non-allowlisted while the pinned default passes - so resolve the same way.
    case "$label" in
      unichain)  runner_submitter="${OPHIS_SUBMITTER_EOA:-}" ;;
      robinhood) runner_submitter="$(resolve_cfg ROBINHOOD_SUBMITTER_ADDR "$chain_dir")" ;;
      *)         runner_submitter="" ;;
    esac
    override_var="BROADCASTER_$(tr '[:lower:]' '[:upper:]' <<<"$label")"
    solver_subject="${!override_var:-${BROADCASTER:-${runner_submitter:-$default_submitter}}}"
    solver_what="submitter EOA"
    solver_hint="export ${override_var}=0x... (each v1 chain pins its own sole submitter)"
  fi
  if [[ -n "$solver_subject" ]]; then
    if auth=$(cast call "$settlement" "authenticator()(address)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}') \
       && is_solver=$(cast call "$auth" "isSolver(address)(bool)" "$solver_subject" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}'); then
      if [[ "$is_solver" == "true" ]]; then ok "$solver_what $solver_subject is an allowlisted solver"
      else bad "$solver_what $solver_subject is NOT a solver - settle() would revert after broadcast"; fi
      # Solver membership alone is not enough on the OP v2 path: the sweep is sent by
      # the ops EOA the contract names, and liquidator() can be paused to zero or
      # rotated. sweep-to-safe.sh treats that as its own precondition (it aborts on
      # address(0)), so a preflight that skipped it would green-light a sweep that
      # cannot be sent.
      if [[ "$label" == "optimism" ]]; then
        if liq_eoa=$(cast call "$solver_subject" "liquidator()(address)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}'); then
          if [[ "$liq_eoa" == "0x0000000000000000000000000000000000000000" ]]; then
            bad "FeeLiquidator liquidator() is address(0) - the ops-key path is PAUSED"
          elif [[ -z "${BROADCASTER:-}" ]]; then
            # Non-zero is not the same as correct. Without an expected address this
            # cannot tell a live ops key from one rotated away, so it must not PASS.
            unknown "FeeLiquidator ops key is $liq_eoa but no BROADCASTER was given to compare against"
          elif [[ "$(tr '[:upper:]' '[:lower:]' <<<"$liq_eoa")" != "$(tr '[:upper:]' '[:lower:]' <<<"$BROADCASTER")" ]]; then
            bad "FeeLiquidator liquidator() is $liq_eoa, not the intended broadcaster $BROADCASTER"
          else
            ok "FeeLiquidator ops key is $liq_eoa"
          fi
        else
          unknown "FeeLiquidator liquidator() unreadable"
        fi
        # The immutables decide WHICH contract is swept and WHERE the funds go. The
        # production runner treats both as mandatory, so a preflight that skipped
        # them would green-light a run it must then abort.
        if liq_settlement=$(cast call "$solver_subject" "settlement()(address)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}'); then
          if [[ "$(tr '[:upper:]' '[:lower:]' <<<"$liq_settlement")" == "$(tr '[:upper:]' '[:lower:]' <<<"$settlement")" ]]; then
            ok "FeeLiquidator settlement() pins $settlement"
          else
            bad "FeeLiquidator settlement() is $liq_settlement, expected $settlement"
          fi
        else
          unknown "FeeLiquidator settlement() unreadable"
        fi
        if liq_safe=$(cast call "$solver_subject" "feeSafe()(address)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}'); then
          if [[ "$(tr '[:upper:]' '[:lower:]' <<<"$liq_safe")" == "$(tr '[:upper:]' '[:lower:]' <<<"$FEE_SAFE")" ]]; then
            ok "FeeLiquidator feeSafe() pins the canonical fee Safe"
          else
            bad "FeeLiquidator feeSafe() is $liq_safe, expected $FEE_SAFE"
          fi
        else
          unknown "FeeLiquidator feeSafe() unreadable"
        fi
      fi
    else
      unknown "solver status unreadable for $solver_subject"
    fi
  else
    unknown "solver allowlist NOT checked on $label - $solver_hint"
  fi

  # Robinhood's broadcast path uses a SEPARATE nonce endpoint for its idle-driver
  # guard and requires it to report 4663. An unreachable or wrong-chain nonce RPC
  # aborts the sweep immediately, so a preflight that ignored it would green-light a
  # ceremony that cannot run.
  if [[ "$label" == "robinhood" && -n "${OPHIS_NONCE_RPC:-}" ]]; then
    if nonce_chain=$(cast chain-id --rpc-url "$OPHIS_NONCE_RPC" 2>/dev/null); then
      if [[ "$nonce_chain" == "4663" ]]; then ok "nonce RPC reachable and on chain 4663"
      else bad "OPHIS_NONCE_RPC reports chain id $nonce_chain, expected 4663"; fi
    else
      bad "OPHIS_NONCE_RPC is unreachable - the sweep's idle-driver guard would abort"
    fi
  fi

  # --- is there anything worth sweeping. Advisory, so it never FAILs: an empty
  #     buffer is a fine state, just not one worth a ceremony.
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  probe="$repo_root/infra/$chain_dir/scripts/check-settlement-buffer.sh"
  if [[ -x "$probe" ]]; then
    if out=$(OPHIS_RPC="$rpc" "$probe" 2>/dev/null); then
      echo "  ----     buffer: $(jq -c '[.balances[] | {(.symbol): .hr}]' <<<"$out" 2>/dev/null || echo "unparseable")"
      # The probes deliberately exit 0 on a per-token cast failure, recording it in
      # probe_failures and setting that row to status "error" with a displayed
      # balance of 0. Trusting the exit code alone would print "0" for a token we
      # never actually read and still exit 0 - a preflight certifying a balance it
      # did not measure.
      pf="$(jq -r '.probe_failures // "null"' <<<"$out" 2>/dev/null)"
      bad_rows="$(jq -r '[.balances[]? | select(.status != "ok") | .symbol] | join(",")' <<<"$out" 2>/dev/null)"
      rows="$(jq -r '.balances | length' <<<"$out" 2>/dev/null || echo 0)"
      if [[ "$pf" == "null" ]]; then
        unknown "buffer report missing probe_failures - buffer UNVERIFIED"
      elif [[ "$rows" == "0" ]]; then
        # Same rule the watcher enforces: a report with no rows measured nothing.
        # Reachable today when a probe emits its skipped report for an unset
        # SETTLEMENT, which would otherwise exit 0 having verified no balance at all.
        unknown "buffer report contains ZERO balance rows - nothing was measured"
      elif [[ "$pf" != "0" ]]; then
        unknown "buffer probe reported $pf token failure(s) - those balances are UNKNOWN, not zero"
      elif [[ -n "$bad_rows" ]]; then
        unknown "buffer rows not ok: $bad_rows - those balances are UNKNOWN, not zero"
      else
        # Same completeness rule the watcher enforces: a non-empty report is not a
        # complete one, and a preflight that exits 0 on a partial read has certified
        # balances it never saw.
        case "$label" in
          optimism)  want_syms="USDC WETH USDCe DAI WBTC USDT ETH" ;;
          unichain)  want_syms="WETH USDC" ;;
          robinhood) want_syms="WETH USDG" ;;
          *)         want_syms="" ;;
        esac
        got_syms="$(jq -r '.balances[].symbol' <<<"$out" 2>/dev/null | sort -u)"
        miss=""
        for w in $want_syms; do grep -qx -- "$w" <<<"$got_syms" || miss="$miss $w"; done
        if [[ -n "$miss" ]]; then
          unknown "buffer report is missing expected symbol(s):$miss - those balances were never measured"
        else
          # status ok is a claim; a numeric raw is the evidence. The watcher checks
          # this, and a preflight that skipped it would verify a buffer it never read.
          nonnum="$(jq -r '[.balances[] | select((.raw // "") | test("^[0-9]+$") | not) | .symbol] | join(",")' <<<"$out" 2>/dev/null)"
          [[ -n "$nonnum" ]] && unknown "buffer rows with a non-numeric balance: $nonnum - UNKNOWN, not zero"
        fi
      fi
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
