# Submitter PK backup & restore runbook (public outline)

Back up and restore the driver/solver submitter private key. This is the
**committed, sanitized outline**; the **full procedure with exact paths, volume
names and the passphrase-storage location is operator-local** at
`submitter-pk-backup-runbook.private.md` and is kept in the **encrypted off-site
recovery bundle**.

The submitter EOA is a hot key with a small gas float (not a treasury). Losing it
costs settlement capability, not user funds (orders are user-signed within fixed
limits; the immutable Settlement/VaultRelayer cannot be re-pointed). A leaked key
is handled by allowlist eviction, not by treating it as a fund-loss event.

## Backup (outline)

- The live key is copied off the host into a FileVault-encrypted USB drive kept
  off-site, refreshed quarterly. The temp copy is made in tmpfs (never written to
  the SSD), shape-checked, written atomically to the USB, diff-verified, and the
  temp securely deleted. A `CURRENT` symlink points at the latest dated copy.
- The USB passphrase is stored separately from the drive.

## Restore (outline)

1. If the key may be compromised, **evict the old EOA first** via the Safe
   (see [`allowlist-governance-runbook.md`](./allowlist-governance-runbook.md)).
2. Retrieve the encrypted USB from the off-site bundle, mount it, and place the
   `CURRENT` key at the signing user's key path.
3. Re-render the driver config and bring the driver up; verify it signs and the
   healthcheck returns 200.

Exact paths, the volume name, the key-file location, and the passphrase-storage
detail are in `submitter-pk-backup-runbook.private.md` (off-site bundle).
