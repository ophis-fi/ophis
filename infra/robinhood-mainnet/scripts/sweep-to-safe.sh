#!/usr/bin/env bash
# Sweep accumulated CIP-75 partner-fee buffer from the Ophis OP Settlement
# contract to the partner-fee recipient Safe.
#
# Mechanism: `forge script SweepSettlementBuffer` constructs a `settle()`
# call with empty trades + post-interactions that transfer the Settlement
# contract's USDC/WETH/etc balance to the Safe. The driver-submitter EOA
# (allowlisted as solver via Safe vote 2026-05-20) signs and broadcasts.
#
# Background: docs/audits/2026-05-20-cip75-partner-fee-bypass.md option B1.
# On our OP fork at 0x310784c7…, CIP-75 fees accumulate in Settlement
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
#   # Override token list (comma-separated 0x addresses):
#   TOKENS=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85,0x4200000000000000000000000000000000000006 \
#     ./scripts/sweep-to-safe.sh
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

# Driver-submitter EOA (must match the PK at PK_PATH)
SUBMITTER_EOA="0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1"

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
  echo "    sweep Settlement 0x310784c7… → Safe 0x858f0F5e…CeF8"
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
