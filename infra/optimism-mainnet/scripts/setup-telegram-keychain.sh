#!/usr/bin/env bash
# Helper: write the Telegram bot token into macOS Keychain.
#
# Phase 1.5 (2026-05-20). Replaces putting the token in .env cleartext.
# render-configs.sh resolves the token from Keychain when not set in env.
#
# Usage:
#   ./scripts/setup-telegram-keychain.sh
#   (prompts for the token; reads stdin so the value doesn't appear on
#    the command line or in shell history)

set -euo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: the token would leak in the trace." >&2
  exit 2
fi

SERVICE="ophis-telegram-bot"
ACCOUNT="$USER"

# Check if already set.
if security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w >/dev/null 2>&1; then
  echo "Existing Keychain entry found (service=$SERVICE, account=$ACCOUNT)."
  read -p "Overwrite? [y/N] " yn
  if [[ ! "$yn" =~ ^[Yy] ]]; then
    echo "Aborted. No change."
    exit 0
  fi
fi

# Read token from stdin (no command-line arg → no shell history).
# Suppress echo for paste safety.
echo "Paste the Telegram bot token (format: {int}:{base64-ish}, will not echo):"
stty -echo
IFS= read -r TOKEN
stty echo
echo ""

# Trim whitespace.
TOKEN=$(echo "$TOKEN" | tr -d '[:space:]')

# Validate shape before writing.
if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
  echo "ERROR: token doesn't match Telegram bot-token shape ({int}:{base64-ish-20+chars})" >&2
  exit 1
fi

# Write with -U (update-or-create), -T (which apps can read without
# prompt — we pass /usr/bin/security so render-configs.sh can read
# noninteractively).
security add-generic-password \
  -a "$ACCOUNT" \
  -s "$SERVICE" \
  -w "$TOKEN" \
  -U \
  -T /usr/bin/security \
  "$HOME/Library/Keychains/login.keychain-db"

echo "OK. Token stored in Keychain (service=$SERVICE, account=$ACCOUNT)."
echo ""
echo "Verify with:"
echo "  security find-generic-password -a \$USER -s ophis-telegram-bot -w"
echo ""
echo "Now you can run:"
echo "  cd ~/greg/infra/optimism-mainnet && ./compose-up.sh"
echo "and the observability profile will pick up the token from Keychain."
