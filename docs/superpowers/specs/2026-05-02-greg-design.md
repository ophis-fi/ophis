# Greg — Design Spec

> **Codename:** Greg (renameable before public launch)
> **Date:** 2026-05-02
> **Owner:** Clement (san-npm), CTO
> **Source:** `~/Desktop/cowswap_fork_dev_brief.md` + brainstorming session 2026-05-02

---

## 1. Summary

Greg is a **Stage-2 fork of CoW Protocol** targeting **DeFi power-user retail on Gnosis Chain**. We fork `cowprotocol/cowswap` (frontend) and `cowprotocol/services` (Rust orderbook + auction driver), self-host on Aleph Cloud + Vercel + Supabase, and ride CoW's existing Gnosis solver network for execution.

We do **not** fork settlement contracts, do **not** run our own solver, and do **not** add custom Solidity in Phase 1 — which means no audit, no governance overhead, and no contract-level liability while we validate.

The product wedge is a polished **composable-order builder** (DCA, TWAP, conditional orders) on top of `cowprotocol/composable-cow`, plus **Safe-app integration** and **MEV-proof receipts**. Power-user retail traction first; DAO treasury features second; B2B routing API last.

## 2. Goals & Non-goals

### Goals
1. Ship a self-hosted Stage-2 CowSwap fork on Gnosis Chain with our own orderbook + driver.
2. Differentiate the retail frontend with a composable-order UX that doesn't exist in vanilla CowSwap.
3. Generate measurable partner-fee revenue at 0.1%+ of niche-segment volume.
4. Build a track record DAOs can verify before Phase 3.
5. Keep Phase-1 monthly cost at €0 by combining free tiers (Vercel, Supabase, Alchemy, Grafana Cloud) with Clement's Aleph access.

### Non-goals (Phase 1)
- Token launch, governance, points, airdrop.
- Native mobile apps (PWA only).
- Fiat on/off-ramps.
- Multi-chain support (Gnosis only).
- Custom solvers.
- Custom Solidity / settlement contracts.
- KYC, custody, fiat exposure.

## 3. Audience

**DeFi power-user retail.** Concretely:
- Holds a Safe (multisig) or hot wallet, signs EIP-712 happily.
- Trades long-tail and stable pairs on Gnosis Chain.
- Cares about MEV protection, surplus capture, and execution proofs.
- Comfortable with composable orders (DCA, TWAP, conditional triggers) if the UI doesn't make them parse contract code.

This audience is the **bridge to DAO treasuries**: the same user-facing primitives (Safe-app, MEV-proof receipts, treasury-grade analytics) become DAO-facing in Phase 3.

## 4. Strategy & Build Order

```
Phase 0  Foundation        →  Phase 1  Self-host backend
                                          ↓
                              Phase 2  E features / retail launch
                                          ↓
                              Phase 3  DAO desk
                                          ↓
                              Phase 4  B2B API + multi-chain
```

The retail-first sequence is deliberate: DAOs trust traction, not pitches. Phase 2 produces the verifiable history that Phase 3 sells against.

## 5. Architecture

### What we fork vs depend on

| Component | Action | License | Rationale |
|---|---|---|---|
| `cowprotocol/cowswap` | Fork → `apps/frontend` | GPL-3.0 | Frontend control |
| `cowprotocol/services` | Fork → `apps/backend` (Rust) | GPL-3.0 | Stage-2 backend control |
| `cowprotocol/composable-cow` | Library use only | GPL-3.0 | Already-deployed contracts power our DCA/TWAP UI |
| `cowprotocol/cow-sdk` | Library + thin wrapper | Apache 2.0 | Order signing, partner-fee parameter |
| GPv2Settlement (CoW contracts) | Use as-is | — | Avoids audit cost |
| CoW Gnosis solver network | Ride existing | — | We don't solve in Phase 1 |

### Repo layout (`san-npm/greg`, private, GPL-3.0, pnpm monorepo)

```
greg/
├── apps/
│   ├── frontend/          # forked cowswap, Greg UX, PWA
│   └── backend/           # forked cowprotocol/services (Rust)
├── packages/
│   ├── sdk/               # @greg/sdk — TS wrapper around cow-sdk
│   └── contracts/         # empty Phase 1 placeholder
├── infra/
│   ├── aleph/             # Aleph Cloud manifests
│   ├── rpc/               # FallbackProvider config
│   └── monitoring/        # Grafana dashboards, alerts
├── docs/
│   └── superpowers/
│       ├── specs/         # design specs
│       └── plans/         # implementation plans
└── .claude/
    └── agents/            # pm.md, frontend.md, backend.md, cto.md
```

