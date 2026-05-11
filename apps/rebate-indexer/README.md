# @ophis/rebate-indexer

Off-chain indexer + Safe batch proposer for Ophis's volume-tiered WETH rebate program.

## Quickstart (dev)

```bash
pnpm install
docker compose up -d pg
pnpm db:migrate
pnpm dev
```

## Architecture

See [`docs/development/specs/2026-05-11-rebate-ledger-design.md`](../../docs/development/specs/2026-05-11-rebate-ledger-design.md).

## Runbook

See [`RUNBOOK.md`](./RUNBOOK.md) for incident response.

## GitHub secrets required for deploy

| Secret | Source | Notes |
|---|---|---|
| `GHCR_PAT` | github.com/settings/tokens | classic PAT with `write:packages` |
| `ALEPH_REBATES_SSH_KEY` | locally `ssh-keygen -t ed25519 -f aleph_rebates_deploy` | put the public key in the VM's `~/.ssh/authorized_keys`; the private half is this secret |
| `ALEPH_REBATES_SSH_HOST` | Aleph dashboard | the VM's reachable IP or hostname |
| `ALEPH_REBATES_SSH_USER` | n/a | typically `root` on Aleph VMs |
