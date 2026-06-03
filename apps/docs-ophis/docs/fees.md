---
id: fees
title: Fees & rebates
description: Ophis charges nothing on ordinary trades, only a small, capped share of price improvement when a solver beats your quote. Your principal is never touched.
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
- When a solver **beats your quote**, Ophis keeps a **small, capped share of the
  improvement**, never a share of your principal.
- You always come out **ahead of the quote you accepted**. The exact fee for any
  given trade is shown in the order review before you sign.

## A worked example

Say you ask to swap 1,000 USDC for ETH and Ophis quotes you **0.30 ETH**.
Solvers compete, and the winning solver delivers **0.303 ETH**:

| | Amount |
| --- | --- |
| Quoted output | 0.300 ETH |
| Executed output | 0.303 ETH |
| **You receive** | **more than your 0.300 ETH quote** |

The fee only ever takes a share of the _extra_ a solver finds, never your
principal. If the solver had only matched the quote, the fee would be 0.

## How it's collected

The fee uses CoW Protocol's **CIP-75** partner-fee model (the
`priceImprovementBps` field in the order's `appData`), taken from the trade
output at settlement. It applies on Ophis-operated chains (currently live on
Optimism); on CoW-hosted chains Ophis adds no partner fee.

For the protocol-level details, see
[CIP-75: Partner incentive alignment](https://forum.cow.fi/t/cip-75-partner-incentive-alignment/3253).

:::note[Positive-slippage rebates]

Because the fee applies only to improvement, ordinary trades stay free. Traders
accrue the upside of solver competition as positive-slippage rebates, tracked
per wallet through the **rebate tier** shown in the app.

:::
