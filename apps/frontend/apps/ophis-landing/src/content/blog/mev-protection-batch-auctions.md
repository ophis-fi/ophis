---
title: "MEV-protected swaps: how batch auctions stop sandwich attacks"
description: "Sandwich attacks need a visible pending transaction and control over ordering. Batch auctions with a uniform clearing price remove both. Here is the mechanism."
pubDate: 2026-07-09
author: Ophis
tags: [mev, batch-auctions, swaps, defi]
draft: false
cover: ./mev-protection-batch-auctions.cover.jpg
coverAlt: "Ophis multi-chain DEX aggregator emblem, MEV-protected batch settlement"
---

A sandwich attack needs two things to work: a pending transaction the attacker
can see, and the power to order transactions around it. Batch auctions remove
both. On Ophis, your swap is a signed intent that never enters the public
mempool, and every order in a batch settles at the same uniform clearing price,
so there is no ordering inside the batch left to exploit.

That is the short answer. The rest of this post walks through the attack
itself, why hiding your transaction only mitigates it, and why settling orders
in batches removes it structurally.

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

Structural protection means something stronger: even with perfect information,
the attack has no move to make.

## What a batch auction changes

Ophis, the intent-based DEX aggregator at ophis.fi, is a fork of CoW Protocol's
frontend and settles swaps through CoW Protocol's batch auction model. Three
properties of that design each remove a piece of the sandwich.

**Orders are signed intents, not mempool transactions.** You sign an EIP-712
order: sell token, buy token, amount, a hard limit price. The signed
order goes to an off-chain orderbook. You broadcast nothing. There is no
pending transaction in any mempool carrying your trade, so there is nothing for
a searcher to see or to position around.

**Solvers compete to fill the batch.** Open orders are collected into a batch,
and a network of competing solvers proposes settlements: which orders to fill,
against which liquidity, at what prices. The solver offering the best execution
wins the right to settle the batch on-chain, in a single transaction that the
solver, not you, submits. On most chains that settlement goes through CoW
Protocol's audited GPv2 contracts; on Optimism and Unichain, Ophis operates its
own orderbook and a bytecode-identical deployment of CoW Protocol's audited
GPv2Settlement.

**One batch, one price.** Inside a batch, all orders trading the same token
pair clear at the same uniform clearing price. This is the piece that kills the
sandwich outright. A front-run only pays if executing before the victim gets
the attacker a better price than the victim receives. When every order in the
batch gets the same price, "before" and "after" stop existing as economic
positions. There is no ordering to buy.

And underneath all of it sits your signed limit price: a solver cannot fill
your order below it. The worst case is not a bad fill; it is no fill.

## Surplus: the upside of solver competition

The same competition that protects you also pays you. Your signed order carries
the minimum you will accept. When the winning solver finds better execution
than that, the price improvement beyond the quote you signed is called
**surplus**, and the Ophis fee takes no share of it. On Optimism and Unichain,
where Ophis runs its own settlement, 100% of that surplus is yours; on the ten
chains that settle through CoW Protocol's canonical contracts, CoW Protocol
keeps half. The Ophis fee is a flat 0.10% of trade volume (0.01% for same-chain
stablecoin-to-stablecoin swaps), taken in the token you sell, and on those
CoW-settled chains CoW Protocol's protocol fee applies on top for an all-in cost
of about 0.12%. The Ophis numbers live on the
[fees page](https://docs.ophis.fi/fees).

So the auction cuts both ways. Attackers cannot extract value from your trade's
position, and solvers hand back the value they find beyond your quote.

## What "MEV protected" means at Ophis

Precisely this: when Ophis calls a swap MEV protected, it means the protection
is structural, built from a batch auction, a uniform clearing price, and
off-chain order flow. It is not a best-effort service scanning for attacks, and
it does not depend on you configuring the right RPC. Orders are also gasless
(no native token needed; the fee is taken in the sell token) and
self-custodial (Ophis never holds funds; every order requires your EIP-712 or
ERC-1271 signature).

These properties matter double for automated traders. An agent that rebalances
on a schedule is a predictable, high-frequency target in a public mempool, and
it has no wallet pop-up where a human might catch a bad fill. That case is
covered in [how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/).
For how the intent model stacks up against other swap architectures, see the
[comparison page](https://docs.ophis.fi/comparison).

## FAQ

### Is MEV protection best-effort or structural?

Structural, and the distinction matters. A sandwich requires a visible pending
transaction and control over ordering around it; a signed intent settled at a
uniform clearing price provides neither, so the attack's preconditions are
absent by construction. That is a stronger claim than "we watch for attacks"
and a different claim than an insurance policy: no venue can promise that every
conceivable form of MEV prices at exactly zero, but a sandwich has no structure
to attach to here.

### What happens to my order if no solver fills it?

Nothing executes. If no solver can meet your limit price, the order simply
lapses. It costs nothing: you never
broadcast a transaction, no gas was spent, and your funds never left your
wallet. You can sign a new order with a fresh quote whenever you like.

### Do I pay gas?

No. The winning solver submits the settlement transaction and pays its gas; you
only sign a message. Beyond a one-time approval the first time you sell a given
token, you do not need the chain's native token, because the flat 0.10% fee is
taken in the token you sell. More edge cases are covered
in the [docs FAQ](https://docs.ophis.fi/faq).

### Does this work on all 12 chains?

Yes. Ophis runs the same intent flow on Ethereum, Optimism, BNB, Gnosis,
Unichain, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, and Linea, plus
Sepolia for testing. On most of these chains settlement goes through CoW
Protocol's canonical audited GPv2 contracts; on Optimism and Unichain, Ophis
operates its own orderbook and a bytecode-identical deployment of
GPv2Settlement. The underlying protocol is documented at
[docs.cow.fi](https://docs.cow.fi).

## Sign an intent instead

Your next swap does not have to be a public mempool transaction. Open
[swap.ophis.fi](https://swap.ophis.fi/), pick a pair, and the order you sign
settles through a batch auction with everything above built in: no mempool
exposure, one clearing price, a hard limit, and your surplus back (100% of it on
Optimism and Unichain).
