---
title: "Gasless DeFi swaps: your options for trading tokens without gas"
description: "A comparison of the three ways to swap tokens without holding a native gas token: intent-based settlement, ERC-4337 paymasters, and relayers. Which one needs no ETH and no per-chain pre-funding."
pubDate: 2026-07-18
author: Ophis
tags: [gasless, swaps, defi, account-abstraction, comparison]
draft: true
# cover: ./gasless-defi-swap-options.cover.jpg  # add a 2:1 cover image (jpg), then uncomment and set draft:false
coverAlt: "Ophis emblem comparing three gasless swap approaches across EVM chains"
---

There are three ways to swap tokens without holding a native gas token: intent-based settlement (you sign an off-chain order and a solver pays the gas), ERC-4337 account-abstraction paymasters (a smart-account contract sponsors the gas for a bundled user operation), and relayers or meta-transactions (a third party broadcasts a transaction on your behalf). They differ on what they need from you, whether they hold your funds, and whether they protect you from MEV. This page compares the three so you can pick, and hands the mechanism depth to the deep-dives it links.

## The three gasless swap options, side by side

| | Intent-based settlement (Ophis, CoW-style) | ERC-4337 paymaster | Relayer / meta-transaction |
|---|---|---|---|
| Needs a native gas token? | No | No | No |
| Pre-funding per chain? | No | Often (paymaster deposit or a supported smart account per chain) | Depends on the relayer |
| Custodial? | No, non-custodial | No, but requires a smart-contract account | Varies by service |
| MEV-protected? | Yes, by construction (batch auction, uniform clearing price) | Depends on the execution route | Depends on the execution route |
| Fee model | Flat 0.10% of volume in the sell token, 0.01% same-chain stable pairs (5 bps via the SDK or MCP) | Gas cost repaid in an ERC-20, plus service margin | Gas cost repaid somewhere, plus service margin |
| Works with a plain EOA? | Yes | No, needs a smart account | Sometimes (EIP-2612 / permit flows) |

The rest of this page walks each option, then gives a plain decision rule at the end.

## Option 1: Intent-based settlement (signed off-chain orders)

