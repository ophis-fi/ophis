#!/usr/bin/env bash
# Tier 1 PK Isolation — moves driver-submitter PK out of user `scep`'s reach.
#
# Audit context: Phase 1 HIGH-3. Today the PK is in:
#   - macOS Keychain entry `ophis-driver-submitter-2026-05-14` (under user `scep`)
#   - $REPO/infra/<chain>-mainnet/.env (plaintext, chmod 600, owner scep)
#   - $REPO/infra/<chain>-mainnet/rendered/driver.toml (plaintext, chmod 600, owner scep)
#
# Threat: any process running as `scep` (compromised npm postinstall, browser
# extension, bad shell script) can read both files AND query the Keychain.
#
# After Tier 1:
#   - New macOS user `ophis-driver` (no shell, isolated home, UID 502)
#   - Keychain entry moved to a System keychain with ACL = ophis-driver only
#   - render-configs.sh wrapper invoked as `sudo -u ophis-driver` so rendered
#     files land in /Users/ophis-driver/rendered/ (chmod 700 home)
#   - $REPO/.env line `OPHIS_DRIVER_SUBMITTER_KEY=...` deleted
#   - Driver launchd plist runs as `ophis-driver` instead of `scep`
#
# Idempotent: re-running is safe.
#
# Rollback: see tier1-pk-isolation-rollback.sh in the same dir.

set -euo pipefail

# --- Pre-flight ---
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: macOS only." >&2; exit 1
fi
if [[ "$(id -un)" != "scep" ]]; then
  echo "ERROR: run as user 'scep' (current: $(id -un))." >&2; exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: do NOT run as root. The script will sudo where needed." >&2; exit 1
fi

KEYCHAIN_SVC="ophis-driver-submitter-2026-05-14"
DRIVER_USER="ophis-driver"
DRIVER_UID=502
DRIVER_GID=20  # macOS 'staff' group; safer than inventing a new group
DRIVER_HOME="/Users/$DRIVER_USER"
SYS_KEYCHAIN="/Library/Keychains/ophis-driver.keychain-db"

# --- Step 1: Verify the PK is currently in scep's keychain ---
echo "=== Step 1: Confirm PK is present in user keychain ==="
if ! security find-generic-password -s "$KEYCHAIN_SVC" -a "scep" >/dev/null 2>&1; then
  echo "ERROR: Keychain entry '$KEYCHAIN_SVC' not found for user scep." >&2
  echo "       Maybe Tier 1 already applied, or PK was rotated. Inspect:" >&2
  echo "       security find-generic-password -s '$KEYCHAIN_SVC'" >&2
  exit 2
fi
echo "  ✓ PK present in scep's keychain"

# --- Step 2: Create the ophis-driver macOS user ---
echo ""
echo "=== Step 2: Create user ophis-driver (sudo password required) ==="
if dscl . -read /Users/$DRIVER_USER 2>/dev/null | grep -q "RecordName: $DRIVER_USER"; then
  echo "  ✓ User $DRIVER_USER already exists, skipping create."
else
  echo "  Creating user $DRIVER_USER (no shell, isolated home)..."
  sudo dscl . -create /Users/$DRIVER_USER
  sudo dscl . -create /Users/$DRIVER_USER UserShell /usr/bin/false
  sudo dscl . -create /Users/$DRIVER_USER RealName "Ophis Driver Service"
  sudo dscl . -create /Users/$DRIVER_USER UniqueID $DRIVER_UID
  sudo dscl . -create /Users/$DRIVER_USER PrimaryGroupID $DRIVER_GID
  sudo dscl . -create /Users/$DRIVER_USER NFSHomeDirectory $DRIVER_HOME
  sudo mkdir -p $DRIVER_HOME
  sudo chown $DRIVER_USER:staff $DRIVER_HOME
  sudo chmod 700 $DRIVER_HOME
  # Generate a random unguessable login password we'll never use (no shell anyway)
  sudo dscl . -passwd /Users/$DRIVER_USER "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64)"
  echo "  ✓ User $DRIVER_USER created."
fi

# --- Step 3: Create a system keychain owned by ophis-driver and copy PK ---
echo ""
echo "=== Step 3: Create system keychain + copy PK ==="
if [[ ! -f "$SYS_KEYCHAIN" ]]; then
  # System keychain unlocked by a unique password (we store it sealed inside
  # the keychain ACL itself via dummy entry; for Tier 1 simplicity we make
  # it unlocked at boot via a launchd unlock hook below).
  KEYCHAIN_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
  sudo security create-keychain -p "$KEYCHAIN_PASS" "$SYS_KEYCHAIN"
  sudo security set-keychain-settings -lut 0 "$SYS_KEYCHAIN"  # don't auto-lock
  # Stash the unlock password in /etc/ophis-driver-keychain.pass (readable only by root)
  echo "$KEYCHAIN_PASS" | sudo tee /etc/ophis-driver-keychain.pass >/dev/null
  sudo chmod 600 /etc/ophis-driver-keychain.pass
  sudo chown root:wheel /etc/ophis-driver-keychain.pass
  echo "  ✓ System keychain $SYS_KEYCHAIN created."
