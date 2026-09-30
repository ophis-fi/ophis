---
id: fees
title: Fees & rebates
description: Ophis batch-auction fees, hosted upstream fees, bridge costs and weighted WETH rebates.
sidebar_label: Fees & rebates
sidebar_position: 3
---

# Fees & rebates

The standard batch-auction schedule has a **1 bp Ophis base fee**.
On eligible orders, Ophis also retains **80% of price improvement on volatile pairs,
capped at 99 bps of volume**, or **50% on stablecoin pairs, capped at 20 bps**.
On Optimism, Unichain, Robinhood Chain and Arc, this backend fee applies only
to **in-market orders**. Out-of-market limit orders pay the signed base without
this backend improvement fee.
On CoW-hosted chains, CoW Protocol applies its own upstream fee policy separately.

The table separates Ophis and upstream batch-auction fees. It is not a total
execution-cost estimate: gas, pool fees, price impact and bridge costs can also
affect the net amount. Check the final route quote before signing.

## The all-in cost, per chain

| | Ophis-operated chains (Optimism, Unichain, Robinhood Chain, Arc) | CoW-hosted chains (10) |
| --- | --- | --- |
| Ophis fee | 0.01% base + 80% of price improvement (50% stables), capped at 0.99% (0.20% stables) | Same Ophis policy: 0.01% base + capped improvement capture |
| Upstream protocol fee | **None** | CoW Protocol volume fee: 0.02% (0.003% on correlated pairs such as stablecoins) |
| **Base + upstream volume components** | **0.01%** | **0.03% volatile / 0.013% correlated stables** |
| Price improvement | Trader receives the remainder after Ophis's capped capture; all improvement above the cap returns to the trader | Ophis's capped capture applies, and CoW Protocol's upstream improvement policy applies separately |

