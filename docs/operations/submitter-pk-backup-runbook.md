# Submitter PK backup & restore runbook

**Audience:** Mac-mini operator (Clement today; any successor maintainer
post-bus-factor).
**Last updated:** 2026-05-19 (long-tail 6.x).
**Related:**
- `docs/operations/founder-bus-factor.md` Section 5.1 — strategy & rationale
- `docs/architecture/2026-05-18-submitter-pk-custody-adr.md` — custody decisions

## What this covers

The driver-submitter PK at `/Users/ophis-driver/.config/submitter.key`
(32-byte hex, mode 0600, owner=ophis-driver) is the single secret
required to keep the OP mainnet driver dispatching settlements. If it
is lost AND no backup exists:

- Rotation requires submitter-EOA-replay: deploy a new EOA, ask Safe
  signers to add it via `addSolver` on each chain's
  `GPv2AllowListAuthentication`, update `infra/<chain>-mainnet` configs,
  redeploy. **~4 hours of focused work**, plus Safe signer coordination.

If it is lost but a backup exists: 5 minutes to restore.

This runbook gives the exact commands for backup, periodic
verification, and restore.

## Backup procedure (initial setup, then quarterly refresh)

### Prerequisites

- One FileVault-encrypted USB drive, exclusively for Ophis backups
  (label physically — "OPHIS-PK-BACKUP"). Do not use this stick for
  anything else.
- USB stick passphrase: stored separately (sealed envelope in
  Clement's safe + a duplicate in his sister's safe in Lyon — per
  bus-factor doc).
- ~30 minutes the first time; ~2 minutes for refreshes.

### Step 1 — copy the live key off the host

```bash
# Read the live key into a local-only file in tmpfs (NOT on disk).
TMP=$(mktemp -t ophis-pk-backup)
sudo cat /Users/ophis-driver/.config/submitter.key > "$TMP"
chmod 600 "$TMP"

# Sanity-check shape before proceeding.
grep -qE '^0x[a-fA-F0-9]{64}$' "$TMP" || { echo "BAD PK SHAPE"; rm -f "$TMP"; exit 1; }
echo "PK shape OK ($(wc -c < "$TMP") bytes incl newline)."
```

### Step 2 — write to the encrypted USB

Mount the USB stick. macOS will prompt for the FileVault passphrase.

```bash
# Confirm the volume is the right one.
diskutil list | grep -i ophis    # expect: OPHIS-PK-BACKUP volume

USB_VOL=/Volumes/OPHIS-PK-BACKUP   # adjust if your volume name differs

# Atomic write to the USB.
DATE=$(date +%F)
cp "$TMP" "$USB_VOL/submitter.key.$DATE"
chmod 600 "$USB_VOL/submitter.key.$DATE"

# Diff check — refuse to commit if the new file doesn't match source.
diff -q "$TMP" "$USB_VOL/submitter.key.$DATE" || {
  echo "BACKUP COPY DIFFERS FROM SOURCE — abort"
  rm "$USB_VOL/submitter.key.$DATE"
  rm "$TMP"
  exit 1
}

# Replace the "current" pointer (a symlink for easy restore).
ln -sf "submitter.key.$DATE" "$USB_VOL/submitter.key.CURRENT"

# Securely delete the temp file (single-pass on APFS — no journal mode).
rm -P "$TMP"  # macOS rm -P does a single overwrite pass.

# Eject and physically unplug.
diskutil eject "$USB_VOL"

echo "Backup written: submitter.key.$DATE → CURRENT"
```

### Step 3 — store the USB stick offline

- Not in the same room as the Mac mini (so a single fire / theft can't
  take both).
- In a fire-rated safe if available.
- Photographed in-situ once a year (low-effort audit trail).

## Verification procedure (quarterly — set a calendar reminder)

The point: the backup is useless if it has rotted (bit-rot on cheap
USB sticks is real after 2-3 years).

