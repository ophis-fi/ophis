---
id: fees
title: Fees & rebates
description: Every supported chain charges a 1 bp Ophis base plus capped price-improvement capture; hosted chains also have separate upstream CoW fees.
sidebar_label: Fees & rebates
sidebar_position: 3
---

# Fees & rebates

Every supported chain pays a **1 bp Ophis base fee**. On every chain,
Ophis also retains **80% of price improvement on volatile pairs,
capped at 99 bps of volume**, or **50% on stablecoin pairs, capped at 20 bps**.
On CoW-hosted chains, CoW Protocol applies its own upstream fee policy separately.

What you pay **all-in** depends on where the order settles, so here is the
complete number per chain type, with nothing left out:

## The all-in cost, per chain

| | Ophis-operated chains (Optimism, Unichain, Robinhood Chain) | CoW-hosted chains (the other 10) |
| --- | --- | --- |
| Ophis fee | 0.01% base + 80% of price improvement (50% stables), capped at 0.99% (0.20% stables) | Same Ophis policy: 0.01% base + capped improvement capture |
| Upstream protocol fee | **None** | CoW Protocol volume fee: 0.02% (0.003% on correlated pairs such as stablecoins) |
| **All-in fixed cost** | **0.01%** | **0.03% volatile / 0.013% correlated stables** |
| Price improvement | Trader receives the remainder after Ophis's capped capture; all improvement above the cap returns to the trader | Ophis's capped capture applies, and CoW Protocol's upstream improvement policy applies separately |

Why the difference: on the 10 CoW-hosted chains, orders settle through CoW
Protocol's hosted orderbook and solver network, which charges its own
[protocol fees](https://docs.cow.fi/governance/fees) on top of the Ophis fee.
On **Optimism, Unichain, and Robinhood Chain**, Ophis operates the entire stack itself
(settlement contracts, orderbook, solvers), so there is no upstream fee. The 1
bp base and capped price-improvement policy are the complete
Ophis charge.

## How it works

- A **1 bp base fee** is applied on Ophis-operated chains.
- Volatile pairs add 80% of reference-quote improvement, capped at 99 bps.
- Stablecoin pairs add 50% of reference-quote improvement, capped at 20 bps.
- A **1 bp base fee** is applied on every supported chain.
- On CoW-hosted chains, the upstream CoW Protocol fees in the table above are
  charged in addition; Ophis does not receive them.

## Price-improvement capture on every supported chain

Solvers compete to fill your order, and any execution that beats the quote you
signed (the **surplus**, or price improvement) is upside you did not have to
pay for. You see it on the order completion screen as the extra you received
beyond the quote.

The capture is measured against the backend's reference quote, not against a
loose user slippage limit. For volatile pairs Ophis retains 80%, until the fee
reaches 99 bps of volume. For stablecoin pairs it retains 50%, until the fee
reaches 20 bps. The separate 1 bp base fee always applies.

Where the order settles still matters:

- **Optimism, Unichain, and Robinhood Chain:** the backend applies the capped
  capture model as a protocol policy.
- **CoW-hosted chains:** the same Ophis policy is encoded in CIP-75 appData.
  CoW Protocol's own fee model also applies upstream. That upstream charge is
  not an Ophis fee and applies to every frontend using CoW-hosted settlement.

## What you save versus a typical AMM

Ophis-operated chains use a 1 bp base plus capped reference-improvement capture,
so the realized charge depends on execution quality. CoW-hosted chains use the
same 1 bp Ophis base plus CoW Protocol's separate upstream fees.

### Flat-rate comparison (CoW-hosted volatile path)

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis base (0.01%) | You save | Ophis + CoW fixed fees (0.03%) | You save |
| --- | --- | --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$1** | **$24 to $29** | $3 | $22 to $27 |
| $100,000 | $250 | $300 | **$10** | **$240 to $290** | $30 | $220 to $270 |

### Same-chain stablecoin pair (e.g. USDC to USDT): 0.01% sovereign base

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis (0.01%) | You save | Ophis on CoW-hosted (0.013%) | You save |
| --- | --- | --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$1** | **$24 to $29** | $1.30 | $23.70 to $28.70 |
| $100,000 | $250 | $300 | **$10** | **$240 to $290** | $13 | $237 to $287 |

The table isolates the fixed base so it can be compared with AMM fees. On
Optimism, Unichain, and Robinhood Chain, the realized charge also includes 50%
of reference-quote improvement, capped at 20 bps of volume; the trader receives
the remainder and all improvement above the cap. On CoW-hosted chains, the
fixed and improvement charges in the all-in table above apply.

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
the returned **surplus** on top of every figure above: the rebate is a refund
of fee, the savings table is fee you never paid, and the surplus is upside the
solver found for you after the applicable capped Ophis capture on operated
chains or upstream CoW capture on hosted chains.

## How it's collected

The fee uses CoW Protocol's partner-fee model. The Ophis swap app and SDK write
the 1 bp base on every supported chain. On hosted chains they also write a
pair-aware `priceImprovementBps` entry with a hard `maxVolumeBps` cap; operated
chains apply that second component in the backend instead to avoid duplication.

On the **Ophis-operated stacks (Optimism, Unichain, Robinhood Chain)**, the backend also enforces
an **anti-abuse minimum** at settlement, so a fee is guaranteed on chain rather
than relying on the frontend: it rejects any order to the Ophis fee recipient
whose partner fee falls below **1 bp**. This exists to reject a zero-fee bypass.
On CoW-hosted chains no sovereign floor is
enforced, the same `appData` rate applies (validated by CoW's backend), and CoW's
protocol fees (see the all-in table above) are charged by CoW on top.

For the protocol-level details, see
[CoW Protocol batch auctions](https://docs.cow.fi/cow-protocol/reference/core/auctions).

:::note

The rebate pool is the **WETH** the fee Safe holds; fees collected in other
tokens are not currently part of it. Want to earn on trades you refer? See the
[Affiliate program](./affiliate.md): share a code and earn a share of the net
fee Ophis keeps on every trade your referrals route.

:::
