---
title: "MEV-protected swaps: how batch auctions mitigate sandwich attacks"
description: "Offchain orders and uniform clearing prices mitigate common MEV. Understand signed limits, public settlement exposure and the limits of batch-auction protection."
pubDate: 2026-07-09
updatedDate: 2026-09-28
author: Ophis
tags: [mev, batch-auctions, swaps, defi]
draft: false
cover: ./mev-protection-batch-auctions.cover.jpg
coverAlt: "Ophis multi-chain DEX aggregator emblem, MEV-protected batch settlement"
---

A sandwich attack exploits transaction visibility and ordering. Ophis submits
standard signed ERC-20 orders offchain and settles token pairs at uniform batch
prices. These mitigate common MEV; they do not remove every attack surface.
The solver's settlement can still be public and use external liquidity.

That is the short answer. The rest of this post walks through the attack
itself, how private submission and batch execution differ, and where their
protections stop.

## Anatomy of a sandwich attack

On a conventional DEX, a swap is a transaction you broadcast yourself. Before a
validator includes it in a block, it sits in the public mempool, visible to
anyone running a node. That waiting room is where the attack happens.

Say you submit a market buy with a 1% slippage tolerance. A searcher bot parses
your pending transaction, sees the pool you are about to trade against, and
executes three moves:

1. **Front-run.** It buys the same token first, with a higher priority fee or
   through a builder, pushing the pool price up.
2. **Your fill.** Your swap executes against the worse price. It still
   succeeds, because the damage fits inside your slippage tolerance.
3. **Back-run.** The bot sells immediately after you, capturing the price
   impact your trade just paid for.

Your slippage tolerance is not a safety margin in this game. It is the
attacker's budget: the maximum they can extract while your transaction still
confirms. And because the whole loop is automated, it does not hit unlucky
traders occasionally; it hits visible, orderable transactions systematically.

Two preconditions carry the entire attack: the searcher must **see** your trade
before it executes, and must be able to **position** transactions before and
after it. Remove either one and there is no sandwich.

## Hiding the transaction is mitigation, not removal

The common defense is RPC-level protection: wallets and apps send transactions
to a private RPC that forwards them to block builders directly instead of
broadcasting them to the public mempool. This attacks the first precondition,
visibility, and it does help.

But it is mitigation, not structural change. The trade is still the same
object: a market order that executes at whatever price the pool holds at
execution time, bounded only by a slippage tolerance, sitting at a specific
position in a block. The protection is operational. It depends on which RPC
your wallet actually uses, on every app in the path keeping that default, and
on the private channel staying private all the way to inclusion. If any hop
re-exposes the transaction, the original attack applies unchanged, because
nothing about the order's structure changed.

Batch execution changes the mechanism as well as the submission path, but
neither design makes every permitted fill risk-free.

## What a batch auction changes

Ophis, the intent-based DEX aggregator at ophis.fi, is a fork of CoW Protocol's
frontend and settles swaps through CoW Protocol's batch auction model. Three
properties of that design reduce common ordering advantages.

**Orders are signed intents, not mempool transactions.** You sign an EIP-712
order: sell token, buy token, amount, a hard limit price. The signed
order goes to an offchain orderbook, rather than becoming an individual public
router transaction. This does not hide the eventual settlement transaction.

**Solvers compete to fill the batch.** Open orders are collected into a batch,
and a network of competing solvers proposes settlements: which orders to fill,
against which liquidity, at what prices. The solver offering the best execution
wins the right to settle the batch on-chain, in a single transaction that the
solver, not you, submits. On most chains that settlement goes through CoW
Protocol's GPv2 contracts; on Optimism, Unichain, Robinhood Chain and Arc, Ophis
operates its own orderbook and settlement deployment derived from GPv2. Shared
foundations do not establish identical audit coverage or execution quality.

**One batch, one price.** Inside a batch, all orders trading the same token
pair clear at the same uniform clearing price. That reduces ordering advantages
inside the batch. External pool interactions can still be exposed to public
ordering and liquidity risks.

And underneath all of it sits your signed limit price: a solver cannot fill
your order below it. A fill can still be worse than the original reference
quote within the slippage-adjusted limit; otherwise the order remains unfilled.

## Surplus: the upside of solver competition

Solver competition can improve execution; it does not guarantee extra value. Your signed order carries
the minimum you will accept. When the winning solver finds better execution
than that, the difference above the signed limit is **surplus**. Improvement
over the reference quote is a separate measure when the limit includes slippage. Under the standard schedule, excluding Arc's current release exception, Ophis retains 80% of
reference-quote improvement on volatile pairs (99 bps cap) or 50% on stable
pairs (20 bps cap); the trader receives the remainder and everything above the
cap. On the ten chains that settle through CoW Protocol's canonical contracts,
CoW Protocol also applies upstream fees, before partner policies, with iterative
calculation. Check the current [CoW fee schedule](https://docs.cow.fi/governance/fees)
rather than assuming a fixed all-in percentage. The Ophis numbers live on the
[fees page](https://docs.ophis.fi/fees).

Net execution depends on liquidity, routing and applicable fee policies. Review
the final quote and minimum amount instead of assuming all improvement is yours.

## What "MEV protected" means at Ophis

MEV protection here means mechanism-level mitigation through offchain orders,
uniform prices per token pair and signed execution limits. It is not universal
sandwich immunity. Standard ERC-20 settlement gas is paid by the solver, but
approvals and other wallet transactions can still cost gas. Native-token orders
and bridges can require deposits with separate refund and recovery rules.

These properties matter double for automated traders. An agent that rebalances
on a schedule is a predictable, high-frequency target in a public mempool, and
it has no wallet pop-up where a human might catch a bad fill. That case is
covered in [how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/).
For how the intent model stacks up against other swap architectures, see the
[comparison page](https://docs.ophis.fi/comparison).

## FAQ

### Is MEV protection best-effort or structural?

Batch auctions provide mechanism-level mitigation, not an absolute guarantee.
Uniform clearing applies per token pair and signed limits are enforced, but the
solver's external-pool settlement can still be public and adversarial.

### What happens to my order if no solver fills it?

For an unfilled standard ERC-20 order, expiry leaves unsold funds in your wallet
without a settlement transaction from you. Check partial fills before replacing
an order. Native-token deposits and bridge routes have separate recovery rules.

### Do I pay gas?

The winning solver pays standard ERC-20 settlement gas. Approvals, native-token
placement, wrapping, hard cancellation, refunds and bridge transactions can
still require gas. See the [docs FAQ](https://docs.ophis.fi/faq).

### Which chains support it?

The app supports 14 EVM chains, including Arc. SDK v0.4.3 and hosted MCP mappings also cover
all 14 chains. Venue liquidity, bridge coverage and wallet requirements
vary; see the [current network matrix](https://docs.ophis.fi/networks-assets).

## Sign an intent instead

Your next swap does not have to be a public mempool transaction. Open
[swap.ophis.fi](https://swap.ophis.fi/), pick a pair, and the order you sign
can settle through a batch auction with a signed limit and uniform clearing
per token pair, subject to liquidity and the published fee policies.
