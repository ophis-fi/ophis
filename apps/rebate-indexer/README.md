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

The deploy workflow builds the Docker image on the VM via `docker compose up --build`,
so no container registry credential is required. Just SSH:

| Secret | Source | Notes |
|---|---|---|
| `ALEPH_REBATES_SSH_KEY` | locally `ssh-keygen -t ed25519 -f <deploy-key>` | put the public key in the VM's `~/.ssh/authorized_keys`; the private half is this secret |
| `ALEPH_REBATES_SSH_HOST` | Aleph dashboard | the VM's reachable IP or hostname |
| `ALEPH_REBATES_SSH_USER` | n/a | typically `root` on Aleph VMs |
| `ALEPH_REBATES_SSH_PORT` | Aleph dashboard | the SSH port (Aleph maps :22 → a high port like `<ssh-port>`) |

The `.env` file on the VM is **not** synced by the deploy workflow — it lives at
`/srv/ophis/apps/rebate-indexer/.env` and is managed out-of-band (operator updates
it via `ssh` when secrets rotate). The workflow's `rsync --delete` explicitly
excludes it.

## Swap scan (exhaustive, allowlist-free)

Report every Ophis swap in a time window across chains, independent of the rebate
wallet allowlist. Read-only: it never touches the rebate DB.

```bash
# OP (local orderbook DB) + hosted majors via Alchemy, last 48h, also DM Clement:
pnpm scan --since 48h --telegram

# one chain, custom window, custom artifact path:
pnpm scan --since 2d --chains ethereum --json /tmp/eth.json
```

Discovery is on-chain (`getLogs(Trade)` on the CoW Settlement contract) plus per-order
appData resolution via CoW's API, keeping `appCode in {ophis, greg}`. Self-hosted
Optimism reads its local orderbook Postgres directly (run on the Mac mini where Docker
lives). Secrets (`alchemy-api-key`, `ophis-telegram-bot`) come from the macOS Keychain.
The JSON artifact and the orderUid cache default to `~/.ophis/` (out of repo). Design:
`docs/development/specs/2026-06-19-onchain-appdata-swap-scan-design.md`.
