---
id: fees
title: Fees & rebates
description: Ophis charges nothing on ordinary trades, and 25% of price improvement (capped at 0.5% of volume) only when a solver beats your quote. Your principal is never touched.
sidebar_label: Fees & rebates
sidebar_position: 3
---

# Fees & rebates

Ophis charges a fee on **price improvement only**: the difference between the
quote you were shown and the price a solver actually delivered. On trades that
fill at the quoted rate, the fee is **0%**. There is no flat protocol fee, and
the fee never touches your principal.

## How it works

- **0% fee** on every trade that fills at the quoted rate.
- When a solver **beats your quote**, Ophis keeps **25% of the improvement**,
  hard-capped at **0.5% of the trade**, never a share of your principal.
- You always come out **ahead of the quote you accepted**: the fee applies only
  to that improvement, is capped, and never touches your principal.

## A worked example

Say you ask to swap 1,000 USDC for ETH and Ophis quotes you **0.30 ETH**.
Solvers compete, and the winning solver delivers **0.303 ETH**:

| | Amount |
| --- | --- |
| Quoted output | 0.300 ETH |
| Executed output | 0.303 ETH |
| Price improvement | 0.003 ETH |
| Ophis fee (25% of the improvement) | 0.00075 ETH |
| **You receive** | **0.30225 ETH** (above your 0.300 ETH quote) |

The fee is **25% of the 0.003 ETH a solver found**, never your principal, and it
can never exceed **0.5% of the trade**. If the solver had only matched the quote,
the fee would be 0.

## How it's collected

The fee uses CoW Protocol's **CIP-75** partner-fee model: `priceImprovementBps:
2500` (25% of the improvement) with `maxVolumeBps: 50` (the 0.5%-of-volume cap),
written into the order's `appData` and taken from the trade output at settlement.

For the protocol-level details, see
[CIP-75: Partner incentive alignment](https://forum.cow.fi/t/cip-75-partner-incentive-alignment/3253).

:::note[Positive-slippage rebates]

Because the fee applies only to improvement, ordinary trades stay free, and the
upside of solver competition flows back to traders. Each month, **50% of the fees
Ophis collects** is paid out as rebates, split across active wallets in proportion
to their **30-day volume weighted by tier**:

| Tier | 30-day volume | Weight |
| --- | --- | --- |
| Bronze | $0+ | 10% |
| Silver | $5,000+ | 20% |
| Gold | $50,000+ | 35% |
| Platinum | $500,000+ | 50% |

A higher tier raises your weight in the split, so more volume earns a larger share
of the pool. Your current tier is shown on the swap page.

:::
