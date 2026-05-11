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
