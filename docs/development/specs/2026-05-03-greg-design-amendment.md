# Greg — Design Spec Amendment (2026-05-03)

> **Amends:** [`2026-05-02-greg-design.md`](2026-05-02-greg-design.md)
> **Trigger:** Phase 1 Stage 2 validation surfaced an architectural constraint that invalidates the original Phase 1 deployment shape.
> **Owner:** Clement (san-npm), CTO

This document records the strategic changes locked on 2026-05-03 after Phase 1's Stage 2 validation. The original spec stays canonical for everything not amended below.

---

## What changed and why

The original spec assumed Greg could self-host a CoW Protocol backend (orderbook + autopilot + driver + solver) on Gnosis Chain in Phase 1, with settlements "still riding CoW's existing Gnosis solver network." Phase 1 Stage 2 validation discovered:

1. **CoW solvers will not read from a private orderbook.** They poll `api.cow.fi`. A self-hosted Greg orderbook is invisible to them.
2. **CoW's `GPv2Settlement` contract uses a permissioned `AllowListAuthentication`** ([docs](https://docs.cow.fi/cow-protocol/reference/contracts/core)). Only solvers approved via CoW DAO governance can submit settlement transactions. Approval is a multi-week process (forum proposal → code review → DAO vote → bonded capital). No technical bypass.

The combination means **on any chain CoW is deployed to, Greg cannot self-host settlement without CoW DAO governance approval.** The original Phase 1 architecture is structurally infeasible for a no-budget bootstrap.

## Amended phase structure

Original phase plan (deprecated for the no-budget path):

```
Phase 0  Foundation
Phase 1  Self-hosted backend on Gnosis mainnet  ← infeasible without CoW DAO solver approval
Phase 2  E features / retail launch
Phase 3  DAO desk
Phase 4  B2B API / multi-chain
```

Amended phase plan (effective 2026-05-03):

```
Phase 0    Foundation                                  ✅ shipped
Phase 1    Vendored-stack validation (PARTIAL)         ✅ shipped — preserved as Phase 3 runtime
Phase 1.5  Partner-fee injection on CoW chains         ← next, May 4–10
Phase 2    Retail UX wedge (E features + embed widget) May 11–24
Phase 2.5  Public launch on CoW chains                 May 25–31
Phase 3    Chain-native fork-deploy on MegaETH         Jun 1–21
Phase 3.5  Treasury tier (T2 self-serve)               Jun 22–Jul 5
Phase 4    API tier (T3 self-serve, on-chain billing)  Jul 6–19
Phase 5+   Multi-chain expansion (zkSync, Linea, OP)   Aug+
```

## Amended monetisation model

Original model: 5bps partner fee on Greg's UI as primary revenue. Same as today's competitor benchmark assumption.

Competitor benchmarking (May 2026, all from official sources cited at bottom of [`docs/development/status/2026-05-02.md`](../status/2026-05-02.md)):

| Aggregator | User-facing fee on swap |
|---|---|
| 1inch / Velora / KyberSwap | **0 bps** for users |
| Uniswap UI | 0 bps since Dec 2025 (UNIfication removed the interface fee) |
| CowSwap (cow.fi) | ~5 bps protocol fee on volatile pairs (CoW DAO captures) |
| Matcha | ~10 bps Standard, up to 15 bps on 0x routes |

Charging users a partner fee on top of CoW's protocol fee makes Greg the most expensive aggregator in the market for retail. Updated model:

| Tier | What it is | Pricing |
|---|---|---|
| **Retail (T1)** | Free Greg.app — DCA, Safe app, MEV-proof receipts, embed widget | **0 bps** (acquisition channel) |
| **Treasury (T2 = formerly Phase 3 "DAO desk")** | Same UI, unlocks dashboards/batched approvals/CSV export when a Safe wallet connects with ≥2 signers | 5 bps per swap (transactional, no subscription) |
| **API (T3 = formerly Phase 4 "B2B API")** | `/developers` self-signup with API key; partner-fee `appData` injected automatically on routed orders | 5–10 bps per swap (transactional, on-chain billing only) |
| **Enterprise (T4)** | White-label + custom features | Custom (sales-led only when inbound pulls) |

