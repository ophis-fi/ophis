#!/usr/bin/env bash
# Sweep accumulated CIP-75 partner-fee buffer from the Ophis Robinhood (4663)
# Settlement contract to the partner-fee recipient Safe.
#
# Mechanism: `forge script SweepSettlementBuffer` constructs a `settle()`
# call with empty trades + post-interactions that transfer the Settlement
# contract's USDC/WETH/etc balance to the Safe. The driver-submitter EOA
# (allowlisted as solver via Safe vote 2026-05-20) signs and broadcasts.
#
# Background: docs/audits/2026-05-20-cip75-partner-fee-bypass.md option B1.
# On our sovereign forks, CIP-75 fees accumulate in Settlement
# rather than transferring atomically to the recipient. Without this sweep,
# the buffer is recycled into future-trader price improvement (CoW's
# default behavior on chains they operate), netting Ophis $0 revenue.
#
# Safety:
#   - Defaults to DRY-RUN (no --broadcast). `--broadcast` flag required for
#     live submission.
#   - PK read via subshell capture (never echo to stdout; see
#     feedback_never_dump_keychain_token_to_stdout).
#   - Threshold check: 0.001 WETH equivalent in Settlement (matches CoW's
#     partner-fee payout bar). Below threshold = skip.
#   - Telegram notification on success/failure if BOT_TOKEN_FILE is set.
#
# Usage:
#   # Dry-run (default — simulates only, no broadcast):
#   ./scripts/sweep-to-safe.sh
#
#   # Live broadcast:
#   ./scripts/sweep-to-safe.sh --broadcast
#
#   # Override threshold (default 1e15 = 0.001 ETH):
#   MIN_TOTAL_WEI=1e16 ./scripts/sweep-to-safe.sh --broadcast
#
#   # Override token list (comma-separated 0x addresses). MIN_BASE_UNITS must be
#   # supplied alongside it, aligned 1:1 (the forge script rejects TOKENS alone).
#   TOKENS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 MIN_BASE_UNITS=1e7 \
#     ./scripts/sweep-to-safe.sh
#
# REQUIRED in .env before any broadcast:
#   OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD - the destination Safe, which MUST be
#   deployed on 4663. There is no default: the OP fee Safe has no code here, and
#   an ERC-20 transfer to a codeless address succeeds without reverting.
#
#   # Override independent nonce-observation RPC (default: OPHIS_RPC):
#   OPHIS_NONCE_RPC=https://... ./scripts/sweep-to-safe.sh --broadcast

set -euo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: the driver-submitter PK would leak." >&2
  exit 2
fi

BROADCAST=0
for arg in "$@"; do
  case "$arg" in
    --broadcast) BROADCAST=1 ;;
    --help|-h)
      sed -n '2,40p' "$0"
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 3 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
RPC="${OPHIS_RPC:-http://localhost:4003/main/evm/4663}"
NONCE_RPC="${OPHIS_NONCE_RPC:-$RPC}"
PK_PATH="${OPHIS_SUBMITTER_KEY_PATH:-/Users/ophis-driver/.config/submitter.key}"

