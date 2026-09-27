---
title: "Gasless token swaps: how intent-based trading removes gas"
description: "Sign an off-chain EIP-712 order and a solver executes it on-chain, paying the gas. The fee comes out of the trade itself, so you can swap with zero ETH."
pubDate: 2026-07-10
updatedDate: 2026-09-27
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
the fee comes out of the traded amount. So you can trade with no native gas
token in your wallet at all, and an order that never fills costs you nothing.

The rest of this article is the mechanism: where the gas cost actually goes,
the places it can still appear, and why this matters most for new wallets,
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
settlement uses CoW Protocol's GPv2 design, with Ophis-operated deployments on
Optimism, Unichain, Robinhood Chain and Arc. The
solver builds the settlement transaction, broadcasts it, and pays its gas.

Note that this is different from gas sponsorship. Sponsorship models (relayers,
paymasters) still construct a transaction for you and have a third party pay
for it, usually charging the cost back somewhere else. In an intent there is no
user transaction to sponsor: the only on-chain transaction is the solver's
batch settlement, which would exist anyway.

The same structure is what makes the flow [MEV-protected](/blog/mev-protection-batch-auctions/). Orders travel
offchain and clear at a uniform price per token pair. This mitigates common
MEV, but the solver's settlement can still be public and use external pools.

## The fee comes out of the trade, not your gas balance

Ophis uses chain-aware pricing. The standard schedule, excluding Arc's current release exception, charges a 1 bp base plus
capped reference-quote-improvement capture; hosted chains additionally apply
CoW Protocol fees upstream. Fees are taken from the
trade rather than billed in native gas (the
full [fee schedule](https://docs.ophis.fi/fees) is public; on the chains that
settle through CoW Protocol, CoW Protocol's protocol fee applies on top of the
Ophis fee). On a standard sell order that is the token you receive: sell USDC for ETH and the fee is a slice of the ETH. On a buy order, where you name the amount you want to receive, it comes off the token you spend instead. For standard ERC-20 orders, you do not broadcast or directly pay gas for the
solver's settlement. Arc's six-decimal ERC-20 USDC and its 18-decimal native
USDC gas balance are distinct assets with the same symbol: selling the ERC-20
does not spend or replenish the native gas balance.

The limit you signed still bounds the outcome. Solvers compete to beat the
reference quote. Under that standard schedule, Ophis retains 80% of that
improvement on volatile pairs (99 bps cap) or 50% on stable pairs (20 bps
cap); the trader receives the remainder and everything above the cap. Hosted
chains additionally apply CoW Protocol's upstream fees.

## Failed and expired orders cost nothing

A failed on-chain swap still burns gas: you paid the network to execute your
revert. A signed order has no equivalent failure cost. If no solver can meet
your limit price before the order's expiry, the order expires, and nothing
happened on-chain on your behalf. There is nothing to pay for. The worst case
of a gasless order is the state you started in.

## Where gas can still appear

An ERC-20 sell needs sufficient allowance to the chain's **vault relayer**, not
an approval to the settlement contract. Resolve that spender through the SDK
or app configuration. Approval transactions cost gas; an exact allowance may
need renewing after it is consumed. Some tokens and wallets support permits.

Native-token placement through EthFlow, wrapping, hard cancellation, refunds
and direct bridge or conversion transactions can also require gas. Native-token
orders deposit funds before settlement and need a separate refund if unfilled.
This article's gasless flow is the standard signed ERC-20 order.

## Who actually hits the gas wall

**New wallets.** ERC-20 tokens alone do not cover approval gas. A wallet needs
an existing allowance or a supported permit flow before gasless signing can help.
Once that requirement is met, the solver pays settlement gas.

**AI agents.** Signed orders remove the need to fund settlement transactions,
not all wallet operations. Keep gas available for approvals and other required
transactions; the integration pattern is in
[how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/).

**Multichain traders.** The Ophis app supports 14 chains: Ethereum, Optimism, BNB,
Gnosis, Unichain, Robinhood Chain, Polygon, Base, Plasma, Arbitrum, Avalanche,
Ink, Linea, and Arc. Published SDK/MCP mappings exclude Arc.
They do not all share one gas token. Pre-funding a native balance on every
chain you might trade on is dead capital and real friction; signed orders
remove settlement-gas payment by the trader, not approval or other transaction gas.

## FAQ

### Do I need ETH to swap?

For a standard signed ERC-20 order, the solver pays settlement gas and the fee
comes out of the trade. Approvals, native-token placement, wrapping, hard
cancellation, refunds and direct bridge transactions can still require gas.

### What if the price moves while my order is open?

Your order carries a hard limit price that you signed, and it cannot settle
below that price. If the market never reaches your limit before expiry, the
order expires at zero cost to you. If the market moves in your favor, solvers
still compete for the fill, and improvement beyond the reference quote is
shared under the operated-chain capped policy or the hosted CoW policy.

### Who pays the solver?

The winning solver pays the gas for the settlement transaction. The trading
fee follows the current chain-aware schedule and is taken from the trade; the
limit price you signed bounds the outcome either way.
Solver compensation is never billed to you in the native token.

### Is it custodial?

For standard signed ERC-20 orders, tokens stay in your wallet until the batch that
includes your order settles, and they can move only under the allowance you
granted and against an order you signed (EIP-712 from a regular wallet,
ERC-1271 from a smart-contract wallet). Native-token orders and bridges can
require deposits with separate recovery rules. See the
[FAQ docs](https://docs.ophis.fi/faq).

## Try a swap with an empty gas tank

Open [swap.ophis.fi](https://swap.ophis.fi/), connect a wallet that holds any
ERC-20 on a supported chain, and sign an order. For your first trade of a token
you may need a one-time approval first; the
[getting started guide](https://docs.ophis.fi/getting-started) covers the rest.
