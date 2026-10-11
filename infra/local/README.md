# Ophis Local Self-Hosted Stack (Phase 1)

This directory contains the operator runbook + configs for running Ophis's
backend (orderbook + autopilot + driver + baseline solver + Postgres)
locally on the Mac mini.

Before running either production-Dockerfile stack, export its source revision
from the repository root (the backend/infra tree must be clean):

```bash
export OPHIS_GIT_SHA="$(python3 infra/shared/scripts/backend-revision.py source .)"
```

The build argument is required for all binaries and the migrations image.
Native development builds identify themselves with a `-dev` suffix.

## Two modes
- **Stage 1 — Forked Gnosis:** `docker compose -f docker-compose.fork.yml up`
  Anvil forks the chain; safe playground, no real money.
- **Stage 2 — Real Gnosis mainnet:** `docker compose -f docker-compose.gnosis.yml up`
  Real chain, real funds. Phase-gate evidence runs here.

## Prereqs
- Colima running (`colima status` shows healthy) with ≥ 8 GB allocated
- `apps/backend/` builds locally (Phase 0 prereq — see `apps/backend/.ophis-build-notes.md`)
- `infra/local/.env` populated (see `.env.example`)

(Boot order, troubleshooting, and teardown filled in by Tasks 4 / 7 / 11.)