# Sanity checks
[[ "$RPC" =~ ^https?:// ]] || { echo "ERROR: \$OPHIS_RPC must be http(s):// URL" >&2; exit 3; }
[[ "$NONCE_RPC" =~ ^https?:// ]] || { echo "ERROR: \$OPHIS_NONCE_RPC must be http(s):// URL" >&2; exit 3; }
command -v forge >/dev/null 2>&1 || { echo "ERROR: forge (foundry) not in PATH" >&2; exit 3; }
[[ -d "$CONTRACTS_DIR" ]] || { echo "ERROR: contracts dir not found at $CONTRACTS_DIR" >&2; exit 3; }

# Driver-submitter EOA (must match the PK at PK_PATH) and the Settlement to
# sweep. BOTH are read from the stack .env, which the deploy ceremony writes,
# so they can never drift from what was actually deployed/allowlisted on 4663.
# These were previously hardcoded to the OP stack's submitter and Settlement -
# copied over with the scaffold and never re-pointed, which would have run every
# forge simulation as the wrong sender against the wrong contract.
ENV_FILE="$REPO_ROOT/infra/robinhood-mainnet/.env"
read_env() {  # $1=key -> value from .env ("" if absent); tr strips quotes/spaces
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\042\047 ' || true
}
SUBMITTER_EOA="${ROBINHOOD_SUBMITTER_ADDR:-$(read_env ROBINHOOD_SUBMITTER_ADDR)}"
SETTLEMENT_ADDR="${OPHIS_SETTLEMENT_ROBINHOOD:-$(read_env OPHIS_SETTLEMENT_ROBINHOOD)}"

[[ "$SUBMITTER_EOA" =~ ^0x[0-9a-fA-F]{40}$ ]] || {
  echo "ERROR: ROBINHOOD_SUBMITTER_ADDR is not a 20-byte address." >&2
  echo "       Set it in $ENV_FILE (written by deploy/deploy-mainnet-all.sh)." >&2
  exit 3; }
[[ "$SETTLEMENT_ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]] || {
  echo "ERROR: OPHIS_SETTLEMENT_ROBINHOOD is not a 20-byte address." >&2
  echo "       Set it in $ENV_FILE (written by the deploy ceremony)." >&2
  exit 3; }

# ── Chain-specific sweep parameters ───────────────────────────────────────
# SweepSettlementBuffer.paramsFromEnv() reads SETTLEMENT / SAFE / TOKENS /
# MIN_BASE_UNITS from the ENVIRONMENT and silently falls back to OP-mainnet
# constants (Settlement 0x310784c7…, USDC 0x0b2C…, WETH 0x4200…0006) for any it
# does not find. NONE of those addresses have code on 4663, so an unparameterised
# run here sweeps the wrong contract for the wrong tokens. Every value below is
# therefore exported explicitly and asserted on-chain before any broadcast.
#
# Robinhood token set (NOT the OP set): USDG is the canonical 6-decimal stable
# (there is no official USDC on 4663), and WETH is chain-specific - the OP
# 0x4200..0006 predeploy does not exist on an Orbit chain.
SWEEP_TOKENS="${TOKENS:-0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73}"
# Aligned 1:1 with SWEEP_TOKENS. Matches the OP threshold convention:
# 1e7 for a 6-decimal stable (10 USDG) and 3e15 for 18-decimal WETH (0.003).
# The forge script REQUIRES this whenever TOKENS is overridden (Codex re-audit
# MED, PR #223) so a 6-decimal token can never inherit the 1e15 unknown default.
SWEEP_MIN_BASE_UNITS="${MIN_BASE_UNITS:-1e7,3e15}"

# Destination Safe. Still NO default, and the no-default rule stays even though
# the original reason for it has since been resolved.
#
# History: this defaulted to nothing because the fee Safe 0x858f0F5e…CeF8 had NO
# CODE on 4663, and an ERC-20 transfer to a codeless address SUCCEEDS silently —
# defaulting would have moved real revenue to an address nobody controlled, with
# no revert and no recovery. As of the 2026-08-27 audit that Safe IS deployed on
# 4663 (VERSION 1.4.1, threshold 2, the expected 3 owners; re-verify with
# `cast call <safe> "getOwners()(address[])"` before any sweep).
#
# The requirement to pin it explicitly is kept anyway. A silent-success failure
# mode with no recovery path does not get a convenience default just because the
# address happens to be populated today, and an operator who has to name the
# destination is an operator who has looked at it.
SWEEP_SAFE="${OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD:-$(read_env OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD)}"
[[ "$SWEEP_SAFE" =~ ^0x[0-9a-fA-F]{40}$ ]] || {
  echo "ERROR: OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD is not set." >&2
  echo "       There is deliberately NO default: the OP fee-recipient Safe has no" >&2
  echo "       code on 4663, and sweeping to a codeless address destroys the funds." >&2
  echo "       Deploy the recipient Safe on 4663, then set it in $ENV_FILE." >&2
  exit 3; }

# Assert every address the sweep touches actually has code on THIS chain.
# Catches a stale/copied address before it can burn a broadcast.
assert_has_code() {  # $1=addr $2=label
  local code
  code=$(cast code --rpc-url "$RPC" "$1" 2>/dev/null || echo 0x)
  [[ "$code" != "0x" && -n "$code" ]] || {
    echo "ERROR: $2 ($1) has NO CODE on this chain - refusing to sweep." >&2
    exit 4; }
}
assert_has_code "$SETTLEMENT_ADDR" "Settlement"
assert_has_code "$SWEEP_SAFE" "fee-recipient Safe"
IFS=',' read -r -a _sweep_toks <<< "$SWEEP_TOKENS"
for _t in "${_sweep_toks[@]}"; do assert_has_code "$_t" "sweep token"; done

export SETTLEMENT="$SETTLEMENT_ADDR"
export SAFE="$SWEEP_SAFE"
export TOKENS="$SWEEP_TOKENS"
export MIN_BASE_UNITS="$SWEEP_MIN_BASE_UNITS"

cd "$CONTRACTS_DIR"

# Compose forge args. FOUNDRY_DENY=never sidesteps the pre-existing
# deny_warnings=true that forge-std deprecations would otherwise fail.
COMMON_ARGS=(
  --rpc-url "$RPC"
  --sender "$SUBMITTER_EOA"
  -vv
)

if [[ "$BROADCAST" -eq 1 ]]; then
  echo "==> LIVE BROADCAST mode"
  echo "    sweep Settlement $SETTLEMENT_ADDR → Safe $SWEEP_SAFE"
  echo "    tokens:     $SWEEP_TOKENS"
  echo "    thresholds: $SWEEP_MIN_BASE_UNITS"
  echo "    using driver-submitter EOA $SUBMITTER_EOA"
  echo ""

  # Audit HIGH-3 (sharp-edges + codex 2026-05-20): nonce-contention guard.
  # Driver-submitter EOA is shared with the live CoW driver. Without a
  # separate sweeper EOA (filed as #119-followup), we have to confirm the
  # driver is idle before broadcasting. Observe nonce over a 30s window;
  # abort if it changed (driver was active).
  command -v cast >/dev/null 2>&1 || { echo "ERROR: cast required for nonce guard" >&2; exit 6; }
  CHAIN_ID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)
  [[ "$CHAIN_ID" == "4663" ]] || { echo "ERROR: OPHIS_RPC chain-id must be 4663 (got ${CHAIN_ID:-unreadable})" >&2; exit 6; }
  # The nonce guard reads through NONCE_RPC, so it must ALSO be chain 4663: a
  # stable nonce for this EOA on the WRONG chain would otherwise pass the idle
  # guard while the live driver is actively submitting on 4663.
  NONCE_CHAIN_ID=$(cast chain-id --rpc-url "$NONCE_RPC" 2>/dev/null || true)
  [[ "$NONCE_CHAIN_ID" == "4663" ]] || { echo "ERROR: OPHIS_NONCE_RPC chain-id must be 4663 (got ${NONCE_CHAIN_ID:-unreadable})" >&2; exit 6; }
  NONCE_BEFORE=$(cast nonce "$SUBMITTER_EOA" --rpc-url "$NONCE_RPC" 2>/dev/null)
  [[ -z "$NONCE_BEFORE" ]] && { echo "ERROR: failed to read nonce" >&2; exit 6; }
  echo "    nonce before: $NONCE_BEFORE"
  echo "    observing 30s for driver idle..."
  sleep 30
  NONCE_AFTER=$(cast nonce "$SUBMITTER_EOA" --rpc-url "$NONCE_RPC" 2>/dev/null)
  if [[ "$NONCE_BEFORE" != "$NONCE_AFTER" ]]; then
    echo "ABORT: driver was active during observation window (nonce $NONCE_BEFORE → $NONCE_AFTER)." >&2
    echo "       Retry during quieter period or deploy a separate sweeper EOA." >&2
    exit 7
  fi
  echo "    driver idle ✓ (nonce stable at $NONCE_BEFORE)"
  echo "    Press Ctrl-C in next 5s to abort the sweep..."
  sleep 5

  # Audit HIGH-2 (sharp-edges 2026-05-20): trap cleanup BEFORE PK load
  # so any path that exits the shell (Ctrl-C, segfault, parent kill) unsets
  # both PK and PRIVATE_KEY. Moves PK load AFTER the confirmation sleep.
  trap 'unset PK PRIVATE_KEY' EXIT INT TERM

  # Load PK via subshell into env. NEVER prints the value (only length+hex shape).
  if [[ ! -r "$PK_PATH" ]]; then
    PK=$(sudo -n cat "$PK_PATH" 2>/dev/null || true)
    [[ -z "$PK" ]] && { echo "ERROR: cannot read PK at $PK_PATH (need sudo?)" >&2; exit 4; }
  else
    PK=$(cat "$PK_PATH")
  fi
  # Audit MED-1 (sharp-edges 2026-05-20): strip trailing newline; validate hex.
  PK="${PK%$'\n'}"
  [[ "$PK" =~ ^0x[0-9a-fA-F]{64}$ ]] || {
    echo "ERROR: PK doesn't match expected shape (0x + 64 hex)." >&2
    echo "       Check the file at $PK_PATH (no newlines, no leading/trailing whitespace)." >&2
    exit 5
  }
  echo "    PK loaded (length ${#PK}, hex-validated)"

  # Run with --broadcast. PRIVATE_KEY env is consumed by forge.
  # Verbosity capped at -vv (sharp-edges HIGH-2): -vvv+ can re-echo env in forge logs.
  FOUNDRY_DENY=never PRIVATE_KEY="$PK" forge script \
    script/SweepSettlementBuffer.s.sol:SweepSettlementBuffer \
    "${COMMON_ARGS[@]}" \
    --broadcast \
    --slow
else
  echo "==> DRY-RUN mode (use --broadcast for live)"
  FOUNDRY_DENY=never forge script \
    script/SweepSettlementBuffer.s.sol:SweepSettlementBuffer \
    "${COMMON_ARGS[@]}"
fi
