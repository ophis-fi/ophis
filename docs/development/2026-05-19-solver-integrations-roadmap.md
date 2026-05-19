# Solver integrations roadmap (task J / 5.3 / 5.4)

**Date:** 2026-05-19
**Scope:** What solvers Ophis runs today, what's available via the fork, what's worth adding.

## Today (live on OP mainnet)

| Solver | Type | Status |
|---|---|---|
| `baseline` | In-house AMM router (UniV2/V3-shape; reads pool state) | Healthy, default fallback |
| `kyberswap` | Aggregator API (KyberSwap META Aggregator) | Healthy, multi-source routes |
| `okx` | Aggregator API (OKX OnchainOS DEX) | Healthy, custodian-grade routes |
| `velora` | Aggregator API (formerly ParaSwap) | Healthy, Augustus V6.2 routes |

All in `apps/backend/crates/solvers/src/infra/dex/`. `bitget` directory exists but is **not currently configured** in OP — check `infra/optimism-mainnet/configs/`.

## Available in the fork (not currently configured)

| Source | Where | Type | Effort to enable |
|---|---|---|---|
| `bitget` | `apps/backend/crates/solvers/src/infra/dex/bitget/` | Aggregator API | T — add config block + restart. Verify Bitget supports OP. |
| Legacy AMM readers | `apps/backend/crates/solver/src/liquidity/` | UniV2/V3 + Balancer V2 + ZeroEX (legacy adapters) | Already used by the `baseline` solver |
| ZeroEX | `apps/backend/crates/solver/src/liquidity/zeroex.rs` | Aggregator (legacy adapter) | Worth checking if this works as a standalone solver via the `solvers` crate, or if it's just liquidity-source level |

## Upstream gap analysis

Looking at https://github.com/cowprotocol/services — what's NOT in our fork:

| Solver | Upstream status | Worth adding? |
|---|---|---|
| **1inch** | Not implemented in upstream `services` repo as a standalone solver (1inch runs their own competing service) | **No** — 1inch is a CoW competitor, not a partner. They wouldn't expose their aggregator API to a CoW-shaped solver. |
| **0x** | Legacy adapter at `solver/src/liquidity/zeroex.rs` | **Maybe** — already in fork, could promote to standalone solver. The 0x V2 API has good routes; would compete with KyberSwap/Velora on multi-source. |
| **ParaSwap (V5 legacy)** | We have V6 (Velora) which superseded V5 | **No** — Velora is the V6 successor. Adding V5 would be a downgrade. |
| **Hashflow** | Not in upstream | **Probably not** — RFQ-style. CoW's MEV-protection model already covers similar ground. |
| **Curve** | AMM-readable; the `baseline` solver handles UniV3-shape but not Curve's bonding curves | **Yes if stablecoin volume matters** — Curve specializes in stablepool routes (USDC/USDT/DAI). At Ophis's revenue model (CIP-75 rebates on volume), stablecoin volume × narrow spread = decent rebate income if the routes win |
| **Balancer V2** | `solver/src/liquidity/balancer_v2.rs` (legacy) | Already integrated as a liquidity source. Standalone solver would need promotion. T-S |
| **Native PMM (RFQ)** | Not in upstream | **No** — out of scope; competes with our own MEV protection |

## Recommended additions, ranked

### 1. Promote `0x` to standalone solver (S)

Has the most ready code (`solver/src/liquidity/zeroex.rs` is a working adapter). Promote to a fourth aggregator solver in `crates/solvers/src/infra/dex/`. Configure on OP. Expect 5-15% of route wins vs current 3-solver competition (rough guess; needs A/B in production).

### 2. Curve adapter (M)

Net-new code. Curve's StableSwap math is well-documented. Pool readers exist in open-source Rust (e.g., `curve-rs`). Useful specifically for stablecoin-pair flow which our current 3 aggregators don't always optimize for. Volume share at Ophis scale: TBD.

### 3. Enable `bitget` on OP (T)

Already in the crate. Just needs a config block in `infra/optimism-mainnet/configs/driver.toml` to wire it up. **Verify Bitget supports Optimism mainnet first** — their aggregator API has per-chain availability.

## What NOT to do

- **Don't write a 1inch adapter.** 1inch is a CoW competitor and has no incentive to expose routes to us.
- **Don't write Hashflow.** RFQ-style PMMs duplicate value CoW already captures.
- **Don't downgrade to ParaSwap V5.** Velora (V6) supersedes it.

## Action items

If you want to ship one of these:

| Action | Size | Priority |
|---|---|---|
| Enable `bitget` on OP (config-only PR) | T | Low |
| Promote `0x` to standalone solver | S | Medium |
| Curve adapter | M | High *if* stablecoin volume matters for the revenue model |

No code written in this task — pure inventory + recommendation. Hand-off the call on Curve to a future feature-prioritization session.
