# Disaster recovery runbook (public outline)

Recover the Ophis Optimism stack after host failure or total loss. This is the
**committed, sanitized outline** so the recovery flow survives a fresh `git clone`
during an outage. The **full runbook with exact hosts, paths, volume names and
commands is operator-local** at `disaster-recovery-runbook.private.md` and is
kept in the **encrypted off-site recovery bundle** — retrieve it from there in a
total-loss event (a fresh clone intentionally omits host specifics).

> Off-site recovery bundle MUST contain (none are in this repo):
> the operator-local `*.private.md` runbooks (this DR runbook, the PK-backup
> runbook, the bus-factor doc), the encrypted submitter-PK USB, the `.env`
> files, the latest Postgres dump, and the 3 Ledger seed phrases (stored
> independently). If any are missing, the procedure below cannot complete.

## Step 0 — secure the EOA FIRST (if the key may be compromised)

If the submitter PK may have been exposed (e.g. the host was unencrypted at rest,
or you cannot prove the offsite backup stayed air-gapped), **before restoring any
key or bringing the stack up**: evict the old submitter EOA from the solver
allowlist via the 2-of-3 Safe — `AllowListGuardian.removeSolver(oldEOA)` is the
**instant** path (see [`allowlist-governance-runbook.md`](./allowlist-governance-runbook.md),
"Evict a solver"). While it is removed the protocol cannot settle — that is the
correct safe state. Add the new EOA via the 24h timelock path once the new key is
provisioned. The immutable Settlement/VaultRelayer mean user funds are never at
risk here; this only protects the solver float and settlement integrity.

## Recovery outline

1. **Secure the EOA** (Step 0) if compromise is possible.
2. **Provision a replacement host** (Mac, or a temporary Linux VM with Docker).
3. **Restore the code** — `git clone` this repo; retrieve the `.private` runbooks
   from the off-site bundle for the host-specific commands.
4. **Restore the signing user + submitter PK** from the encrypted off-site USB
   (see [`submitter-pk-backup-runbook.md`](./submitter-pk-backup-runbook.md)).
5. **Restore the `.env` files** from the off-site bundle.
6. **Restore Postgres** from the latest off-site dump (see
   [`postgres-backup-setup.md`](./postgres-backup-setup.md), Restore).
7. **Bring up the stack and verify** — all containers healthy, eRPC consensus
   succeeding, driver healthcheck 200, autopilot finding orders.
8. **Update DNS / Cloudflare Tunnel** if the host changed.
9. **Post-recovery checklist** — re-arm backups; if the EOA was rotated, confirm
   the new EOA is allowlisted on-chain (`addSolver` event executed after the 24h
   delay).

The exact commands, paths, container/DB names, host details, and the
Backblaze/USB specifics for every step are in the operator-local
`disaster-recovery-runbook.private.md` (off-site bundle).
