---
title: "Ophis moves to solver-aligned pricing"
description: "A 1 bp base and capped price-improvement capture on Ophis-operated chains aligns protocol revenue with execution quality."
pubDate: 2026-08-05
updatedDate: 2026-10-04
author: Ophis
tags: [fees, solver-auctions, price-improvement, optimism]
draft: false
cover: ./solver-aligned-pricing.cover.png
coverAlt: "A gold serpent dividing an upward stream of price improvement across dark market contours"
---

Ophis charges a **1 bp base fee** plus capped reference-quote improvement.
On Ophis-operated chains, improvement capture applies to in-market orders;
CoW-hosted chains encode the Ophis policy in appData and add upstream fees.

On volatile pairs, Ophis retains **80% of price improvement, capped at 99 bps
of trade volume**. On same-chain stablecoin pairs, Ophis retains **50%, capped
at 20 bps**. The base remains 1 bp in both cases.

The standard policy applies to Optimism, Unichain, Robinhood Chain, Arc and the ten
CoW-hosted networks. Those four operated backends enforce it directly; CoW-hosted orders encode the same policy in
CIP-75 appData, with CoW Protocol's upstream fees applied separately.

**September 30 update:** Arc now uses the same backend market-order improvement
policy. Its original release omitted that policy; historical base-only trades
retain their original fees. See the [Arc fee details](https://docs.ophis.fi/fees#arc-price-improvement-policy).

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

It also sets the predictable Ophis fixed charge to 1 bp on every supported
chain. The operated-chain variable component is bounded, so an unusually stale market or
large price move cannot create an unlimited fee.

## The exact schedule

| Pair | Base | Ophis share of improvement | Capture cap | Maximum Ophis charge |
| --- | ---: | ---: | ---: | ---: |
| Volatile | 1 bp | 80% | 99 bps of volume | 100 bps |
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

On Optimism, Unichain, Robinhood Chain and Arc, the backend applies the reference quote, capture
factor and cap; omitting metadata does not remove that backend policy. On
CoW-hosted chains the Ophis policy is encoded in signed appData, alongside
CoW's upstream fees. Use the complete SDK fee helper output.

## What remains unchanged

Orders remain self-custodial, gasless for ERC-20 swaps, MEV-protected through
batch settlement, and bounded by the signed limit price. Integrators can still
add an onboarded fee of their own, and Ophis continues to take 0% of that
integrator markup.

On CoW-hosted chains, the same Ophis improvement policy is encoded in appData.
CoW Protocol's upstream fees apply separately and are not Ophis fees.

## Current terms

Review the final quote before signing. The [pricing page](/pricing/) and
[fee documentation](https://docs.ophis.fi/fees) describe the current base,
improvement caps, hosted upstream fees and separate bridge costs.
