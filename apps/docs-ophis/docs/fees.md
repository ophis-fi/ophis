---
id: fees
title: Fees & rebates
description: Ophis charges a flat 0.10% (10 bps) fee on trade volume, applied to every trade. Stablecoin-to-stablecoin swaps pay a reduced 0.01% (1 bp).
sidebar_label: Fees & rebates
sidebar_position: 3
---

# Fees & rebates

Ophis charges a **flat 0.10% (10 bps) fee on trade volume**. It applies to
**every trade**, regardless of how the order fills.

## How it works

- A **flat 0.10% (10 bps) fee** is applied to the volume of every trade.
- **Stablecoin-to-stablecoin swaps pay a reduced 0.01% (1 bp).** This applies
  when both tokens are stablecoins and the swap stays on the same chain.
- The fee is a fixed share of the trade amount, so it scales directly with the
  size of your swap and is the same on every order.

## Surplus stays with you

Solvers compete to fill your order, and any execution that beats the quote you
signed (the **surplus**, or price improvement) is returned to you in full. You
see it on the order completion screen as the extra you received beyond the
quote.

Ophis charges a flat fee on volume and **takes no share of your surplus**. A
surplus-based or price-improvement fee would skim a cut of that upside; Ophis
does not. Your only cost is the flat volume fee, so every basis point a solver
wins beyond your quote is yours to keep.

## What you save versus a typical AMM

A typical DEX or aggregator charges an interface fee of **0.25% to 0.30%** on
most swaps. Ophis charges **0.10% (10 bps)** on volatile pairs and **0.01%
(1 bp)** on same-chain stablecoin pairs. The gap is what you keep on every trade.

### Volatile pair (e.g. USDC to ETH): 0.10% flat

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis (0.10%) | You save |
| --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$10** | **$15 to $20** |
| $100,000 | $250 | $300 | **$100** | **$150 to $200** |

### Same-chain stablecoin pair (e.g. USDC to USDT): 0.01% flat

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis (0.01%) | You save |
| --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$1** | **$24 to $29** |
| $100,000 | $250 | $300 | **$10** | **$240 to $290** |

The same flat rate applies to every trade, no matter the size, so the savings
scale directly with your volume. And because the fee is on volume, not surplus,
any price improvement a solver wins stays with you on top of these numbers.

## What you get back: monthly WETH rebates

Beyond the low flat fee, a large share of what you do pay **comes back to you**.
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

A higher tier raises your weight in the split, so the same volume earns a larger
share of the pool. To make it concrete, take an illustrative month where the
WETH rebate pool is worth **$10,000** and the active weighted total across all
ranked wallets sums to **100% in your slice of the split**. Your share scales
with your tier weight relative to that total. As a simple read of the weights:

| Your tier | 30-day volume | Tier weight | Illustrative monthly WETH rebate* |
| --- | --- | --- | --- |
| Bronze | $20,000 | 10% | ~$200 |
| Silver | $50,000 | 15% | ~$450 |
| Gold | $100,000 | 25% | ~$1,000 |
| Palladium | $500,000 | 35% | ~$3,500 |
| Platinum | $1,000,000 | 50% | ~$5,000 |

*Illustrative only. The actual rebate depends on the size of that month's WETH
pool and on the total weighted volume of every other ranked wallet sharing it,
so figures move month to month. The mechanics, not the dollar amounts, are what
is fixed: 21.25% of WETH fees, split by tier-weighted 30-day volume.

Wallets below $20,000 of 30-day volume are unranked and do not share in the pool.
Your current tier and progress to the next one are shown on the swap page. Add
**surplus stays with you** on top of every figure above: the rebate is a refund
of fee, the savings table is fee you never paid, and the surplus is upside the
solver found for you.

## How it's collected

The fee uses CoW Protocol's partner-fee model: `volumeBps: 10` (0.10% of trade
volume), written into the order's `appData` and taken from the trade output at
settlement.

On the **Optimism self-hosted stack**, this rate is an **enforced minimum at
settlement**, not just an interface default. The Ophis Optimism backend rejects
any order to the Ophis fee recipient whose partner fee is below the floor (10 bps,
or 1 bp for a same-chain stablecoin pair), so the rate is guaranteed on chain
rather than relying on the frontend. On CoW-hosted chains the same 10 bps / 1 bp
applies through the order's `appData`, validated by CoW's backend.

For the protocol-level details, see
[CoW Protocol batch auctions](https://docs.cow.fi/cow-protocol/reference/core/auctions).

:::note

The rebate pool is the **WETH** the fee Safe holds; fees collected in other
tokens are not currently part of it. Want to earn on trades you refer? See the
[Affiliate program](./affiliate.md): share a code and earn a share of the net
fee Ophis keeps on every trade your referrals route.

:::
