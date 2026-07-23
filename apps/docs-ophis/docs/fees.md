---
id: fees
title: Fees & rebates
description: Ophis charges a flat 0.10% (10 bps) fee on trade volume, 0.01% on same-chain stablecoin pairs. On Optimism and Unichain that is the all-in cost and 100% of price improvement is returned; on CoW-hosted chains upstream CoW Protocol fees apply on top.
sidebar_label: Fees & rebates
sidebar_position: 3
---

# Fees & rebates

Ophis charges a **flat 0.10% (10 bps) fee on trade volume**. It applies to
**every trade**, regardless of how the order fills. Same-chain
stablecoin-to-stablecoin swaps pay a reduced **0.01% (1 bp)**.

What you pay **all-in** depends on where the order settles, so here is the
complete number per chain type, with nothing left out:

## The all-in cost, per chain

| | Ophis-operated chains (Optimism, Unichain) | CoW-hosted chains (the other 10) |
| --- | --- | --- |
| Ophis fee | 0.10% (0.01% stable pairs) | 0.10% (0.01% stable pairs) |
| Upstream protocol fee | **None** | CoW Protocol volume fee: 0.02% (0.003% on correlated pairs such as stablecoins) |
| **All-in fixed cost** | **0.10% / 0.01%** | **0.12% / 0.013%** |
| Price improvement (surplus) | **100% returned to you** | CoW Protocol retains 50% of quote improvement (capped at 0.98% of volume); the rest is returned to you |

Why the difference: on the 10 CoW-hosted chains, orders settle through CoW
Protocol's hosted orderbook and solver network, which charges its own
[protocol fees](https://docs.cow.fi/governance/fees) on top of the Ophis fee.
On **Optimism and Unichain**, Ophis operates the entire stack itself
(settlement contracts, orderbook, solvers), so there is no upstream fee and no
improvement capture: the flat Ophis fee is the whole cost, and every basis
point a solver wins beyond your quote is yours.

## How it works

- A **flat 0.10% (10 bps) fee** is applied to the volume of every trade.
- **Stablecoin-to-stablecoin swaps pay a reduced 0.01% (1 bp).** This applies
  when both tokens are stablecoins and the swap stays on the same chain.
- The fee is a fixed share of the trade amount, so it scales directly with the
  size of your swap and is the same on every order.
- On CoW-hosted chains, the upstream CoW Protocol fees in the table above are
  charged in addition; Ophis does not receive them.

## Surplus: Ophis takes no cut, anywhere

Solvers compete to fill your order, and any execution that beats the quote you
signed (the **surplus**, or price improvement) is upside you did not have to
pay for. You see it on the order completion screen as the extra you received
beyond the quote.

**Ophis itself never takes a share of your surplus on any chain.** The Ophis
fee is a flat charge on volume; a surplus-based or price-improvement fee would
skim a cut of that upside, and Ophis does not.

Where the order settles still matters:

- **Optimism and Unichain:** 100% of the price improvement is returned to you.
- **CoW-hosted chains:** CoW Protocol's own fee model retains 50% of the quote
  improvement (capped at 0.98% of volume) before the remainder is returned to
  you. That is an upstream protocol fee, not an Ophis fee, and it applies to
  every front-end that settles through CoW's hosted infrastructure, including
  CoW Swap itself.

## What you save versus a typical AMM

A typical DEX or aggregator charges an interface fee of **0.25% to 0.30%** on
most swaps. Ophis charges **0.10% (10 bps)** on volatile pairs and **0.01%
(1 bp)** on same-chain stablecoin pairs. The tables below are the all-in rate on
**Optimism and Unichain**; on the CoW-hosted chains, use the all-in there
(0.12% volatile / 0.013% stables) in the Ophis column, and the gap is still what
you keep on every trade.

### Volatile pair (e.g. USDC to ETH), on Optimism / Unichain: 0.10% all-in

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis (0.10%) | You save | Ophis on CoW-hosted (0.12%) | You save |
| --- | --- | --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$10** | **$15 to $20** | $12 | $13 to $18 |
| $100,000 | $250 | $300 | **$100** | **$150 to $200** | $120 | $130 to $180 |

### Same-chain stablecoin pair (e.g. USDC to USDT), on Optimism / Unichain: 0.01% all-in

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis (0.01%) | You save | Ophis on CoW-hosted (0.013%) | You save |
| --- | --- | --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$1** | **$24 to $29** | $1.30 | $23.70 to $28.70 |
| $100,000 | $250 | $300 | **$10** | **$240 to $290** | $13 | $237 to $287 |

The same flat rate applies to every trade, no matter the size, so the savings
scale directly with your volume. On Optimism and Unichain, add the full price
improvement a solver wins on top of these numbers; on CoW-hosted chains, add
the post-capture remainder (see the all-in table above).

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
the returned **surplus** on top of every figure above: the rebate is a refund
of fee, the savings table is fee you never paid, and the surplus is upside the
solver found for you (returned 100% on Optimism and Unichain, post-capture on
CoW-hosted chains).

## How it's collected

The fee uses CoW Protocol's partner-fee model: a `volumeBps` value written into
the order's `appData` and taken from the trade output at settlement. The Ophis
swap app writes `10` (0.10%) retail; the `@ophis/sdk` partner path writes `5`
(0.05%), or `1` on same-chain stablecoin pairs.

On the **Ophis-operated stacks (Optimism, Unichain)**, the backend also enforces
an **anti-abuse minimum** at settlement, so a fee is guaranteed on chain rather
than relying on the frontend: it rejects any order to the Ophis fee recipient
whose partner fee falls below **4 bps** on a non-stable pair (or **1 bp** on a
same-chain stablecoin pair). That floor sits below both the 5 bps partner rate
and the 10 bps retail rate, so a normal SDK or app order clears it with room; it
exists only to reject a fee set implausibly low. On CoW-hosted chains no floor is
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
