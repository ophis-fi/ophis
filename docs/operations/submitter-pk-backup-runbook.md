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

## Current storage inventory — September 24, 2026

Read-only host checks traced the running driver mounts and current render scripts.
No private key contents were read, copied or compared. Canonical paths below are
the configured sources; this inventory does not prove a key/address match or a
successful backup/restore.

| Chain | Host | Configured canonical key | Runtime copy |
| --- | --- | --- | --- |
| OP | Mac mini | `/Users/ophis-driver/.config/submitter.key` | `/Users/scep/.local/state/ophis/ram-pk/driver.toml` on a verified hdiutil RAM image |
| Robinhood | Cadia WSL (`cadia-wsl`) | `/home/ophis-driver/.config/submitter.key` | `/home/clement/.local/state/ophis/rbh-ram-pk/driver.toml` on tmpfs |
| Unichain | Separate VM (`ophis-unichain-vm-2`) | `/home/ophis-driver/.config/submitter.key` | `/root/.local/state/ophis/ram-pk/driver.toml` on tmpfs |
| Arc | Mac mini | `/Users/ophis-driver/.config/ophis-arc/submitter.key` | `/Users/scep/.local/state/ophis/arc-ram-pk/submitter.key` on a verified hdiutil RAM image; prepared and active |

Robinhood's canonical file is owned by `ophis-driver`, mode 0600; Unichain's
canonical file is owned by UID 999, mode 0600. OP's isolated file was not opened;
its live RAM configuration is owned by UID 501, mode 0600. Arc's isolated import
was confirmed by the operator. Identical Linux paths are on different machines
and do not imply shared keys. The old Unichain path
`/opt/ophis-submitter/submitter.json` no longer exists on its current VM.

The off-site USB procedure below is documented policy, not evidence that every
chain has a verified backup. No backup USB was mounted on the Mac during these
checks. Bounded metadata checks in the relevant host operations/state directories
found no verified key-backup receipt or private recovery runbook; they do not
establish that an off-site backup is absent.

Arc subsequently received an independent encrypted Ethereum V3 backup on this
Mac mini, as explicitly requested by the operator. The backup under
`/Users/scep/.local/share/ophis-backups/arc/20260924T114439Z/` was decrypted from
disk and verified against the planned solver address with a local signing check
at 11:46 UTC. Directories are 0700 and files 0600. Its independent recovery
password is in macOS login Keychain, service `fi.ophis.arc.backup`, account
`solver-5042-20260924T114439Z`. `recovery.json` records the keystore hash and
verification. The canonical key is unchanged; encrypted staging is retained.
This same-host backup is verified; off-site recovery is not.

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