```bash
# 1. Plug in the USB.
USB_VOL=/Volumes/OPHIS-PK-BACKUP

# 2. Read the live key into tmp (same as Step 1 of backup).
TMP_LIVE=$(mktemp -t ophis-pk-live)
sudo cat /Users/ophis-driver/.config/submitter.key > "$TMP_LIVE"
chmod 600 "$TMP_LIVE"

# 3. Resolve CURRENT and diff.
CURRENT=$(readlink "$USB_VOL/submitter.key.CURRENT")
echo "Checking against: $USB_VOL/$CURRENT"

if diff -q "$TMP_LIVE" "$USB_VOL/$CURRENT" >/dev/null; then
  echo "VERIFY OK — backup matches live key as of $(date -Iseconds)"
else
  echo "VERIFY FAILED — backup does not match. Investigate."
  echo "  Live key fingerprint:    $(shasum -a 256 "$TMP_LIVE" | head -c 32)"
  echo "  Backup key fingerprint:  $(shasum -a 256 "$USB_VOL/$CURRENT" | head -c 32)"
  # Decide whether to refresh the backup (live key is canonical)
  # or restore from backup (backup is canonical) — depends on whether
  # the live key was rotated recently.
fi

# 4. Cleanup
rm -P "$TMP_LIVE"
diskutil eject "$USB_VOL"
```

If verification fails:
- If you remember rotating the PK recently, just re-run the backup
  procedure (live is canonical).
- If you did NOT rotate the PK, the live file might be corrupted —
  check `sudo file /Users/ophis-driver/.config/submitter.key` and the
  full hex via `sudo cat`. If the live file is broken, **restore from
  backup ASAP** (Step "Restore" below) and rotate the EOA after
  recovery (the corruption window may mean the file was overwritten
  by an attacker).

## Restore procedure (emergency — driver won't start because PK is missing)

Symptom: driver container exits 5 from `render-configs.sh` with
"PK from /Users/ophis-driver/.config/submitter.key not a 32-byte hex"
OR the file is missing entirely.

```bash
# 1. Plug in the USB. Confirm volume.
USB_VOL=/Volumes/OPHIS-PK-BACKUP
ls -la "$USB_VOL/submitter.key.CURRENT"

# 2. Verify the backup's shape BEFORE overwriting anything.
grep -qE '^0x[a-fA-F0-9]{64}$' "$USB_VOL/submitter.key.CURRENT" \
  || { echo "BACKUP IS NOT A VALID PK SHAPE — STOP"; exit 1; }

# 3. Move the broken/missing file aside (don't delete — for forensics).
sudo mv /Users/ophis-driver/.config/submitter.key \
  /Users/ophis-driver/.config/submitter.key.BROKEN.$(date +%s) \
  2>/dev/null || true

# 4. Restore. Note: we cat the backup through sudo install rather than
# `cp` so the destination's owner=ophis-driver / mode=0600 is set
# atomically. macOS `install -m 600 -o ophis-driver` requires sudo.
sudo install -m 600 -o ophis-driver -g staff \
  "$USB_VOL/submitter.key.CURRENT" \
  /Users/ophis-driver/.config/submitter.key

# 5. Sanity-check the restore.
sudo cat /Users/ophis-driver/.config/submitter.key \
  | grep -qE '^0x[a-fA-F0-9]{64}$' \
  && echo "RESTORE OK" \
  || { echo "RESTORE FAILED — file did not land correctly"; exit 1; }

# 6. Re-render configs + restart driver.
cd /Users/scep/greg/infra/optimism-mainnet
./render-configs.sh
docker compose up -d --no-deps driver

# 7. Eject USB and store offline again.
diskutil eject "$USB_VOL"
```

After restore, verify the driver healthcheck transitions to healthy:

```bash
docker inspect optimism-mainnet-driver-1 \
  --format '{{json .State.Health}}' | jq .
```

Expect `Status: "healthy"` within 60 seconds (the new `/healthz` probe
from PR #132 confirms the PK is loaded AND the on-chain balance is
above the min — if either is wrong, it stays unhealthy).

## Operational reminders

- **NEVER** transmit the PK file electronically — no email, no Slack, no
  iMessage, no Notion, no AirDrop, no iCloud.
- **NEVER** commit it. The Tier 1 isolation path explicitly refuses to
  run `render-configs.sh` if `.env` has `OPHIS_DRIVER_SUBMITTER_KEY=`.
- After running this runbook, run `history -c && history -w` to clear
  shell history (the file paths might land in history if your shell
  retains it; the PK content does not because we never echoed it).
- The `submitter.key.BROKEN.*` forensic copies from past restores
  should be wiped quarterly: `sudo shred -u /Users/ophis-driver/.config/submitter.key.BROKEN.*`
  (only after you're confident no live investigation needs them).

## Roadmap to make this runbook obsolete

Tier 2 KMS (~$140/yr AWS) replaces local-file PK custody entirely:
the driver signs via the KMS Sign API, no local PK exists. At that
point this runbook becomes "KMS key versioning + alias rotation
runbook." See
`docs/architecture/2026-05-18-submitter-pk-custody-adr.md` for the
decision tree.
