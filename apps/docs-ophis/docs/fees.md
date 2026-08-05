---
id: fees
title: Fees & rebates
description: Ophis-operated chains charge a 1 bp base plus a capped share of price improvement; CoW-hosted chains retain the existing flat-fee model and upstream CoW fees.
sidebar_label: Fees & rebates
sidebar_position: 3
---

# Fees & rebates

Ophis uses two fee models. On Ophis-operated chains, every trade pays a **1 bp
base fee**. Ophis also retains **80% of price improvement on volatile pairs,
capped at 30 bps of volume**, or **50% on stablecoin pairs, capped at 10 bps**.
On CoW-hosted chains, the existing flat 10 bps retail, 5 bps partner, and 1 bp
stablecoin rates remain in force because CoW controls the upstream fee policy.

What you pay **all-in** depends on where the order settles, so here is the
complete number per chain type, with nothing left out:

## The all-in cost, per chain

| | Ophis-operated chains (Optimism, Unichain, Robinhood Chain) | CoW-hosted chains (the other 10) |
| --- | --- | --- |
| Ophis fee | 0.01% base + 80% of price improvement (50% stables), capped at 0.30% (0.10% stables) | 0.10% retail / 0.05% partner / 0.01% stable pairs |
| Upstream protocol fee | **None** | CoW Protocol volume fee: 0.02% (0.003% on correlated pairs such as stablecoins) |
| **All-in fixed cost** | **0.01%** | **0.12% retail / 0.07% partner / 0.013% stables** |
| Price improvement | Trader receives 20% on volatile pairs or 50% on stable pairs until the cap; all improvement above the cap returns to the trader | CoW Protocol retains 50% of quote improvement (capped at 0.98% of volume); Ophis takes no additional share |

Why the difference: on the 10 CoW-hosted chains, orders settle through CoW
Protocol's hosted orderbook and solver network, which charges its own
[protocol fees](https://docs.cow.fi/governance/fees) on top of the Ophis fee.
On **Optimism, Unichain, and Robinhood Chain**, Ophis operates the entire stack itself
(settlement contracts, orderbook, solvers), so there is no upstream fee. The 1
bp base and capped price-improvement policy are the complete
Ophis charge.

## How it works

- A **1 bp base fee** is applied on Ophis-operated chains.
- Volatile pairs add 80% of reference-quote improvement, capped at 30 bps.
- Stablecoin pairs add 50% of reference-quote improvement, capped at 10 bps.
- On CoW-hosted chains, the upstream CoW Protocol fees in the table above are
  charged in addition; Ophis does not receive them.

## Price-improvement capture on Ophis-operated chains

Solvers compete to fill your order, and any execution that beats the quote you
signed (the **surplus**, or price improvement) is upside you did not have to
pay for. You see it on the order completion screen as the extra you received
beyond the quote.

The capture is measured against the backend's reference quote, not against a
loose user slippage limit. For volatile pairs Ophis retains 80%, until the fee
reaches 30 bps of volume. For stablecoin pairs it retains 50%, until the fee
reaches 10 bps. The separate 1 bp base fee always applies.

Where the order settles still matters:

- **Optimism, Unichain, and Robinhood Chain:** the new capped capture model applies.
- **CoW-hosted chains:** CoW Protocol's own fee model retains 50% of the quote
  improvement (capped at 0.98% of volume) before the remainder is returned to
  you. That is an upstream protocol fee, not an Ophis fee, and it applies to
  every front-end that settles through CoW's hosted infrastructure, including
  CoW Swap itself.

## What you save versus a typical AMM

Ophis-operated chains use a 1 bp base plus capped reference-improvement capture,
so the realized charge depends on execution quality. CoW-hosted chains retain
the flat 10 bps retail and 1 bp stablecoin rates described above. The historical
flat-rate tables below apply to the hosted path only; use the worked sovereign
examples above for Optimism, Unichain, and Robinhood Chain.

### Historical flat-rate comparison (CoW-hosted volatile path)

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis (0.10%) | You save | Ophis on CoW-hosted (0.12%) | You save |
| --- | --- | --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$10** | **$15 to $20** | $12 | $13 to $18 |
| $100,000 | $250 | $300 | **$100** | **$150 to $200** | $120 | $130 to $180 |

### Same-chain stablecoin pair (e.g. USDC to USDT): 0.01% sovereign base

| Trade size | AMM at 0.25% | AMM at 0.30% | Ophis (0.01%) | You save | Ophis on CoW-hosted (0.013%) | You save |
| --- | --- | --- | --- | --- | --- | --- |
| $10,000 | $25 | $30 | **$1** | **$24 to $29** | $1.30 | $23.70 to $28.70 |
| $100,000 | $250 | $300 | **$10** | **$240 to $290** | $13 | $237 to $287 |

The table isolates the fixed base so it can be compared with AMM fees. On
Optimism, Unichain, and Robinhood Chain, the realized charge also includes 50%
of reference-quote improvement, capped at 10 bps of volume; the trader receives
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

The fee uses CoW Protocol's partner-fee model: a `volumeBps` value written into
the order's `appData` and taken from the trade output at settlement. The Ophis
swap app and SDK write the 1 bp sovereign base. Hosted retail and partner paths
continue to write 10 bps and 5 bps respectively, or 1 bp on stable pairs.

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