All tiers use **on-chain partner-fee accrual** ([CoW partner-fee mechanism](https://docs.cow.fi/governance/fees/partner-fee)). CoW DAO disburses Greg's share weekly in WETH to a recipient address we control. **No Stripe, no invoices, no OFAC compliance work in scope.**

## Acquisition model: product-led growth (PLG)

Original spec was implicitly sales-led (DAO-by-DAO outreach, integrator pitches). Amended: PLG funnel.

```
Retail user (free, T1) ─organic─→ Treasury client (T2, self-serve) ─inbound─→ API integrator (T3, self-serve)
                                                                                ↓ rare
                                                                          Enterprise (T4, sales)
```

Acquisition channels (all free or near-free):

- **[Safe App store](https://app.safe.global/apps)** listing — Safe ecosystem holds tens of billions in TVL; one PR review puts Greg in front of every active treasury using Safe.
- **Public execution proofs on social** — weekly tweet with order UID + Etherscan link for big swaps Greg routed.
- **SEO** — own "ethereum DCA", "DAO treasury swap", "TWAP onchain", "recurring buy crypto" — niche intents incumbents do not target.
- **Embed widget** — drop-in DCA / TWAP component for yield protocols, DeFi blogs, Safe wallet plugins. Each embed = free distribution.
- **Open-source default** — GPL-3.0 forces this anyway. GitHub stars / forks → developer awareness → API tier signups.
- **Forum presence** — technical contributions on CoW forum, Safe forum, MegaETH forum, DAO governance forums. Reputation, not spam.

## Amended chain footprint

Original: Gnosis only in Phase 1, expand to Base / Arbitrum / Mainnet in Phase 4.

Amended:

- **Phase 1.5 → 2.5: All 10 CoW-supported chains via partner-fee injection.** [Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Linea, Plasma, Ink, Gnosis](https://docs.cow.fi/cow-protocol/reference/contracts/core). Bigger surface, faster, no new infra.
- **Phase 3: MegaETH first.** Chain ID 4326, mainnet live 2026-02-09 ([megaeth.com](https://www.megaeth.com/)). 100K TPS / 1–10ms blocks. Foundation reserve = 7.5% of supply, ecosystem grants accessible. No CoW deployment, no incumbent intent broker.
- **Phase 5+:** zkSync Era, Linea, Optimism, Mantle, Scroll, Monad — emerging EVM chains where CoW is not deployed.

## Amended risks register

New / elevated risks (additions to original spec § 9):

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **CoW DAO changes the partner-fee mechanism or fee split** | Med | High | Phase 3 MegaETH deployment removes single-vendor dependency. Stay close to CoW governance forum. |
| **MegaETH ecosystem fails to attract liquidity** | Med | High | Phase 1.5 → 2.5 revenue does not depend on MegaETH; we ship CoW-chain product first. Phase 3 is incremental, not load-bearing. |
| **MegaETH grant rejection** | Med | Low | Self-fund the deploy (~€50 in gas). Apply to other chains too (Linea, zkSync, Optimism RetroPGF). |
| **Operational responsibility for our own settlement contract** | Low | High | Phase 3 deploys CoW's audited bytecode unchanged. Risk surface = deploy-time configuration only. Document deploy runbook + emergency-pause + monitoring. |
| **PLG acquisition does not compound** | Med | High | Phase 2 quality bar must be high. If month-3 retail funnel is dead, fall back to outbound DAO sales for T2. |

Removed risks (the amended plan retires these):

- **Rust ramp-up cost** — already paid in Phase 1; team now familiar with `cowprotocol/services`.
- **CoW Gnosis solver depth too thin to settle our orders** — does not apply; we are not running our own solver on CoW's chains in the amended plan.
- **Aleph reliability for prod orderbook** — does not apply Phase 1.5–2.5 (we use Vercel for the frontend, no self-hosted orderbook). May reapply Phase 3 onward.

## Amended success metrics

| Phase | Metric | Target |
|---|---|---|
| 1.5 | Real swap settles via Greg.app with partner fee in `appData` | Order UID + tx hash recorded in `phase-1-5-validation.md` |
| 2 | DCA + Safe app + MEV receipts shipped, embed widget loadable | Demo URL + walkthrough video |
| 2.5 | Public launch — Show HN, Product Hunt, Safe app store | Live brand + 10 inbound retail users in first 24h |
| 3 | MegaETH deployment live — own settlement, settled real swap on chain ID 4326 | Tx hash on MegaETH explorer |
| 3.5 | First Treasury (T2) client | 1 DAO actively using Greg, partner fee accruing |
| 4 | First API (T3) integrator | 1 wallet/dApp routing through `/developers` API key |

## What this amendment does NOT change

- The frontend stays as the cowswap fork (vendored at SHA `0174f35e7…`).
- The vendored `cowprotocol/services` stack stays in `apps/backend/` — production runtime for Phase 3.
- `@greg/sdk` partner-fee defaults stay (chain Gnosis, 5 bps default, recipient placeholder).
- `@greg/rpc` Gnosis fallback transport stays.
- All Phase 0 work stays valid — repo, CI, agents, Vercel deploy, etc.
- GPL-3.0 license, private repo until public launch.
- Branch protocol: `main` for now; feature branches when CI maturity demands.

## Sources

- [CoW Protocol Partner Fee documentation](https://docs.cow.fi/governance/fees/partner-fee)
- [CoW Protocol Fees overview](https://docs.cow.fi/governance/fees)
- [CoW Protocol Core Contracts reference](https://docs.cow.fi/cow-protocol/reference/contracts/core)
- [CIP-74: volume-based fee proposal](https://forum.cow.fi/t/cip-74-align-solver-rewards-with-protocol-revenue-and-introduce-a-volume-based-fee/3234)
- [`cowprotocol/contracts` repository (settlement + authenticator source)](https://github.com/cowprotocol/contracts)
- [`cowprotocol/services` repository (vendored at SHA `0720b9bc1…`)](https://github.com/cowprotocol/services)
- [`cowprotocol/cow-sdk` repository (`@cowprotocol/app-data` partner-fee schema)](https://github.com/cowprotocol/cow-sdk)
- [MegaETH official site (mainnet, foundation reserve, ecosystem)](https://www.megaeth.com/)
- [MegaETH chain settings (chain ID 4326)](https://chainlist.org/chain/4326)
- [Safe App store (T1 → T2 acquisition channel)](https://app.safe.global/apps)
