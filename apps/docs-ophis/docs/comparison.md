---
id: comparison
title: How Ophis compares
description: A decision guide comparing the Ophis interface to other intent-based swap front-ends and aggregators (CoW Swap, Matcha, Velora), covering settlement, cross-chain scope, the fee model, and agent access.
sidebar_label: How Ophis compares
---

# How Ophis compares

This page is a decision guide, not a sales pitch. It explains what an
intent-based swap is, what Ophis shares with CoW Swap, and where the four
front-ends below genuinely diverge so you can pick the right one for your trade.

## What "intent-based" means

A traditional DEX swap is a transaction: you pick a route, sign it, and broadcast
it yourself. An **intent-based** swap is different. You sign a statement of what
you want ("sell 1,000 USDC, receive at least X ETH"), and a competitive network
of **solvers** races to fill it. You never specify the path; you specify the
outcome, and the order only settles if a solver meets or beats the price you
signed.

Those orders are then cleared in **batch auctions**. Instead of each trade hitting
the chain alone, many orders settle together at a uniform clearing price. This is
what gives the model its **MEV protection**: there is no public pending transaction
for a bot to front-run or sandwich, and orders inside a batch can be matched
directly against each other (coincidence of wants) before any pool is touched.

## Ophis is built on CoW Protocol

Ophis is a fork of the **CoW Protocol** stack. The settlement contracts, the
batch-auction mechanism, the MEV protection, and the non-custodial design are
**shared with CoW Swap**, not reinvented. Funds move only when a solver settles
the batch, and the on-chain `GPv2Settlement` contract code is unchanged.

That matters for how you read the rest of this page: execution quality, MEV
protection, and custody are on par with CoW Swap **because they are the same
foundation**. The differentiation lives one layer up, in the **interface and the
API**. The comparisons below are about that layer.

## Core differences

### Natural-language input vs token-picker

CoW Swap, Matcha, and Velora all drive trades through a token-picker UI: choose a
sell token, choose a buy token, choose a chain, set an amount. Ophis adds a
natural-language front door. You type "swap 100 USDC for ETH on Base" and a parser
turns the sentence into a structured order, which is then signed and settled
through the same batch auction. The token-picker still exists underneath; the
sentence is an additional way in, and it is the path the agent API uses too.

### Cross-chain scope

This is where the four front-ends differ most concretely:

- **Ophis**: 13 EVM chains as source or destination, plus **Solana** and
  **Bitcoin** as cross-chain destinations.
- **CoW Swap**: EVM chains plus **Solana** as a destination. No Bitcoin.
- **Matcha**: EVM chains plus **Solana**.
- **Velora**: **EVM only**.

Ophis and CoW Swap reach non-EVM destinations through **NEAR Intents**, a
non-custodial cross-chain settlement layer. The practical point for a trader: you
do not open a second wallet or hand custody to a bridge. You sign once on the
source chain, and NEAR Intents brokers delivery to the Solana or Bitcoin address
you named. Bitcoin as a destination is, among these four, unique to Ophis.

### Fee transparency

The four projects price trades on different models:

- **Ophis**: on every supported chain, a **1 bp base** plus 80% of
  reference-quote improvement on volatile pairs (99 bps cap), or 50% on stable
  pairs (20 bps cap). On the 10 CoW-hosted chains, CoW Protocol's own fees apply
  on top (a 0.02% protocol volume fee, 0.003% on correlated pairs, plus 50% of
  any quote improvement, capped at 0.98% of volume), bringing the fixed all-in
  to **0.03% / 0.013%** there. The fixed part is knowable before you trade.
- **CoW Swap**: a **0.02% (2 bps)** protocol volume fee (0.003% on correlated
  pairs) plus **50% of the quote improvement** a solver finds beyond your
  quote (capped at 0.98% of volume), so part of the cost depends on how the
  batch fills.
- **Matcha**: a **tiered** model, roughly **0.25%** on most pairs and **0.05%**
  on stablecoin pairs.
- **Velora**: a **15 bps (0.15%)** interface fee on most swaps, with a reduced
  **1 bp (0.01%)** on stablecoin pairs.

A worked comparison on a **1,000 USDC** trade (non-stablecoin output, e.g. to ETH)
makes the structure visible:

| Front-end | Fixed fee on 1,000 USDC | Improvement (surplus) split |
| --- | --- | --- |
| Ophis-operated chain, volatile pair | **0.10 USDC** base (0.01%) | Trader receives 20% until Ophis's 99 bps capture cap binds; all improvement above the cap goes to the trader |
| Ophis on CoW-hosted chains | **1.20 USDC** (0.12% all-in) | 50% of quote improvement retained upstream by CoW Protocol |
| CoW Swap | **0.20 USDC** (0.02%) | 50% of quote improvement retained by CoW Protocol |
| Matcha | **2.50 USDC** (0.25%) | Positive slippage, route-dependent |
| Velora | **1.50 USDC** (0.15%) | Positive slippage, route-dependent |

On a same-chain stablecoin-to-stablecoin swap of 1,000 USDC, Ophis charges a
**0.10 USDC** (0.01%) base on Optimism, Unichain, and Robinhood Chain, plus 50%
of reference-quote improvement capped at 1.00 USDC. It charges **0.13 USDC** fixed all-in on
CoW-hosted chains, Matcha **0.50 USDC** (0.05%), and Velora **0.10 USDC**
(0.01%). The takeaway is not that one number is always lowest. It is that the
Ophis fee schedule is **published per chain**: solver-aligned and capped on
Ophis-operated chains, flat before upstream CoW fees on hosted chains.

