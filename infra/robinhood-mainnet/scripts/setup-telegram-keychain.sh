#!/usr/bin/env bash
# Helper: write the Telegram bot token into macOS Keychain.
#
# Phase 1.5 (2026-05-20). Replaces putting the token in .env cleartext.
# render-configs.sh resolves the token from Keychain when not set in env.
#
# Usage — three input modes (try them in this order):
#
#   1. Auto-resolve from ~/.kimi/kimi-claw/openclaw.json:
#        ./scripts/setup-telegram-keychain.sh --from-openclaw
#
#   2. Pipe (for automated setup; token sourced earlier in the shell):
#        echo "$TOKEN" | ./scripts/setup-telegram-keychain.sh
#
#   3. Interactive paste (TTY only; no shell history):
#        ./scripts/setup-telegram-keychain.sh
#
# The script auto-detects which mode is in use based on whether stdin
# is a terminal (`-t 0`).

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
  if [[ -t 0 ]]; then
    read -p "Overwrite? [y/N] " yn
    if [[ ! "$yn" =~ ^[Yy] ]]; then
      echo "Aborted. No change."
      exit 0
    fi
  else
    echo "Non-interactive mode (stdin is a pipe) — overwriting."
  fi
fi

# Resolve token from one of 3 sources.
TOKEN=""

# Mode 1: --from-openclaw → read from the openclaw config
if [[ "${1:-}" == "--from-openclaw" ]]; then
  OPENCLAW_PATH="${HOME}/.kimi/kimi-claw/openclaw.json"
  if [[ ! -f "$OPENCLAW_PATH" ]]; then
    # Fall back to original openclaw location if the user-renamed path
    # doesn't exist (some installs use the un-prefixed location).
    OPENCLAW_PATH="${HOME}/.openclaw/openclaw.json"
  fi
  if [[ ! -f "$OPENCLAW_PATH" ]]; then
    echo "ERROR: openclaw config not found at ~/.kimi/kimi-claw/ or ~/.openclaw/" >&2
    exit 3
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq required for --from-openclaw. Install: brew install jq" >&2
    exit 3
  fi
  TOKEN=$(jq -r '.channels.telegram.botToken // empty' "$OPENCLAW_PATH")
  if [[ -z "$TOKEN" ]]; then
    echo "ERROR: .channels.telegram.botToken missing in $OPENCLAW_PATH" >&2
    exit 3
  fi
  echo "Token sourced from $OPENCLAW_PATH (not echoed)."

# Mode 2: piped stdin
elif [[ ! -t 0 ]]; then
  IFS= read -r TOKEN
  echo "Token read from stdin (not echoed)."

# Mode 3: interactive paste — only works on a real TTY
else
  echo "Paste the Telegram bot token (format: {int}:{base64-ish}, will not echo):"
  stty -echo
  IFS= read -r TOKEN
  stty echo
  echo ""
fi

# Trim whitespace.
TOKEN=$(echo "$TOKEN" | tr -d '[:space:]')

# Validate shape before writing.
if [[ ! "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
  echo "ERROR: token doesn't match Telegram bot-token shape ({int}:{base64-ish-20+chars})" >&2
  exit 1
fi

# Write with -U (update-or-create) and -T /usr/bin/security so the
# security binary can read the entry noninteractively (render-configs.sh).
# NOTE: -T whitelists the BINARY, not a user — any UID running `security`
# passes this ACL. The filesystem ACL on the home dir (chmod 0700) is what
# actually restricts cross-user access. On hosts with multiple interactive
# users, filesystem ACL is the real defense, not the keychain -T ACL.
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
echo "  cd ~/greg/infra/robinhood-mainnet && ./compose-up.sh"
echo "and the observability profile will pick up the token from Keychain."