Why the difference: on the 10 CoW-hosted chains, orders settle through CoW
Protocol's hosted orderbook and solver network, which charges its own
[protocol fees](https://docs.cow.fi/governance/fees) on top of the Ophis fee.
On **Optimism, Unichain, Robinhood Chain, and Arc**, Ophis operates the entire stack itself
(settlement contracts, orderbook, solvers), so there is no upstream fee. The 1
bp base and capped price-improvement policy are the complete
Ophis charge.

<span id="arc-release-exception" />

### Arc price-improvement policy

Arc uses the same backend policy for in-market orders as the other Ophis-operated
chains: **80% of reference-quote improvement capped at 99 bps**, or **50%
capped at 20 bps** for recognized stablecoin pairs, including USDC/EURC.
Eligibility follows the order's price relative to its reference quote, not the frontend's
market/limit label. An out-of-market limit order has no backend improvement fee.
The separate **1 bp base** remains in signed appData; clients must not duplicate
the backend improvement policy in appData.

Arc originally launched with an empty protocol-fee configuration. Historical
base-only executions remain recorded at their original fees; enabling the
standard policy does not recalculate past trades.

Arc settled trades are indexed for volume-tier and affiliate rebates under the
same eligibility rules. Use SDK v0.4.4 or later for Arc referral tags. This does
not enable an Arc own-fee payout guarantee.

## How it works

- Volatile pairs add 80% of reference-quote improvement, capped at 99 bps.
- Stablecoin pairs add 50% of reference-quote improvement, capped at 20 bps.
- A **1 bp base fee** is applied on every supported chain.
- On CoW-hosted chains, the upstream CoW Protocol fees in the table above are
  charged in addition; Ophis does not receive them.

## Standard price-improvement capture

Solvers compete to fill your order. **Price improvement** is measured against
the reference quote; **surplus** relative to your signed limit is a different
measure when that limit includes slippage. Neither is a guaranteed return.

The capture is measured against the backend's reference quote, not against a
loose user slippage limit. For volatile pairs Ophis retains 80%, until the fee
reaches 99 bps of volume. For stablecoin pairs it retains 50%, until the fee
reaches 20 bps. The separate 1 bp base fee always applies.

Where the order settles still matters:

- **Optimism, Unichain, Robinhood Chain, and Arc:** the backend applies the capped
  capture model to in-market orders as a protocol policy.
- **CoW-hosted chains:** the same Ophis policy is encoded in CIP-75 appData.
  CoW Protocol's own fee model also applies upstream. That upstream charge is
  not an Ophis fee and applies to every frontend using CoW-hosted settlement.

CoW applies protocol policies before partner policies, with iterative fee
calculation. Do not add their capture percentages as if both apply independently
to the original improvement. See [CoW's current fee policy](https://docs.cow.fi/governance/fees).

### Bridge and conversion routes

The NEAR Intents quote request includes a **3 bps Ophis app fee**, alongside
provider costs reflected in the quote. Direct Circle bridge and WBTC-conversion
routes are not batch-auction swaps and must not be priced using the table above.
Source approval/deposit, conversion and destination execution can require gas.
See [Networks & assets](./networks-assets.md) for route restrictions and recovery.

<span id="what-you-save-versus-a-typical-amm" />

## Comparing execution costs

Compare the final executable output for the same amount and token pair, including
wallet gas where applicable. An Ophis base fee is not a substitute for an AMM's
pool fee: a solver route can itself use that AMM and incur its liquidity costs.
Improvement capture and hosted protocol fees also affect the result. A lower
advertised base rate alone does not establish a saving over a direct swap.

## What you get back: monthly WETH rebates

Beyond the published trading charge, a share of collected WETH fees **comes back to active traders**.
Each month, **21.25% of the WETH fees collected by the Ophis fee Safe** is paid
out as rebates, split across active wallets in proportion to their **30-day
volume weighted by tier**.

| Tier | 30-day volume | Weight |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

A wallet's share is its `eligible 30-day volume × tier weight`, divided by the
sum of that value across every eligible wallet. For example, $100,000 of Gold
volume has a weighted value of $25,000. If the total weighted value is $250,000,
that wallet receives 10% of the pool: $1,000 equivalent from an illustrative
$10,000 WETH pool. Actual amounts depend on collected WETH and all participants;
this is not a promised payout.

Wallets below $20,000 of 30-day volume are unranked and do not share in the pool.
Your current tier and progress to the next one are shown on the swap page.
Rebates are separate from execution output. Neither a rebate nor positive
surplus is guaranteed, and a tier weight is not a refund percentage of your own fees.

## How it's collected

The fee uses CoW Protocol's partner-fee model. The Ophis swap app and SDK write
the 1 bp base on every supported chain. On hosted chains they also write a
pair-aware `priceImprovementBps` entry with a hard `maxVolumeBps` cap; operated
chains in the standard schedule apply that second component in the backend instead
to avoid duplication.

On the **SDK-supported Ophis stacks (Optimism, Unichain, Robinhood Chain, Arc)**, the backend also enforces
an **anti-abuse minimum** in backend order validation, rather than relying
only on frontend metadata: it rejects an order to the Ophis fee recipient
whose partner fee falls below **1 bp**. This rejects declared sub-floor fee entries; absent fee metadata does not
establish the same guarantee. It is not a Solidity minimum-fee invariant in the
settlement contract.
On CoW-hosted chains no sovereign floor is
enforced, the same `appData` rate applies (validated by CoW's backend), and CoW's
protocol fees (see the all-in table above) are charged by CoW on top.

For the protocol-level details, see
[CoW Protocol batch auctions](https://docs.cow.fi/cow-protocol/reference/core/auctions).

:::note

The rebate pool is the **WETH** the fee Safe holds; fees collected in other
tokens are not currently part of it. Want to earn on trades you refer? See the
[Affiliate program](./affiliate.md): share a code and earn a share of the
verified base fee Ophis keeps on every trade your referrals route.

:::