With an intent, you never send an on-chain transaction. You sign an off-chain order as [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data (or ERC-1271 from a smart-contract wallet), and a network of competing solvers executes it and pays the gas. The order pins the token you sell, the token you buy, a hard limit price, and an expiry. Signing costs nothing and nothing touches the chain until a solver settles a batch that includes your order.

This is the model [Ophis](https://ophis.fi/) uses. Ophis is an intent-based DEX aggregator, a fork of [CoW Protocol](https://docs.cow.fi)'s frontend with a natural-language intent layer and an agent stack, and settlement runs through CoW Protocol's audited GPv2 contracts and its solver competition (on Optimism and Unichain, Ophis operates the solving and settlement itself, through deployments of those same contracts). Because the only on-chain transaction is the solver's batch settlement, there is no user transaction to fund and nothing to pre-fund per chain. A wallet holding only the ERC-20 it wants to sell can trade.

Two properties fall out of this design and matter for the comparison. It is non-custodial: tokens stay in your wallet until the batch settles, and they can move only under an allowance you granted and against an order you signed. And it is MEV-protected by construction: orders stay off-chain and clear at a uniform price inside a [batch auction](/blog/mev-protection-batch-auctions/), so there is no public mempool swap to front-run or sandwich.

The full mechanism (where the gas cost goes, the one place gas can still appear, why failed orders cost nothing) is covered in [how intent-based trading removes gas](/blog/gasless-swaps-how-intents-work/). This page stays comparison-only.

## Option 2: ERC-4337 account-abstraction paymasters

[ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) replaces your externally owned account with a smart-contract account. Instead of a transaction, you submit a "user operation" to a bundler, and a paymaster contract can agree to pay the gas for it. The paymaster is what makes it gasless from your side: it fronts the native gas and can charge you back in an ERC-20, or sponsor the operation entirely (a dapp eating gas to onboard users).

This is a genuine gasless path, and it is powerful for wallet-level UX (session keys, batched actions, social recovery). Two things to weigh when comparing it to intents. First, it requires a smart-contract account. A plain EOA (a standard MetaMask-style wallet) cannot use a paymaster directly, so there is a migration or a per-chain smart-account deployment involved. Second, gas sponsorship and MEV protection are independent. A paymaster pays for a transaction; whether that transaction is MEV-protected depends on where the swap executes. Sponsoring an ordinary on-chain DEX swap leaves it exposed unless the swap itself routes through a private mempool or an intent/batch-auction protocol. The gasless part and the MEV part are separate problems here.

Paymasters also usually maintain a per-chain deposit with the EntryPoint contract, which is the "pre-funding per chain" cost in the table: the sponsorship capital lives on each chain where you want the flow to work.

## Option 3: Relayers and meta-transactions

The oldest gasless pattern. You sign a message describing what you want done, and a relayer wraps it in a transaction and broadcasts it, paying the gas. Classic meta-transaction standards (EIP-2771 trusted forwarders, and permit-based flows using [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612)) let a dapp accept a signature and submit the on-chain call for you.

This works and is widely deployed, especially for single-app gasless actions like a permit-then-swap on one protocol. The trade-offs against intents are the same shape as with paymasters. A relayer submits a transaction on your behalf, and whether the swap is MEV-protected depends on the route it takes: a relayer broadcasting an ordinary DEX swap to the public mempool is exposed by default, unless it routes through a private mempool or an intent protocol. And a relayer is a service you trust to actually broadcast (and to broadcast promptly and at a fair price), so the custody and reliability profile depends entirely on who runs it. Some relayers are non-custodial thin broadcasters; others route funds through their own contracts. There is no single answer, which is why the table says "varies."

## Which gasless option should I use?

A plain decision rule:

- **You want to swap tokens across many chains, from a normal wallet, without babysitting gas balances.** Use intent-based settlement. It needs no native gas token, no per-chain pre-funding, and it includes batch-auction MEV protection by construction, without a separate execution integration (a paymaster or relayer inherits protection only from whatever venue its swap routes through). This is what Ophis does.
- **You are building wallet-level UX around a smart account** (session keys, batched multi-step actions, sponsored onboarding). Use an ERC-4337 paymaster, and route its swaps through a private mempool or an intent protocol if they need MEV protection.
- **You need one gasless action inside a single app and already control that app's contracts.** A relayer or a permit-based meta-transaction is the lightest option.

For DeFi swapping specifically, the intent model removes the two frictions the other two carry: it does not require a smart-account migration, and it does not leave the MEV problem for you to solve separately. You sign, solvers compete, and the trade clears at a uniform price in a batch.

## What Ophis actually charges and where it runs

The facts, so the comparison is grounded:

- **Fee.** The Ophis fee is a flat 0.10% (10 bps) of trade volume, taken in the token you sell, or 0.01% (1 bp) for same-chain stablecoin-to-stablecoin pairs (the partner and SDK base is 5 bps). On Optimism and Unichain, where Ophis runs its own settlement, that is the whole cost. On the ten CoW-hosted chains, CoW Protocol's protocol fee applies on top, so the all-in cost is about 0.12% (about 0.013% on stable pairs). The fee takes no share of any price improvement your order earns.
- **Rebates.** High-volume wallets share a monthly WETH rebate pool (21.25% of collected WETH fees), allocated by a rolling 30-day volume tier weighted from 10% up to 50% (Bronze through Platinum). The [fee docs](https://docs.ophis.fi/fees) have the full schedule.
- **Reach.** Live on 12 EVM chains: Ethereum, Optimism, BNB, Gnosis, Unichain, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, and Linea. Solana and Bitcoin destinations are reachable via NEAR Intents.
- **Deployments.** Ophis runs sovereign self-hosted deployments on Optimism and Unichain (its own orderbook and a bytecode-identical GPv2Settlement); the rest settle through CoW-hosted infrastructure.
- **Rails.** Intent API at `POST https://swap.ophis.fi/api/intent`, an MCP server at `mcp.ophis.fi/mcp`, the `@ophis/sdk` package, and docs at [docs.ophis.fi](https://docs.ophis.fi).

If you are weighing Ophis against the protocol it forks, the on-page comparison lives in [Ophis vs CoW Swap](/blog/ophis-vs-cow-swap/).

## FAQ

### What are my options for gasless swaps?

Three. Intent-based settlement (sign an off-chain order, a solver executes it and pays the gas), ERC-4337 paymasters (a smart-account contract sponsors the gas for a bundled user operation), and relayers or meta-transactions (a third party broadcasts a transaction for you). They differ on whether you need a smart account, whether you pre-fund per chain, whether the service holds your funds, and whether the swap is MEV-protected.

### Which gasless method needs no ETH at all?

All three can remove the native gas token from your side, but intent-based settlement removes it with the fewest prerequisites: no smart-account migration and no per-chain sponsorship deposit. On Ophis you sign from a normal wallet that holds only the ERC-20 you want to sell, a solver pays the gas, and the flat 0.10% fee comes out of the sell token. The one exception is a first-time token approval, a single on-chain transaction paid once per token per chain.

### Is the gasless swap MEV-protected?

It depends on where the swap executes, which is independent of who pays the gas. Ophis intents include batch-auction protection by construction: orders clear at a uniform price inside a [batch auction](/blog/mev-protection-batch-auctions/), so there is no transaction ordering inside a batch to exploit. A paymaster or relayer inherits protection only from the venue it routes through, so sponsoring or relaying an ordinary public-mempool DEX swap leaves it exposed unless that swap runs through a private mempool or an intent protocol.

### Is a gasless swap custodial?

It depends on the option. Intent-based settlement on Ophis is non-custodial: funds stay in your wallet until the batch settles and move only under an allowance you granted against an order you signed. Paymasters keep custody in your own smart account. Relayers vary, from thin non-custodial broadcasters to services that route funds through their own contracts.

## Try it

Open [swap.ophis.fi](https://swap.ophis.fi/), connect a wallet holding any ERC-20 on a supported chain, and sign an order. For how the intent mechanism works underneath, read [how intent-based trading removes gas](/blog/gasless-swaps-how-intents-work/).
