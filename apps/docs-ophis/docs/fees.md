---
id: fees
title: Fees & rebates
description: Ophis charges on price improvement only, 0% on ordinary trades, 25% of any execution that beats your quote, capped at 0.5% of volume.
sidebar_label: Fees & rebates
sidebar_position: 3
---

# Fees & rebates

Ophis charges a fee on **price improvement only**, the difference
between the quote you were shown and the price a solver actually
delivered. On trades that don't beat the quote, the fee is **0%**. There
is no flat protocol fee.

## The formula

```
partnerFee = 25% × max(executedOut − quotedOut, 0)
             capped at 0.5% × tradeVolume
```

- **0% fee** on every trade that fills at the quoted rate.
- **25% of the improvement** when execution beats the quote.
- **Hard cap at 0.5%** of nominal trade volume, this protects large
  trades from paying an outsized fee on chunky positive slippage.

## A worked example

Say you ask to swap 1,000 USDC for ETH and Ophis quotes you **0.30 ETH**.
Solvers compete, and the winning solver actually delivers **0.303 ETH**:

| | Amount |
| --- | --- |
| Quoted output | 0.300 ETH |
| Executed output | 0.303 ETH |
| Price improvement | 0.003 ETH |
| Fee (25% of improvement) | 0.00075 ETH |
| **You receive** | **0.30225 ETH** |

You still come out **ahead of the quote you accepted**, the fee only
ever takes a share of the _extra_ a solver finds, never your principal.
If the solver had only matched the 0.30 ETH quote, the fee would be 0.

## How it's collected

The fee is implemented via the CoW Protocol **CIP-75** partner-fee model
(the `priceImprovementBps` field in the order's `appData`). It is taken
from the trade output at settlement and routed to the Ophis multisig
weekly. Of the partner share, a 25% service fee is retained by the
underlying protocol, so Ophis nets roughly **18.75% of price
improvement** after that. The fee is collected on Ophis-operated chains
(currently live on Optimism); on CoW-hosted chains Ophis uses CoW's
infrastructure and adds no partner fee.

For the full protocol-level details, see the governance proposal
[CIP-75. Partner incentive alignment](https://forum.cow.fi/t/cip-75-partner-incentive-alignment/3253).

:::note[Positive-slippage rebates]

Because the fee is capped and applies only to improvement, ordinary
trades stay free. Traders accrue the upside of solver competition as
positive-slippage rebates, track them in the app's **Earn** and
**Profile** surfaces.

:::

## Custody of fees

Partner fees accrue to a Gnosis Safe multisig (`0x858f…CeF8`), deployed
deterministically to the same address on every supported chain. See
[Security & audits](./audits.md) for the custody model.
