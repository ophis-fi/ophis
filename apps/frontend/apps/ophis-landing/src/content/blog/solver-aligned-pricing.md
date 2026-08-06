---
title: "Ophis moves to solver-aligned pricing"
description: "A 1 bp base and capped price-improvement capture on Ophis-operated chains aligns protocol revenue with execution quality."
pubDate: 2026-08-05
author: Ophis
tags: [fees, solver-auctions, price-improvement, optimism]
draft: false
cover: ./solver-aligned-pricing.cover.png
coverAlt: "A gold serpent dividing an upward stream of price improvement across dark market contours"
---

Ophis is changing how it earns on the chains where it operates the orderbook,
solver auction, and settlement stack. Instead of charging retail users a fixed
10 basis points while returning every unit of price improvement, Ophis will
charge a **1 bp base fee** and earn primarily when execution beats the reference
quote.

On volatile pairs, Ophis retains **80% of price improvement, capped at 50 bps
of trade volume**. On same-chain stablecoin pairs, Ophis retains **50%, capped
at 20 bps**. The base remains 1 bp in both cases.

The change applies to Ophis-operated Optimism, Unichain, and Robinhood Chain.
CoW-hosted chains keep their existing flat Ophis fee path because their
upstream fee policy is controlled by CoW Protocol.

## Why change the model?

A flat fee rewards volume whether execution is ordinary or exceptional. The
new model connects most Ophis revenue to the outcome its solver network
produces: when execution does not improve on the reference quote, Ophis earns
only 1 bp; when solvers create measurable improvement, Ophis shares in it.

This produces a clearer operating incentive:

- improve routing and solver competition;
- increase the value produced per trade;
- grow sovereign-chain volume;
- earn more when users receive better execution.

It also lowers the predictable fixed charge from 10 bps to 1 bp on sovereign
chains. The variable component is bounded, so an unusually stale market or
large price move cannot create an unlimited fee.

## The exact schedule

| Pair | Base | Ophis share of improvement | Capture cap | Maximum Ophis charge |
| --- | ---: | ---: | ---: | ---: |
| Volatile | 1 bp | 80% | 50 bps of volume | 51 bps |
| Stablecoin | 1 bp | 50% | 20 bps of volume | 21 bps |

For a $100,000 volatile trade with 20 bps of reference-quote improvement, the
base is $10 and the improvement capture is $160, for $170 total. The trader
still receives the remaining $40 of improvement.

For a $100,000 stablecoin trade with the same 20 bps improvement, Ophis receives
$10 base plus $100 captured improvement. The 20 bps cap starts binding when
reference-quote improvement reaches 40 bps; improvement above it goes to the trader.

## Reference quote, not slippage tolerance

The calculation uses the backend reference quote. It does **not** measure from
the user's signed limit or treat loose slippage tolerance as protocol revenue.
That distinction matters: the fee should reflect execution Ophis created, not
room the trader allowed for safe settlement.

The reference quote, capture factor, and volume cap are applied by the Ophis
backend. A custom frontend or direct API client cannot remove the protocol
policy by omitting fee metadata.

## What remains unchanged

Orders remain self-custodial, gasless for ERC-20 swaps, MEV-protected through
batch settlement, and bounded by the signed limit price. Integrators can still
add an onboarded fee of their own, and Ophis continues to take 0% of that
integrator markup.

On CoW-hosted chains, the existing schedule remains:

- 10 bps for retail volatile flow;
- 5 bps for partner volatile flow;
- 1 bp for same-chain stablecoin pairs;
- CoW Protocol's upstream fees apply separately.

## A model designed to evolve

The initial caps are guardrails, not permanent ceilings. Ophis will measure the
volume-weighted distribution of reference-quote improvement, the share of trades
that hit each cap, and the revenue and volume response by pair type. As the
dataset grows, capture caps can be reviewed transparently.

The objective is straightforward: maximize sustainable protocol revenue by
making Ophis better at the work users route through it. See the canonical
[pricing page](/pricing/) and the complete [fee documentation](https://docs.ophis.fi/fees)
for the current terms.
