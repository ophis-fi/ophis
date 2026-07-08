---
title: "Gasless token swaps: how intent-based trading removes gas"
description: "Sign an off-chain EIP-712 order and a solver executes it on-chain, paying the gas. The fee comes out of the token you sell, so you can swap with zero ETH."
pubDate: 2026-07-10
author: Ophis
tags: [gasless, swaps, intents, defi]
draft: false
cover: ./gasless-swaps-how-intents-work.cover.jpg
coverAlt: "Ophis multi-chain DEX aggregator emblem for gasless intent swaps"
---

A gasless token swap is a trade where you never send an on-chain transaction
yourself: you sign an off-chain order, and someone else executes it. On Ophis
(the intent-based DEX aggregator at ophis.fi), that order is
[EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data signed by your
wallet; a competing solver network executes it on-chain and pays the gas, and
the fee is taken from the token you sell. So you can trade with no native gas
token in your wallet at all, and an order that never fills costs you nothing.

The rest of this article is the mechanism: where the gas cost actually goes,
the one place it can still appear, and why this matters most for new wallets,
AI agents, and anyone trading across many chains.

## Signing is not sending

A normal swap is a transaction. You build it, you broadcast it, you pay gas for
it in the chain's native token, and you pay whether it succeeds or reverts.
Gasless trading replaces the transaction with a message.

An Ophis order pins down the trade: the token you sell, the token you buy, the
minimum amount you will accept (a hard limit price), and an expiry. You sign
that as EIP-712 typed data. Signing costs nothing, and nothing touches the
chain yet: the order sits in an off-chain orderbook.

Execution is someone else's job. Competing solvers pick up open orders, race
each other on price, and the winner settles a whole batch of orders in one
on-chain transaction. Ophis is a fork of [CoW Protocol's](https://docs.cow.fi)
frontend with a natural-language intent layer and an agent stack, and
settlement runs through CoW Protocol's audited GPv2 contracts (on Optimism and
Unichain, through a bytecode-identical deployment that Ophis operates). The
solver builds the settlement transaction, broadcasts it, and pays its gas.

Note that this is different from gas sponsorship. Sponsorship models (relayers,
paymasters) still construct a transaction for you and have a third party pay
for it, usually charging the cost back somewhere else. In an intent there is no
user transaction to sponsor: the only on-chain transaction is the solver's
batch settlement, which would exist anyway.

The same structure is what makes the flow [MEV-protected](/blog/mev-protection-batch-auctions/). Orders travel
off-chain and clear at a uniform price inside a batch auction, so there is no
public mempool swap to front-run or sandwich. The protection is structural, not
best-effort.

## The fee comes out of the token you sell

Ophis charges a flat 0.10% of trade volume on every trade, 0.01% for
same-chain stablecoin-to-stablecoin pairs, and takes it in the sell token (the
full [fee schedule](https://docs.ophis.fi/fees) is public; on the chains that
settle through CoW Protocol, CoW Protocol's protocol fee applies on top of the
Ophis fee). Sell USDC for ETH and the fee is a slice of the USDC. At no point does anything denominated in
the native gas token leave your wallet, because you never send the transaction
that would need it.

The limit you signed still bounds the outcome. Solvers compete to beat your
quote, and when one does, the Ophis fee takes no share of the price improvement
beyond the signed quote. On Optimism and Unichain, where Ophis runs its own
settlement, 100% of that improvement is paid to you as surplus; on the chains
that settle through CoW Protocol, CoW Protocol keeps half.

## Failed and expired orders cost nothing

A failed on-chain swap still burns gas: you paid the network to execute your
revert. A signed order has no equivalent failure cost. If no solver can meet
your limit price before the order's expiry, the order expires, and nothing
happened on-chain on your behalf. There is nothing to pay for. The worst case
of a gasless order is the state you started in.

## The one place gas can still appear

Before an ERC-20 can be pulled into a settlement, it needs a one-time allowance
for the settlement contract. A standard approval is a normal on-chain
transaction: it costs gas, once, per token, per chain.

The footprint stops there. An allowance persists, so once a token is approved
on a chain, every trade of that token on that chain is fully gasless. The
approval is the single place gas enters the flow, and it is paid once, not per
trade.

One boundary worth stating: all of this is about ERC-20s. Selling a chain's
native token is the one case where you hold the gas token by definition, so the
constraint this article is about does not bind there.

## Who actually hits the gas wall

**New wallets.** The classic deadlock: a fresh wallet receives USDC from an
exchange withdrawal or an airdrop, and then cannot do anything with it, because
doing anything takes gas and the wallet holds none. A signed order breaks the
deadlock: a solver executes the trade, and the fee comes out of the USDC
itself.

**AI agents.** An agent's wallet is funded in the tokens it trades, not in gas.
Keeping native balances topped up on every chain it touches is an operational
loop nobody wants to babysit, and spare ETH sitting in a hot agent wallet is
added attack surface. An agent that signs orders instead of broadcasting
transactions needs neither; the full integration pattern is in
[how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/).

**Multichain traders.** Ophis settles on 12 chains: Ethereum, Optimism, BNB,
Gnosis, Unichain, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, and Linea.
They do not all share one gas token. Pre-funding a native balance on every
chain you might trade on is dead capital and real friction; signed orders
remove the prerequisite entirely.

## FAQ

### Do I need ETH to swap?

No. You sign an off-chain order, a solver executes it and pays the gas, and the
flat 0.10% fee is taken from the token you sell. The one exception is a
first-time token approval, a single on-chain transaction, paid once per token
per chain. After that, trading that token needs no native balance at all.

### What if the price moves while my order is open?

Your order carries a hard limit price that you signed, and it cannot settle
below that price. If the market never reaches your limit before expiry, the
order expires at zero cost to you. If the market moves in your favor, solvers
still compete for the fill, and the improvement beyond your signed quote comes
back to you as surplus (100% of it on Optimism and Unichain; on chains that
settle through CoW Protocol, CoW Protocol keeps half).

### Who pays the solver?

The winning solver pays the gas for the settlement transaction. Your only cost
is the flat 0.10% fee (0.01% for same-chain stablecoin pairs), taken in the
sell token, and the limit price you signed bounds the outcome either way.
Solver compensation is never billed to you in the native token.

### Is it custodial?

No. Ophis never holds funds: tokens stay in your wallet until the batch that
includes your order settles, and they can move only under the allowance you
granted and against an order you signed (EIP-712 from a regular wallet,
ERC-1271 from a smart-contract wallet). There is no deposit step and no balance
to withdraw. More edge cases are covered in the
[FAQ docs](https://docs.ophis.fi/faq).

## Try a swap with an empty gas tank

Open [swap.ophis.fi](https://swap.ophis.fi/), connect a wallet that holds any
ERC-20 on a supported chain, and sign an order. For your first trade of a token
you may need a one-time approval first; the
[getting started guide](https://docs.ophis.fi/getting-started) covers the rest.
