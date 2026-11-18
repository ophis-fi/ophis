# Security policy

## Supported deployment

Ophis Finance runs a fork of [cowprotocol/services](https://github.com/cowprotocol/services). The operational deployment set is:

| Chain                  | Status | Settlement contract                            |
| ---------------------- | ------ | ---------------------------------------------- |
| Optimism mainnet (10)  | LIVE   | `0x310784c7FCE12d578dA6f53460777bAc9718B859`   |
| Unichain mainnet (130) | LIVE   | See `contracts/deployments/unichain-mainnet/`  |
| Robinhood Chain (4663) | LIVE   | See `contracts/deployments/robinhood-mainnet/` |
| Arc (5042)             | LIVE   | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A`   |

These are the Ophis-operated settlement networks. The frontend at
https://swap.ophis.fi also supports CoW-hosted networks; see the
[network overview](README.md#networks) and [SDK chain configuration](packages/sdk/src/config.ts).

The disclosure policy also covers Ophis integrations and services outside this
settlement stack:

| Component | Security scope |
| --- | --- |
| Private wallet (`apps/railgun/`) | Key storage, proof generation, RPC gateway, private swaps and recovery on Ethereum, BNB Chain and Arbitrum. Other configured networks are not production-enabled by that configuration alone. |
| Broadcaster (`apps/broadcaster/`) | Transaction validation, signing, prepaid gas-credit accounting and refunds. Prepaid credit is held by the operator; it is separate from shielded wallet assets and has no operator-independent withdrawal. |
| Business console (`apps/business-console/`) | Passkeys, roles, approvals, onboarding, sealed KYB records, sanctions screening and signing links. This is an invitation-based service with operator review, separate from public retail swaps. |
| SDK, CLI, MCP and bridge integrations | Order construction, wallet authorization, transaction submission and provider-specific recovery. |

See the [security documentation](https://docs.ophis.fi/audits) for governance
controls and custody boundaries, and the [gas-credit refund policy](apps/broadcaster/PREPAID-REFUNDS.md)
for operator dependencies and minimum refund limits. Upstream audits do not
certify these Ophis-specific services or their deployments.

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
- Findings against deprecated infrastructure directories that no longer exist.
- DoS via known public-tier rate limits on free RPC providers (the eRPC consensus posture fails closed under low-participants — this is the intended behavior, not a vulnerability).

## In scope

Examples of what we consider in scope (non-exhaustive):

- Settlement-contract logic flaws in `contracts/src/` (GPv2Settlement, GPv2AllowListAuthentication, GPv2VaultRelayer).
- Ophis-specific backend crates (`poison-recovery`, `retry-helper`, `configs`, settlement-state-machine in `driver`).
- Partner-fee economic exploits: the live CIP-75 `volumeBps` path (flat volume fee, recipient allowlist, backend fee clamping) and the legacy `priceImprovementBps` / `maxVolumeBps` fallback path.
- Key custody compromise paths.
- Frontend signing-path flaws under `apps/frontend/apps/cowswap-frontend/src/ophis/`.
- eRPC consensus posture bypass (e.g. a configuration that lets a single-upstream answer be trusted for a critical method).
- Submission-path or in-flight settlement-calldata handling flaws.

## Audit history

The complete [review index](docs/audits/README.md) includes dated security,
differential and release assessments. Each report states its own scope.

| Date       | Scope                                  | Reviewers                                    | Findings doc                                                 |
| ---------- | -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| 2026-05-18 | Phase 2 — Rust backend                 | sharp-edges + Codex                          | `docs/audits/2026-05-18-phase2-backend.md`                   |
| 2026-05-19 | Phase 3 — Frontend; Phase 4 — OP infra | sharp-edges × 2 (Codex unavailable that day) | `docs/audits/2026-05-19-phase3-frontend-and-phase4-infra.md` |

Phase 3 + 4 follow-ups were shipped across PRs #120-#138.
