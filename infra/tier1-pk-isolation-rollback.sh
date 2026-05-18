#!/usr/bin/env bash
# Tier 1 PK Isolation — rollback script.
#
# Removes the ophis-driver user, the system keychain, and the unlock-password
# file. Restores the pre-Tier-1 state (PK stays in scep's keychain throughout
# Tier 1 anyway, so no data is lost — this just cleans up the new artifacts).
#
# Run from user `scep`, NOT root.

set -euo pipefail

if [[ "$(id -un)" != "scep" ]]; then
  echo "ERROR: run as user 'scep'." >&2; exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: do NOT run as root." >&2; exit 1
fi

DRIVER_USER="ophis-driver"
DRIVER_HOME="/Users/$DRIVER_USER"
SYS_KEYCHAIN="/Library/Keychains/ophis-driver.keychain-db"
PASS_FILE="/etc/ophis-driver-keychain.pass"

read -p "About to delete user $DRIVER_USER, the system keychain $SYS_KEYCHAIN, and $PASS_FILE. Proceed? (y/N): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

echo "=== 1. Delete system keychain ==="
if [[ -f "$SYS_KEYCHAIN" ]]; then
  sudo security delete-keychain "$SYS_KEYCHAIN" || true
  sudo rm -f "$SYS_KEYCHAIN"
  echo "  ✓ Deleted $SYS_KEYCHAIN"
else
  echo "  Already absent."
fi

echo "=== 2. Delete unlock-password file ==="
sudo rm -f "$PASS_FILE"
echo "  ✓ Deleted $PASS_FILE"

echo "=== 3. Delete user $DRIVER_USER ==="
if dscl . -read /Users/$DRIVER_USER 2>/dev/null | grep -q "RecordName: $DRIVER_USER"; then
  sudo dscl . -delete /Users/$DRIVER_USER
  echo "  ✓ User record deleted"
fi

echo "=== 4. Remove home dir ==="
if [[ -d "$DRIVER_HOME" ]]; then
  sudo rm -rf "$DRIVER_HOME"
  echo "  ✓ $DRIVER_HOME removed"
fi

echo ""
echo "Rollback complete. PK in scep's keychain (entry 'ophis-driver-submitter-2026-05-14') is untouched."
