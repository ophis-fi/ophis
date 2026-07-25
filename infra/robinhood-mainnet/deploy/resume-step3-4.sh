#!/usr/bin/env bash
# Ophis - Robinhood Chain (4663) ceremony RESUME: steps [3/4] and [4/4] only.
#
# Use when deploy-mainnet-all.sh completed [1/4] + [2/4] (contracts deployed and
# GATE-verified) but died before/during addSolver - e.g. the Ledger auto-locked
# during the GATE review pause.
#
# WHY NOT just re-run deploy-mainnet-all.sh:
#   [1/4] is idempotent (hardhat-deploy reuses deployments/robinhood-mainnet/*),
#   but [2/4] shells out to `cast send --create` with NO existence check, so it
#   would redeploy Balances/Signatures/HooksTrampoline at NEW addresses, burn gas
#   and orphan the three already GATE-verified. Never re-run the full script
#   after [2/4] has succeeded.
#
# ORDERING IS LOAD-BEARING: addSolver runs FIRST, while the Ledger is still
# manager. After setManager hands off, addSolver needs a 2-of-3 Safe tx.
# Then transferOwnership BEFORE setManager, so an interruption between them
# leaves the Safe with strictly MORE authority than the hot HW wallet.
#
# Every step is idempotent - re-run freely if the Ledger drops again.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
ENV_FILE="$REPO_ROOT/infra/robinhood-mainnet/.env"

