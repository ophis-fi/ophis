# Security policy

## Supported deployment

Ophis Finance runs a fork of [cowprotocol/services](https://github.com/cowprotocol/services). Only **one** chain is operationally live as of 2026-05-20:

| Chain | Status | Settlement contract |
|---|---|---|
| Optimism mainnet (10) | LIVE | `0x310784c7FCE12d578dA6f53460777bAc9718B859` |
| HyperEVM mainnet (999) | Contracts deployed, stack PAUSED 2026-05-19 | — |
| MegaETH mainnet (4326) | Contracts deployed, stack PAUSED 2026-05-18 | — |

The frontend at https://ophis.fi targets only the live chain set. Reports against paused chains are still in scope (contracts remain deployed) but will be triaged at a lower urgency.

## Reporting a vulnerability

**Do NOT open a public GitHub issue.** For anything that could affect users' funds, the protocol's solver budget, partner-fee accrual, or could enable settlement-on-forged-state:

- **Email:** `clement@aleph.cloud` with subject prefix `[OPHIS SECURITY]`
- **Signal / Matrix / encrypted alternative:** request a channel via email first

We do not yet operate a public bug-bounty program. Disclosure incentives are negotiated case-by-case based on impact and demonstrated proof-of-concept.

Please include:

1. A clear description of the issue and which component(s) it affects (solidity contract / Rust backend / FE / infra / docs).
2. Reproduction steps. If you have a proof-of-concept transaction, include the tx hash on whichever testnet you used (Sepolia / OP Sepolia) — never PoC against mainnet.
3. The git SHA (`git rev-parse HEAD`) you reproduced against.
4. Your suggested fix, if any.

## Response targets

- **First acknowledgement:** within 48 hours of receipt.
- **Triage decision** (severity + initial mitigation plan): within 5 business days.
- **Patch released:** depends on severity. Critical findings (loss-of-funds, settlement-on-forged-state, key disclosure) get an out-of-band emergency push within 72h of triage.

## Out of scope

The following are NOT considered vulnerabilities by this policy:

- Anything in `apps/frontend/` that's pure upstream CoW Protocol code (file a report with [`cowprotocol/cowswap`](https://github.com/cowprotocol/cowswap) instead). Ophis-specific FE code lives under `apps/frontend/apps/cowswap-frontend/src/ophis/` and similar `ophis/`-prefixed paths.
- Findings in `apps/backend/` against pure upstream CoW Protocol code (file with [`cowprotocol/services`](https://github.com/cowprotocol/services) instead). Ophis additions are marked with `ophis::` module paths or live in dedicated crates: `poison-recovery`, `retry-helper`, `configs`.
- Theoretical attacks requiring nation-state level adversary capability against shared infrastructure (e.g. Cloudflare DNS control-plane compromise).
- Findings against the deprecated infra dirs that were removed in #124 — `infra/optimism/`, `infra/hyperevm/`, `infra/katana/`, `infra/linea/`, `infra/mantle/`. These no longer exist.
- DoS via known public-tier rate limits on free RPC providers (the eRPC consensus posture fails closed under low-participants — this is the intended behavior, not a vulnerability).

## In scope

Examples of what we consider in scope (non-exhaustive):

- Settlement-contract logic flaws in `contracts/src/` (GPv2Settlement, GPv2AllowListAuthentication, GPv2VaultRelayer).
- Ophis-specific backend crates (`poison-recovery`, `retry-helper`, `configs`, settlement-state-machine in `driver`).
- Partner-fee economic exploits (CIP-75 `priceImprovementBps` / `maxVolumeBps` paths).
- Key custody compromise paths.
- Frontend signing-path flaws under `apps/frontend/apps/cowswap-frontend/src/ophis/`.
- eRPC consensus posture bypass (e.g. a configuration that lets a single-upstream answer be trusted for a critical method).
- Submission-path or in-flight settlement-calldata handling flaws.

## Audit history

| Date | Scope | Reviewers | Findings doc |
|---|---|---|---|
| 2026-05-17 | Phase 1 — HyperEVM contracts | sharp-edges + ToB-style review | `docs/audits/2026-05-17-phase1-hyperevm-contracts.md` |
| 2026-05-18 | Phase 2 — Rust backend | sharp-edges + Codex | `docs/audits/2026-05-18-phase2-backend.md` |
| 2026-05-19 | Phase 3 — Frontend; Phase 4 — OP infra | sharp-edges × 2 (Codex unavailable that day) | `docs/audits/2026-05-19-phase3-frontend-and-phase4-infra.md` |

Phase 3 + 4 follow-ups were shipped across PRs #120-#138.
