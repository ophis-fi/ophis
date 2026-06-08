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
- Solver competition still works in your favour: solvers compete to beat the
  quote you were shown, and any improvement they find flows back to you.

## A worked example

Say you swap **1,000 USDC** for ETH. The flat fee is **0.10% of the trade
volume**:

| | Amount |
| --- | --- |
| Trade volume | 1,000 USDC |
| Fee rate | 0.10% (10 bps) |
| Ophis fee | 1 USDC |

The fee is **0.10% of the 1,000 USDC traded**, so on a 1,000 USDC swap the fee is
**1 USDC**. The same 0.10% rate applies to every trade, no matter the size.

Stablecoin-to-stablecoin swaps get the reduced rate: a 1,000 USDC to USDT
stablecoin swap pays 0.01% = **0.10 USDC**.

## How it's collected

The fee uses CoW Protocol's partner-fee model: `volumeBps: 10` (0.10% of trade
volume), written into the order's `appData` and taken from the trade output at
settlement.

For the protocol-level details, see
[CoW Protocol partner fees](https://docs.cow.fi/cow-protocol/reference/core/intro-to-batch-auctions).

:::note[Positive-slippage rebates]

A large share of the fee flows back to traders through volume-tier rebates. Each
month, **50% of the WETH fees accrued to the Ophis fee Safe** is paid out as
rebates, split across active wallets in proportion to their **30-day volume
weighted by tier**:

| Tier | 30-day volume | Weight |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

Wallets below $20,000 of 30-day volume are unranked and do not share in the rebate
pool. A higher tier raises your weight in the split, so more volume earns a larger
share of the pool. The pool is the WETH the fee Safe holds; fees collected in other
tokens are not currently part of it. Your current tier is shown on the swap page.

:::
