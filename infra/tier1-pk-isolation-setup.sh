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
# File-based PK storage. Filesystem ACL on $DRIVER_HOME (mode 0700) gives true
# per-user isolation. The previous System Keychain approach didn't work because
# `security -T /usr/bin/security` treats any user's `security` invocation as
# authorized (the binary is the same), and macOS 26.x has a separate bug where
# `set-keychain-settings` fails on freshly-created system keychains.
PK_DIR="$DRIVER_HOME/.config"
PK_FILE="$PK_DIR/submitter.key"

# --- Step 1: Verify the PK is currently in scep's login keychain ---
echo "=== Step 1: Confirm PK is present in user keychain ==="
# Don't filter by -a/acct — the entry was created with acct == svce, not "scep".
# Filter by -s (service) only; security defaults to scep's login keychain.
if ! security find-generic-password -s "$KEYCHAIN_SVC" >/dev/null 2>&1; then
  echo "ERROR: Keychain entry '$KEYCHAIN_SVC' not found in scep's login keychain." >&2
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
  # Generate a random unguessable login password we'll never use (no shell anyway).
  # NOTE: invert the pipe (head -c reads finite bytes from /dev/urandom and exits;
  # tr drains to EOF and exits 0). The reverse — `tr | head -c N` — triggers
  # SIGPIPE on tr under `pipefail` and aborts the script silently.
  _raw=$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')
  sudo dscl . -passwd /Users/$DRIVER_USER "${_raw:0:64}"
  unset _raw
  echo "  ✓ User $DRIVER_USER created."
fi

# --- Step 3: Copy PK into a file inside ophis-driver's home directory ---
echo ""
echo "=== Step 3: Copy PK to $PK_FILE ==="

# Clean up any prior failed System Keychain attempt from earlier script revisions.
if [[ -f /Library/Keychains/ophis-driver.keychain-db ]] || \
   [[ -f /etc/ophis-driver-keychain.pass ]]; then
  echo "  Cleaning up prior System Keychain artifacts (deprecated approach)..."
  sudo rm -f /Library/Keychains/ophis-driver.keychain-db
  sudo rm -f /etc/ophis-driver-keychain.pass
fi

# Read PK from scep's keychain (this is the LAST time we'll do this from scep).
# Same fix as Step 1: -a/acct doesn't match "scep"; service-only lookup works.
echo "  Reading PK from scep's keychain..."
PK_TMP=$(security find-generic-password -s "$KEYCHAIN_SVC" -w 2>&1 | tr -d '\n\r')
if [[ ! "$PK_TMP" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: PK format invalid (expected 0x + 64 hex chars). Got length: ${#PK_TMP}" >&2
  unset PK_TMP
  exit 3
fi

# Ensure $DRIVER_HOME/.config exists, owned by ophis-driver, mode 0700.
sudo -u "$DRIVER_USER" mkdir -p "$PK_DIR" 2>/dev/null || sudo mkdir -p "$PK_DIR"
sudo chown "$DRIVER_USER":staff "$PK_DIR"
sudo chmod 700 "$PK_DIR"

# Write PK to file as root, then chown to ophis-driver, then chmod 0600.
# Can't use `install(1)` here — macOS BSD install rejects /dev/stdin as a source
# (GNU install supports it). The tee/chmod/chown sequence is safe because the
# parent dir $PK_DIR is already 0700 ophis-driver, so scep can't traverse into
# it to see the file at any intermediate perm state.
printf '%s\n' "$PK_TMP" | sudo tee "$PK_FILE" >/dev/null
sudo chmod 600 "$PK_FILE"
sudo chown "$DRIVER_USER":staff "$PK_FILE"
unset PK_TMP

# Double-check $DRIVER_HOME itself is 0700 (it should be from Step 2, but verify).
sudo chmod 700 "$DRIVER_HOME"
sudo chown "$DRIVER_USER":staff "$DRIVER_HOME"

echo "  ✓ PK written to $PK_FILE (mode 0600, owner $DRIVER_USER)."
echo "  ✓ Parent dirs $PK_DIR (0700) and $DRIVER_HOME (0700) owned by $DRIVER_USER."

# --- Step 4: Verify scep CANNOT read, ophis-driver CAN read ---
echo ""
echo "=== Step 4: Verify isolation ==="

# As user scep: should fail because $DRIVER_HOME is 0700.
if cat "$PK_FILE" >/dev/null 2>&1; then
  echo "  ERROR: user scep can still read $PK_FILE. Filesystem ACL broken."
  exit 4
else
  echo "  ✓ user scep CANNOT read $PK_FILE (filesystem ACL enforces isolation)."
fi

# As user ophis-driver: should succeed and return a valid 0x-prefixed 64-hex PK.
TEST_READ=$(sudo -u "$DRIVER_USER" cat "$PK_FILE" 2>&1 | tr -d '\n\r' || echo FAILED)
if [[ "$TEST_READ" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "  ✓ user $DRIVER_USER CAN read PK via 'sudo -u $DRIVER_USER cat $PK_FILE'."
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
echo "  B. Patch render-configs.sh to read PK from the new file via:"
echo "       sudo -u $DRIVER_USER cat $PK_FILE"
echo "     Rendered files should land under $DRIVER_HOME/rendered/, chmod 600."
echo ""
echo "  C. Delete the plaintext OPHIS_DRIVER_SUBMITTER_KEY line from"
echo "     ~/greg/infra/<chain>-mainnet/.env on each chain (HL, OP, MegaETH)."
echo "     After: render-configs.sh will fail-loud if the line is set, since"
echo "     render now sources from $PK_FILE — env-var precedence would mask the"
echo "     isolated file-based path."
echo ""
echo "  D. Drain the OLD scep keychain entry ONLY after (A)+(B)+(C) verified"
echo "     working in a maintenance window. Last step:"
echo "       security delete-generic-password -s $KEYCHAIN_SVC"
echo "     This is the point of no return — Tier 1 is complete after this."
echo ""
echo "=== Tier 1 Step 1-4 complete. ==="
echo "    Status: PK now lives in $PK_FILE (mode 0600, owner $DRIVER_USER)."
echo "    Isolation: filesystem ACL on $DRIVER_HOME (mode 0700) prevents user"
echo "    scep from reading the file. Only $DRIVER_USER (and root) can read it."
echo "    Old PK in scep's keychain is STILL THERE — kept for rollback safety."
echo "    Run tier1-pk-isolation-rollback.sh to undo before draining old PK."
echo ""
echo "    Next: implement (A) launchd RunAs, (B) render-configs.sh patch,"
echo "    (C) .env cleanup, then (D) drain old keychain."