### Data flow — instant swap (Phase 1+)

```
User wallet
  → Greg frontend (Vercel)
  → user signs EIP-712 intent
  → Greg orderbook API (Aleph, Rust)
  → broadcast batch to CoW's Gnosis solver network
  → winning solution settles via GPv2Settlement on Gnosis
  → user receives tokens
  → Greg partner fee deducted from surplus → Greg treasury wallet
```

### Data flow — composable order (Phase 2+, DCA example)

```
User → Greg DCA builder UI
     → user signs Safe transaction
     → ComposableCoW.create(conditionalOrder)
     → on each interval, Greg orderbook surfaces the matured leaf to solvers
     → settlement via GPv2Settlement
     → next leaf waits its trigger
```

### Hosting

| Component | Platform | Cost |
|---|---|---|
| Frontend (Next.js fork of cowswap) | **Vercel** Hobby | €0 |
| Orderbook API + driver (Rust) | **Aleph Cloud** | €0 (Clement's access) |
| Postgres (orderbook persistence) | **Supabase** free tier | €0 |
| RPC | **Alchemy** free + PublicNode + Ankr fallback (`viem fallback()` transport) | €0 |
| Monitoring | **Grafana Cloud** free tier | €0 |
| DNS / TLS / tunnels | **Cloudflare** | €0 |
| **Total Phase-1 monthly** | | **€0** |

Aleph wins the Rust-services slot because of long-running compute and free access. Vercel beats Aleph on frontend DX (preview URLs, edge CDN, instant rollbacks). Supabase beats Aleph on managed Postgres for a workload that fits the free tier.

## 6. Differentiation Features (Phase 2)

| Feature | Built on | Notes |
|---|---|---|
| Composable-order builder UI | `composable-cow` contracts | DCA, TWAP, conditional triggers — visual flow, not raw bytecode |
| Safe-app integration | Safe React SDK + manifest | Install Greg as a Safe app, sign treasury swaps from multisig |
| MEV-proof receipts | CoW auction transparency API | Exportable PDF/JSON of solver competition per settlement |
| Power-user analytics | Greg orderbook data + Dune | Solver win-rate per pair, surplus saved vs Uniswap reference, slippage histograms |
| PWA | manifest.json + service worker | Installable, offline cache for non-trade screens |

## 7. Phased Roadmap

### Phase 0 — Foundation (weeks 1–3)
- Monorepo scaffolded (pnpm + turbo), GPL-3.0, `.claude/agents/`, CI bones.
- Fork `cowprotocol/cowswap` → `apps/frontend`, rebrand to Greg minimal, deploy to Vercel.
- Fork `cowprotocol/services` → `apps/backend`, build locally.
- Frontend → CoW's official Gnosis API (no self-hosted backend yet).
- **Phase gate:** real swap completes on Gnosis Chiado testnet via Greg frontend hitting CoW's APIs.

### Phase 1 — Self-hosted backend (weeks 3–8)
- Greg orderbook API + auction driver running on Aleph (forked services).
- Postgres on Supabase, RPC fallback stack live, Grafana monitoring.
- Frontend repointed at Greg's orderbook.
- Settlements still ride CoW's existing Gnosis solver network.
- **Phase gate:** end-to-end Gnosis mainnet swap via fully self-hosted Greg stack.

### Phase 2 — E features / retail launch (weeks 8–16)
- Composable-order builder (DCA + TWAP) over `composable-cow`.
- Safe-app manifest + signing flow.
- MEV-proof receipt export.
- Power-user analytics.
- PWA polish.
- Docs site + landing page.
- **Phase gate:** 100 active retail wallets, $1M cumulative volume.

### Phase 3 — DAO desk (weeks 16–24+)
- Treasury dashboard variant (multi-position, multi-sig batched).
- Per-account fee tiers.
- Outreach to one credible DAO client.
- **Phase gate:** one DAO actively executing through Greg.

### Phase 4 — B2B API + multi-chain (weeks 24+)
- Public REST/SDK API, key management, rate limits, billing.
- White-label theming.
- Expand to Base / Arbitrum / Mainnet (CoW already supports these).
- **Phase gate:** one paying integrator.

## 8. Sub-agent Definitions (`.claude/agents/`)

| File | Role | Tools | Skills loaded | Forbidden |
|---|---|---|---|---|
| `pm.md` | Roadmap, GitHub issues, status reports, status sweeps. No code. | Read, Grep, Glob, Bash (read-only), TaskCreate, WebFetch | `superpowers:writing-plans`, `superpowers:executing-plans` | Edit, Write, destructive Bash |
| `frontend.md` | React/TS/Next.js, cowswap fork patches, Greg UX, Safe app, Vercel deploy. | Read, Edit, Write, Bash, Grep, Glob | `vercel:*`, `frontend-design`, `web-design-guidelines`, `ethskills`, `claude-api` | Touching `apps/backend/` |
| `backend.md` | Rust, cowprotocol/services fork, Postgres schema, Aleph deploy. | Read, Edit, Write, Bash, Grep, Glob | `ethskills`, `building-secure-contracts:*`, `testing-handbook-skills:*`, `dimensional-analysis:*` | Touching `apps/frontend/` |
| `cto.md` | Documentation only — describes the operating mode for the main session (Clement + Claude main). | — | All available | — |

**Dispatch rules.** The CTO (main session) dispatches FE + BE in parallel via the Task tool when work is independent. PM gets dispatched for status sweeps and issue grooming. Cross-cutting strategic decisions stay with the CTO. Each agent file is self-contained — no cross-references that break in isolation.

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rust ramp-up cost (TS/Solidity-strong, services is Rust) | High | Med | BE agent prompt seeded with services repo conventions; small-diff tasks |
| CoW Gnosis solver depth thin enough to hurt UX | Med | High | Empirically measure solver competition before Phase 2 retail launch |
| GPL-3.0 forces public source on deploy | Certain | Low | Accepted — flip repo public when we deploy |
| Aleph reliability for prod orderbook | Med | High | Hetzner/Fly failover runbook as Phase 2 deliverable |
| MEV-proof receipts depend on CoW auction-data API | Low | Med | Validate API surface before promising the feature publicly |
| MiCA/regulatory drag on retail | Med | Med | Position as non-custodial intent broker; no fiat; no custody |
| CoW DAO breaks partner-fee mechanism | Low | High | Forked services means we can route fees ourselves at Phase 3 |
| Single-point Aleph hosting failure | Med | High | Multi-region Aleph + documented manual failover to Hetzner |

## 10. Testing Posture

- **Frontend:** Vitest unit + Playwright E2E for golden swap flow, DCA flow, Safe-app flow.
- **Backend:** `cargo test` + integration tests against Anvil-forked Gnosis.
- **Pre-deploy:** full regression on Chiado testnet before each mainnet push.
- **No contracts in Phase 1 → no audit.**
- **If a fee-router contract is added in Phase 3:** trigger `building-secure-contracts:*` skills + Trail of Bits-lite review before deploy.

## 11. Success Metrics

| Phase | Metric | Target |
|---|---|---|
| 0 | First testnet swap via Greg frontend | week 3 |
| 1 | First mainnet swap via fully self-hosted Greg | week 8 |
| 2 | Active wallets (30d) | 100 |
| 2 | Cumulative volume | $1M |
| 3 | DAO clients executing | 1 |
| 4 | Paying B2B integrators | 1 |

## 12. Open Questions (to resolve before / during implementation planning)

- Final project name (Greg is a codename; brand work happens before Phase 2 public launch).
- Greg treasury wallet address (where partner fees route — multisig from day 1).
- Final domain (default candidates: `greg.xyz`, `greg.fi`, `usegreg.app`, or one of the openletz domains).
- Partner-fee bp (default: 5bps, configurable).
- Aleph region(s) for primary + failover.
- Whether to publish `@greg/sdk` to npm before Phase 2.

## 13. References

- CoW Protocol docs: https://docs.cow.fi
- Architecture overview: https://cowswap.mintlify.app/services/architecture
- Solvers: https://docs.cow.fi/cow-protocol/concepts/introduction/solvers
- GitHub org: https://github.com/cowprotocol
- Frontend repo: https://github.com/cowprotocol/cowswap
- Services repo: https://github.com/cowprotocol/services
- Composable orders: https://github.com/cowprotocol/composable-cow
- CoW SDK: https://github.com/cowprotocol/cow-sdk
- Gnosis Chain CoW deploy guide: https://docs.gnosischain.com/technicalguides/DeFi/Deploy%20A%20Cow%20Swap%20Widget
- Aleph Cloud compute: https://aleph.cloud/computing
- Brief: `~/Desktop/cowswap_fork_dev_brief.md`
