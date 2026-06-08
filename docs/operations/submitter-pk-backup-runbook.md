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

Branch on whether the key may have been **compromised**.

**Key NOT compromised** (you only lost the host; the off-site backup stayed
encrypted / air-gapped):

1. Retrieve the encrypted USB from the off-site bundle, mount it, and place the
   `CURRENT` key at the signing user's key path.
2. Re-render the driver config and bring the driver up; verify it signs and the
   healthcheck returns 200. The same EOA is still allowlisted, so it settles.

**Key MAY be compromised** (host was unencrypted at rest, or you cannot prove the
backup stayed air-gapped) — do **NOT** reinstall the old USB key. Its EOA is
being evicted; restoring it lets the driver sign but it can never settle, so
provision a **fresh** key instead:

1. **Evict the old EOA** from the solver allowlist via the Safe
   (`AllowListGuardian.removeSolver`, instant — see
   [`allowlist-governance-runbook.md`](./allowlist-governance-runbook.md)).
2. **Generate a fresh submitter key** (new EOA), fund it with a small gas float,
   and back it up to a new encrypted USB.
3. **Add the fresh EOA** to the allowlist via the 24h timelock path and point the
   driver at the fresh key. Retire the old USB copy.
4. Bring the driver up and verify. Until the fresh EOA is allowlisted (after the
   24h delay) the protocol intentionally cannot settle — that is the safe state.

Exact paths, the volume name, the key-file location, and the passphrase-storage
detail are in `submitter-pk-backup-runbook.private.md` (off-site bundle).
