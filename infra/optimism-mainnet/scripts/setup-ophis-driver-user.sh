#!/usr/bin/env bash
# Idempotent setup of the `ophis-driver` system user.
#
# Phase 1 PK isolation (file-backed PK custody) requires a dedicated
# user that owns /<home>/ophis-driver/.config/submitter.key with mode
# 0600 + home dir 0700. render-configs.sh sudo-reads from that path
# at deploy time.
#
# G3 portability (2026-05-20 DR drill findings): branches on uname -s
# so the same script works on the Mac mini (macOS, dscl) and a Linux
# DR target (useradd).
#
# Idempotent: re-runs are no-ops if the user already exists with the
# correct home dir + permissions.

set -euo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x" >&2
  exit 2
fi

PLATFORM=$(uname -s)
USERNAME="ophis-driver"

case "$PLATFORM" in
  Darwin)
    HOMEDIR="/Users/${USERNAME}"
    SHELL_PATH="/usr/bin/false"   # no login shell — service account only
    ;;
  Linux)
    HOMEDIR="/home/${USERNAME}"
    SHELL_PATH="/usr/sbin/nologin"
    ;;
  *)
    echo "ERROR: unsupported platform $PLATFORM" >&2
    exit 1
    ;;
esac

# Step 1: ensure user exists
user_exists() {
  case "$PLATFORM" in
    Darwin) dscl . -read "/Users/${USERNAME}" >/dev/null 2>&1 ;;
    Linux)  id -u "$USERNAME" >/dev/null 2>&1 ;;
  esac
}

create_user() {
  case "$PLATFORM" in
    Darwin)
      # Find next available UID >= 500 (macOS reserves <500).
      local next_uid
      next_uid=$(dscl . -list /Users UniqueID 2>/dev/null | awk '{print $2}' | sort -n | awk 'BEGIN {p=499} $0 > p+1 {print p+1; exit} {p=$0} END {print p+1}')
      [[ "$next_uid" -lt 500 ]] && next_uid=500
      echo "  creating macOS user $USERNAME (uid=$next_uid)"
      sudo dscl . -create "/Users/${USERNAME}"
      sudo dscl . -create "/Users/${USERNAME}" UserShell "$SHELL_PATH"
      sudo dscl . -create "/Users/${USERNAME}" RealName "Ophis Driver Submitter"
      sudo dscl . -create "/Users/${USERNAME}" UniqueID "$next_uid"
      sudo dscl . -create "/Users/${USERNAME}" PrimaryGroupID 20  # macOS staff group
      sudo dscl . -create "/Users/${USERNAME}" NFSHomeDirectory "$HOMEDIR"
      ;;
    Linux)
      echo "  creating Linux user $USERNAME (system account)"
      sudo useradd \
        --system \
        --no-create-home \
        --home-dir "$HOMEDIR" \
        --shell "$SHELL_PATH" \
        --user-group \
        "$USERNAME"
      ;;
  esac
}

if user_exists; then
  echo "user $USERNAME exists ✓"
else
  create_user
fi

# Step 2: ensure home dir exists with strict perms
if [[ ! -d "$HOMEDIR" ]]; then
  echo "  creating home dir $HOMEDIR"
  sudo mkdir -p "$HOMEDIR"
fi
sudo chown -R "${USERNAME}:" "$HOMEDIR" 2>/dev/null || sudo chown -R "${USERNAME}" "$HOMEDIR"
sudo chmod 700 "$HOMEDIR"
echo "home dir $HOMEDIR ✓ (chmod 700, owner ${USERNAME})"

# Step 3: ensure .config subdir exists with strict perms
CONFIG_DIR="${HOMEDIR}/.config"
if [[ ! -d "$CONFIG_DIR" ]]; then
  sudo mkdir -p "$CONFIG_DIR"
fi
sudo chown "${USERNAME}:" "$CONFIG_DIR" 2>/dev/null || sudo chown "${USERNAME}" "$CONFIG_DIR"
sudo chmod 700 "$CONFIG_DIR"
echo "config dir $CONFIG_DIR ✓ (chmod 700)"

# Step 4: verify
echo ""
echo "Final state:"
sudo ls -ld "$HOMEDIR" "$CONFIG_DIR" 2>&1 | head -2
echo ""
echo "Next: install the submitter PK file at:"
echo "  ${CONFIG_DIR}/submitter.key"
echo "via:"
echo "  echo '0x<64-hex-pk>' | sudo install -m 600 -o $USERNAME -g $(id -gn "$USERNAME" 2>/dev/null || echo staff) /dev/stdin ${CONFIG_DIR}/submitter.key"
echo ""
echo "Or restore from offsite USB per docs/operations/submitter-pk-backup-runbook.private.md"