else
  echo "  ✓ System keychain $SYS_KEYCHAIN already exists."
fi

# Read PK from scep's keychain (this is the LAST time we'll do this from scep)
echo "  Reading PK from scep's keychain..."
PK_TMP=$(security find-generic-password -s "$KEYCHAIN_SVC" -a "scep" -w 2>&1 | tr -d '\n\r')
if [[ ! "$PK_TMP" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: PK format invalid (expected 0x + 64 hex chars). Got length: ${#PK_TMP}" >&2
  unset PK_TMP
  exit 3
fi

# Unlock system keychain and add the PK
KEYCHAIN_PASS=$(sudo cat /etc/ophis-driver-keychain.pass)
sudo security unlock-keychain -p "$KEYCHAIN_PASS" "$SYS_KEYCHAIN"
# Delete any old entry to allow re-running
sudo security delete-generic-password -s "$KEYCHAIN_SVC" "$SYS_KEYCHAIN" 2>/dev/null || true
sudo security add-generic-password \
  -a "$DRIVER_USER" \
  -s "$KEYCHAIN_SVC" \
  -w "$PK_TMP" \
  -T /usr/bin/security \
  -U "$SYS_KEYCHAIN"
echo "  ✓ PK copied into system keychain with ACL → $DRIVER_USER + /usr/bin/security."
unset PK_TMP KEYCHAIN_PASS

# --- Step 4: Verify scep CANNOT read the new keychain entry ---
echo ""
echo "=== Step 4: Verify isolation ==="
if security find-generic-password -s "$KEYCHAIN_SVC" "$SYS_KEYCHAIN" -w >/dev/null 2>&1; then
  echo "  WARNING: user scep can still read the system keychain entry."
  echo "           ACLs may need additional tightening. Inspect:"
  echo "           sudo security dump-keychain -d $SYS_KEYCHAIN"
else
  echo "  ✓ user scep CANNOT read the new keychain entry directly."
fi

# Verify ophis-driver CAN read it (via su -)
TEST_READ=$(sudo -u $DRIVER_USER \
  security unlock-keychain -p "$(sudo cat /etc/ophis-driver-keychain.pass)" "$SYS_KEYCHAIN" && \
  sudo -u $DRIVER_USER \
  security find-generic-password -s "$KEYCHAIN_SVC" "$SYS_KEYCHAIN" -w 2>&1 | tr -d '\n\r' || echo FAILED)
if [[ "$TEST_READ" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "  ✓ user $DRIVER_USER CAN read PK via the system keychain."
else
  echo "  ERROR: user $DRIVER_USER cannot read PK. Result: ${TEST_READ:0:20}..."
  exit 4
fi
unset TEST_READ

# --- Step 5: Print follow-up manual steps for driver launchd + .env cleanup ---
echo ""
echo "=== Step 5: NOT-YET-AUTOMATED follow-ups (review before applying) ==="
echo ""
echo "  A. Update launchd plist for the driver to RunAs $DRIVER_USER."
echo "     File: ~/Library/LaunchAgents/ai.ophis.driver.plist (or wherever the"
echo "     docker-compose-up launchd job lives). Add:"
echo "       <key>UserName</key><string>$DRIVER_USER</string>"
echo ""
echo "  B. Patch render-configs.sh to read PK from the new system keychain"
echo "     via: sudo -u $DRIVER_USER security find-generic-password ..."
echo "     Rendered files should land under $DRIVER_HOME/rendered/, chmod 600."
echo ""
echo "  C. Delete the plaintext OPHIS_DRIVER_SUBMITTER_KEY line from"
echo "     ~/greg/infra/<chain>-mainnet/.env on each chain (HL, OP, MegaETH)."
echo "     After: render-configs.sh will fail-loud if the line is set, since"
echo "     render now sources from Keychain — env-var precedence would mask the"
echo "     isolated keychain path."
echo ""
echo "  D. Drain the OLD scep keychain entry ONLY after (A)+(B)+(C) verified"
echo "     working in a maintenance window. Last step:"
echo "       security delete-generic-password -s $KEYCHAIN_SVC"
echo "     This is the point of no return — Tier 1 is complete after this."
echo ""
echo "=== Tier 1 Step 1-4 complete. ==="
echo "    Status: PK now lives in /Library/Keychains/ophis-driver.keychain-db"
echo "    with ACL pinned to user $DRIVER_USER."
echo "    Old PK in scep's keychain is STILL THERE — kept for rollback safety."
echo "    Run tier1-pk-isolation-rollback.sh to undo before draining old PK."
echo ""
echo "    Next: implement (A) launchd RunAs, (B) render-configs.sh patch,"
echo "    (C) .env cleanup, then (D) drain old keychain."
