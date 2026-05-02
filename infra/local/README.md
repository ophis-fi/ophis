# Greg Local Self-Hosted Stack (Phase 1)

This directory contains the operator runbook + configs for running Greg's
backend (orderbook + autopilot + driver + baseline solver + Postgres)
locally on the Mac mini.

## Two modes
- **Stage 1 — Forked Gnosis:** `docker compose -f docker-compose.fork.yml up`
  Anvil forks the chain; safe playground, no real money.
- **Stage 2 — Real Gnosis mainnet:** `docker compose -f docker-compose.gnosis.yml up`
  Real chain, real funds. Phase-gate evidence runs here.

## Prereqs
- Colima running (`colima status` shows healthy) with ≥ 8 GB allocated
- `apps/backend/` builds locally (Phase 0 prereq — see `apps/backend/.greg-build-notes.md`)
- `infra/local/.env` populated (see `.env.example`)

(Boot order, troubleshooting, and teardown filled in by Tasks 4 / 7 / 11.)
