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

The deploy workflow joins the tailnet as an ephemeral `tag:ci` node and builds
the Docker image on Cadia via `docker compose up --build`, so no container
registry credential is required. Configure these secrets in the `production`
GitHub environment:

| Secret | Source | Notes |
|---|---|---|
| `TS_AUTHKEY` | Tailscale admin console | ephemeral, pre-authorized auth key permitted to use `tag:ci` |
| `CADIA_REBATES_SSH_PRIVATE_KEY` | dedicated deploy key | private half of the key whose public half is in Cadia's `~/.ssh/authorized_keys` |
| `CADIA_REBATES_SSH_HOST` | `tailscale ip -4` on Cadia | Cadia's Tailscale IPv4 address; the SSH listener is bound only to this address |
| `CADIA_REBATES_SSH_USER` | Cadia operator configuration | unprivileged deploy user with access to `/srv/ophis` and Docker |
| `CADIA_REBATES_SSH_PORT` | Cadia sshd configuration | tailnet-only deploy listener port (`2222` currently) |
| `CADIA_REBATES_SSH_HOST_KEY` | `ssh-keyscan -p <port> <host>` over Tailscale | complete pinned `known_hosts` line, including `[host]:port` |

The `.env` file on the VM is **not** synced by the deploy workflow — it lives at
`/srv/ophis/apps/rebate-indexer/.env` and is managed out-of-band (operator updates
it via `ssh` when secrets rotate). The workflow's `rsync --delete` explicitly
excludes it.

## Swap scan (exhaustive, allowlist-free)

Report every Ophis swap in a time window across chains, independent of the rebate
wallet allowlist. Read-only: it never touches the rebate DB.

```bash
# All 13 production chains, last 48h, also DM Clement:
pnpm scan --since 48h --telegram

# one chain, custom window, custom artifact path:
pnpm scan --since 2d --chains ethereum --json /tmp/eth.json

# override a public endpoint (or set ALCHEMY_API_KEY for supported chains):
SCAN_RPC_ETHEREUM=https://example-rpc.invalid pnpm scan --since 2d --chains ethereum
```

Discovery is on-chain (`getLogs(Trade)` on the CoW Settlement contract) plus per-order
appData resolution via CoW's API, keeping `appCode in {ophis, greg}`. Self-hosted
Optimism reads its local orderbook Postgres directly (run on the Mac mini where Docker
lives). RPC chains use keyless public endpoints by default; `SCAN_RPC_<CHAIN>` overrides
one endpoint, while `SCAN_BLOCK_RPC_<CHAIN>` can separately override historical block
headers when a log provider does not serve them. An explicitly set `ALCHEMY_API_KEY`
takes precedence over the public fallback on supported chains. The optional `ophis-telegram-bot` secret comes from the
macOS Keychain. The JSON artifact and the orderUid cache default to `~/.ophis/` (out of repo). Design:
`docs/development/specs/2026-06-19-onchain-appdata-swap-scan-design.md`.