### Where the surplus goes

Both Ophis and CoW Swap run batch auctions where solvers compete to **beat** the
price you signed. The extra value a solver finds beyond your quote is the
**surplus** (price improvement).

Where the order settles determines how improvement is shared:

- On **Optimism, Unichain, and Robinhood Chain**, Ophis retains **80% of
  reference-quote improvement on volatile pairs, capped at 99 bps of volume**,
  or **50% on stable pairs, capped at 20 bps**. The trader receives the
  remainder and all improvement above the applicable cap.
- On the **10 CoW-hosted chains**, CoW Protocol's fee model retains **50% of
  the quote improvement** (capped at 0.98% of volume) before the remainder is
  returned. That upstream capture applies equally to CoW Swap itself and to
  every front-end settling through CoW's hosted infrastructure, Ophis
  included. Ophis adds no second improvement charge on these hosted chains.

### Agent-first API

Every front-end here exposes some programmatic surface, but they target different
callers. CoW Swap and Velora publish **orderbook / REST** APIs and SDKs aimed at
integrators wiring up an order flow. Matcha exposes the **0x Swap API**. Ophis is
built for agents: a **public `POST /api/intent` endpoint** that takes a
natural-language sentence and returns a structured order **with no API key**, plus
a hosted **MCP server** so an LLM agent can discover and call the swap surface as a
tool. The same sentence a person types is the same sentence an agent posts.

## Where each excels

- **CoW Swap**: the most mature production solver network and the deepest
  liquidity reach across EVM chains. If solver-network maturity is your first
  priority, this is the reference implementation.
- **Matcha**: the broadest EVM chain coverage of the four.
- **Velora**: competitive low fees, especially the **1 bp** stablecoin rate.
- **Ophis**: natural-language input, **Bitcoin** as a destination, a flat and
  predictable fee, and an agent-first API. It is the option built for
  English-in / order-out and for autonomous agents.

## Trade-offs, stated plainly

Ophis runs its **own solver and orderbook on Optimism, Unichain, and Robinhood Chain**, where its stack is
self-hosted; on the other chains it surfaces, it relies on CoW's hosted
infrastructure and solver network. CoW's production solver network is **more
mature and more battle-tested** than the Optimism-focused stack Ophis operates
directly. If you are trading large size on a chain where you want the deepest,
most-proven solver competition, CoW Swap is the more conservative pick. Ophis's
advantage is the interface and API layer described above, on top of the shared
settlement foundation.

## Reference table

| | **Ophis** | **CoW Swap** | **Matcha** (0x) | **Velora** (ex-ParaSwap) |
| --- | --- | --- | --- | --- |
| **How you trade** | Natural language, e.g. "swap 100 USDC for ETH on Base" | Token picker (signed intents) | Token picker | Token picker |
| **Settlement** | CoW Protocol batch auctions (shared foundation) | CoW Protocol batch auctions | 0x aggregation / RFQ | Aggregation across DEXs |
| **Cross-chain scope** | 13 EVM chains + Solana + Bitcoin (via NEAR Intents) | EVM + Solana (via NEAR Intents); no Bitcoin | EVM + Solana | EVM only |
| **Fee model** | Every supported chain: 1 bp Ophis base + 80% of volatile improvement (99 bps cap), or 50% of stable improvement (20 bps cap); hosted chains additionally pay upstream CoW fees | 0.02% protocol volume fee (0.003% correlated) + 50% of quote improvement, capped at 0.98% of volume | Tiered: ~0.25% on most pairs, ~0.05% on stablecoin pairs | 0.15% (15 bps) on most swaps; 0.01% (1 bp) on stablecoin pairs |
| **Surplus (price improvement)** | Trader receives the remainder after the capped Ophis capture on every chain; hosted chains additionally follow CoW's upstream policy | 50% of quote improvement retained (capped 0.98% of volume), remainder to the trader | Returned via positive slippage, route-dependent | Returned via positive slippage, route-dependent |
| **Agent API** | Public `POST /api/intent` (no key) + hosted MCP server | Orderbook REST API and SDK | 0x Swap API | REST API and SDK |
| **Rebates** | 21.25% of WETH fees paid back monthly as volume-tier rebates | Not applicable | Not applicable | Not applicable |
| **MEV protection** | Yes (batch auctions) | Yes (batch auctions) | Partial / route-dependent | Partial / route-dependent |

## Read next

- [Fees & rebates](./fees.md): the full fee model, stablecoin treatment, and how rebates accrue.
- [How it works](./architecture.md): the intent lifecycle, batch auctions, and per-chain settlement. Live service status is on the [Status](./status.md) page.
- [FAQ: How is Ophis different](./faq.mdx#how-is-ophis-different-from-1inch-or-matcha): the short version of this page.

:::note

Competitor fee and chain details reflect each project's public documentation as of
July 2026 and may change. The CoW-hosted all-in figures were additionally
verified against live production quotes (the quote API's `protocolFeeBps`
field) on 2026-07-03. Sources:
[CoW Protocol fees](https://docs.cow.fi/governance/fees),
[Matcha fees](https://help.matcha.xyz/en/articles/3953360-are-there-any-fees-to-make-a-trade),
[Velora UI fees](https://help.velora.xyz/en/articles/6554779-paraswap-ui-fees).

:::