[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found" >&2; exit 2; }
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

RPC="${ROBINHOOD_MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}"
DRIVER="${ROBINHOOD_SUBMITTER_ADDR:-}"
SAFE="${OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET:-}"

# Deployed + GATE-verified in the first session. Pinned here so a resume can
# never target a different deployment than the one that passed the gate.
AUTH=0x5c802B14d9E132717aE78D42B19a4c517876F2E7

lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

[[ "$DRIVER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "ERROR: ROBINHOOD_SUBMITTER_ADDR invalid" >&2; exit 3; }
[[ "$SAFE"   =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "ERROR: OPHIS_PROTOCOL_SAFE_ROBINHOOD_MAINNET invalid" >&2; exit 3; }

CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
[[ "$CHAIN_ID" == "4663" ]] || { echo "ERROR: RPC reports chainId $CHAIN_ID, expected 4663" >&2; exit 8; }

# Re-assert the FULL Safe identity, not just the threshold. This runs in a later
# session than the ceremony, so .env may have changed in between - which is
# precisely the case this is here to catch. A threshold-only check would accept
# any contract whose getThreshold() returns 2 (a wrong 2-of-3, a 2-of-2, or a
# non-Safe implementing that selector), and step [4/4] hands it ownership AND
# manager IRREVERSIBLY. Mirrors deploy-mainnet-all.sh exactly.
SAFE_CODE=$(cast code --rpc-url "$RPC" "$SAFE")
[[ "$SAFE_CODE" != "0x" && -n "$SAFE_CODE" ]] || { echo "ERROR: Safe $SAFE has no code on 4663" >&2; exit 3; }
[[ "$(cast call --rpc-url "$RPC" "$SAFE" "getThreshold()(uint256)")" == "2" ]] || { echo "ERROR: Safe threshold != 2" >&2; exit 3; }

SAFE_OWNERS=$(cast call --rpc-url "$RPC" "$SAFE" "getOwners()(address[])" 2>/dev/null | grep -oE "0x[0-9a-fA-F]{40}")
SAFE_OWNERS_N=$(echo "$SAFE_OWNERS" | grep -c "0x")
[[ "$SAFE_OWNERS_N" == "3" ]] || { echo "ERROR: Safe has $SAFE_OWNERS_N owners, expected 3 (2-of-3). Refusing." >&2; exit 3; }

# REQUIRED here (unlike the main ceremony, where it is recommended-but-optional):
# a resume has no human re-confirming the printed owner list, so the owner set
# must be machine-asserted.
[[ -n "${OPHIS_SAFE_EXPECTED_OWNERS:-}" ]] || {
  echo "ERROR: OPHIS_SAFE_EXPECTED_OWNERS must be set to resume." >&2
  echo "       The resume path has no interactive owner confirmation, so the" >&2
  echo "       owner set has to be asserted rather than eyeballed." >&2
  exit 3; }
EXP_N=$(echo "$OPHIS_SAFE_EXPECTED_OWNERS" | tr ',' ' ' | grep -oE "0x[0-9a-fA-F]{40}" | wc -l | tr -d ' ')
[[ "$EXP_N" == "3" ]] || { echo "ERROR: OPHIS_SAFE_EXPECTED_OWNERS must list exactly 3 addresses (got $EXP_N)" >&2; exit 3; }
for o in $(echo "$OPHIS_SAFE_EXPECTED_OWNERS" | tr ',' ' '); do
  echo "$SAFE_OWNERS" | tr '[:upper:]' '[:lower:]' | grep -q "$(lc "$o")" \
    || { echo "ERROR: expected owner $o is NOT in the Safe owner set - wrong Safe. Refusing." >&2; exit 3; }
done
echo "    Safe asserted: threshold=2, 3 owners, all expected owners present"

# Pin the submitter too. AUTH is pinned above so a resume cannot target a
# different deployment; leaving the submitter free would defeat that, since
# step [3/4] grants it solver authority on that pinned production authenticator.
# A typo (or the zero address) bricks settlement submission until a Safe tx
# repairs it; a substituted address becomes an authorised solver outright.
EXPECTED_DRIVER=0x7A956C269a12f1B897367663b536EB5dd29f3fBb
[[ "$(lc "$DRIVER")" == "$(lc "$EXPECTED_DRIVER")" ]] || {
  echo "ERROR: ROBINHOOD_SUBMITTER_ADDR ($DRIVER) is not the submitter this" >&2
  echo "       script resumes ($EXPECTED_DRIVER). If you genuinely intend a" >&2
  echo "       different solver, do it as an explicit 2-of-3 Safe transaction," >&2
  echo "       not via a resume script." >&2
  exit 3; }

# The Auth proxy must be the GATE-verified one, still pointing at the verified impl.
IMPL_SLOT=$(cast storage --rpc-url "$RPC" "$AUTH" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)
[[ "$(lc "0x${IMPL_SLOT: -40}")" == "$(lc 0x2Ddcc99cD0F2Ba3De0cc37B28ec89921814bBe35)" ]] \
  || { echo "ERROR: Auth proxy impl slot != GATE-verified AuthImpl" >&2; exit 10; }

OWNER=$(cast call --rpc-url "$RPC" "$AUTH" "owner()(address)")
MANAGER=$(cast call --rpc-url "$RPC" "$AUTH" "manager()(address)")
IS_SOLVER=$(cast call --rpc-url "$RPC" "$AUTH" "isSolver(address)(bool)" "$DRIVER")

echo "=== Resume state ==="
echo "    Auth proxy:  $AUTH"
echo "    owner():     $OWNER"
echo "    manager():   $MANAGER"
echo "    isSolver:    $IS_SOLVER  ($DRIVER)"
echo "    target Safe: $SAFE"
echo ""

# Fatal ordering check: if the manager already moved to the Safe but the solver
# was never added, the Ledger can no longer addSolver - it needs a 2-of-3 Safe tx.
if [[ "$IS_SOLVER" != "true" && "$(lc "$MANAGER")" == "$(lc "$SAFE")" ]]; then
  echo "ERROR: manager is already the Safe but the submitter is NOT allowlisted." >&2
  echo "       addSolver now requires a 2-of-3 Safe transaction:" >&2
  echo "         to:   $AUTH" >&2
  echo "         data: $(cast calldata 'addSolver(address)' "$DRIVER")" >&2
  exit 12
fi

send_checked() {  # $1=description; rest=cast send args (after --ledger)
  local desc="$1"; shift
  local out st
  out=$(cast send --rpc-url "$RPC" --ledger "$@" --json)
  st=$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  case "$st" in 0x1|1|true) echo "  $desc OK" ;; *) echo "ERROR: $desc tx did not succeed (status=$st)" >&2; exit 11 ;; esac
}

echo "=== [3/4] Allowlist driver-submitter $DRIVER (Ledger) ==="
if [[ "$IS_SOLVER" == "true" ]]; then
  echo "  already allowlisted - skipping"
else
  send_checked "addSolver" "$AUTH" "addSolver(address)" "$DRIVER"
  IS_SOLVER=$(cast call --rpc-url "$RPC" "$AUTH" "isSolver(address)(bool)" "$DRIVER")
  [[ "$IS_SOLVER" == "true" ]] || { echo "ERROR: isSolver still false after addSolver" >&2; exit 5; }
  echo "  isSolver(driver): true"
fi

echo ""
echo "=== [4/4] Transfer AuthList ownership + manager to Safe $SAFE (Ledger) ==="
if [[ "$(lc "$OWNER")" == "$(lc "$SAFE")" ]]; then
  echo "  owner already the Safe - skipping transferOwnership"
else
  send_checked "transferOwnership" "$AUTH" "transferOwnership(address)" "$SAFE"
fi

if [[ "$(lc "$MANAGER")" == "$(lc "$SAFE")" ]]; then
  echo "  manager already the Safe - skipping setManager"
else
  send_checked "setManager" "$AUTH" "setManager(address)" "$SAFE"
fi

NEW_OWNER=$(cast call --rpc-url "$RPC" "$AUTH" "owner()(address)")
NEW_MANAGER=$(cast call --rpc-url "$RPC" "$AUTH" "manager()(address)")
echo ""
echo "  Verified owner:   $NEW_OWNER"
echo "  Verified manager: $NEW_MANAGER"
[[ "$(lc "$NEW_OWNER")"   == "$(lc "$SAFE")" ]] || { echo "ERROR: owner is $NEW_OWNER, expected $SAFE" >&2; exit 6; }
[[ "$(lc "$NEW_MANAGER")" == "$(lc "$SAFE")" ]] || { echo "ERROR: manager is $NEW_MANAGER, expected $SAFE" >&2; exit 7; }
echo "  OK Protocol authority fully handed to the 2-of-3 Safe"

# Persist the GATE-verified addresses (the main script does this at its end,
# which we never reached). Guarded so a re-run cannot duplicate the block.
if ! grep -q "OPHIS_SETTLEMENT_ROBINHOOD" "$ENV_FILE"; then
  echo ""
  echo "=== Writing addresses to .env ==="
  cat <<EOF >> "$ENV_FILE"

# Robinhood mainnet (chain 4663) sovereign deploy ($(date +%Y-%m-%d))
OPHIS_AUTH_ROBINHOOD=0x5c802B14d9E132717aE78D42B19a4c517876F2E7
OPHIS_AUTH_IMPLEMENTATION_ROBINHOOD=0x2Ddcc99cD0F2Ba3De0cc37B28ec89921814bBe35
OPHIS_SETTLEMENT_ROBINHOOD=0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD
OPHIS_VAULT_RELAYER_ROBINHOOD=0xB52C38097c19cd38238c62DD36027a7918eFa890
OPHIS_BALANCES_ROBINHOOD=0x5f315a204e7971fc29a66fef3a5773f6b0202fac
OPHIS_SIGNATURES_ROBINHOOD=0x2fbb1e41ff4f9b707e4428eec7f5afaac5d60810
OPHIS_HOOKS_TRAMPOLINE_ROBINHOOD=0x68593257dfd7f392abfbb410b212be0b6242ac0e
EOF
fi

echo ""
echo "=== Done. Fill these into configs/*.toml.tmpl: ==="
echo "  __FILL_AFTER_DEPLOY_SETTLEMENT__      -> 0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD"
echo "  __FILL_AFTER_DEPLOY_BALANCES__        -> 0x5f315a204e7971fc29a66fef3a5773f6b0202fac"
echo "  __FILL_AFTER_DEPLOY_SIGNATURES__      -> 0x2fbb1e41ff4f9b707e4428eec7f5afaac5d60810"
echo "  __FILL_AFTER_DEPLOY_HOOKS__           -> 0x68593257dfd7f392abfbb410b212be0b6242ac0e"
echo "  __FILL_AFTER_DEPLOY_SUBMITTER_EOA__   -> $DRIVER"
echo "  (AllowListAuthentication proxy for monitoring: $AUTH)"
