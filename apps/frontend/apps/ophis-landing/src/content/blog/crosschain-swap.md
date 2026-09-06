---
title: "Crosschain Swap: A Simple Guide to Swapping With Ophis"
description: "Learn what a crosschain swap is, how it differs from a bridge, and how to use Ophis to check supported routes, fees, and the amount you could receive."
slug: "crosschain-swap"
primaryKeyword: "crosschain swap"
author: "Ophis"
pubDate: 2026-09-06
tags: [crosschain-swap, cross-chain, swaps, bridging]
draft: false
cover: ./crosschain-swap.cover.webp
coverAlt: "A glowing token crosses a saffron Ophis route between two separate blockchain network islands."
---

**A crosschain swap exchanges an asset on one blockchain for an asset on another. It combines the steps needed to reach your chosen token and network, so you do not have to arrange each step separately.**

Perhaps your funds are on one network, but the app you want to use runs on another. Or you want to exchange a token in your wallet for an asset on a different blockchain. A crosschain swap, also written “cross-chain swap,” helps connect those starting and finishing points.

Ophis brings supported cross-chain routes into its swap interface. You select what you have, choose what you want to receive, and review the quote before approving the trade.

## What does a crosschain swap actually change?

Two details matter whenever you hold a crypto asset: **which token it is and which network it is on**.

For example, a hypothetical swap might start with USDC on Ethereum and finish with ETH on Base. The token changes from USDC to ETH, and the network changes from Ethereum to Base.

Another route might start with USDC on one network and deliver USDC on another. The token name looks the same, but its location changes. Availability depends on the service and the specific route.

This matters because apps use balances on particular networks. Having a token in your wallet does not mean every app can use it wherever it sits.

## Crosschain swap vs bridge: what is the difference?

A bridge moves value between blockchains. A crosschain swap can combine that movement with exchanging one token for another. Some services offer both within the same interface, so the names can overlap.

| Action | What it does | Illustrative example |
| --- | --- | --- |
| Same-chain swap | Exchanges tokens on one network | USDC to ETH, both on Ethereum |
| Bridge | Moves value from one network to another | USDC on Ethereum to USDC on Base |
| Crosschain swap | Combines a change of network with the desired token outcome | USDC on Ethereum to ETH on Base |

These examples explain the concepts; they are not live quotes or promises of route availability.

The practical question is the same in each case: **Will this route deliver the asset I need on the network I intend to use?**

## When would you use a crosschain swap?

### You want to use an app on another network

You may have funds available on one blockchain while a service you want to use requires a balance on another. A supported cross-chain route can help you get the right asset to that destination.

### You want to receive a different asset

Sometimes moving the same token is only half the job. If you also need to exchange it, combining the steps can reduce the number of interfaces you have to navigate.

### You want fewer scattered balances

Using several networks can leave you with small balances in different places. Moving supported assets to a chosen destination may make them easier to manage. Check the costs first: a small transfer can lose much of its usefulness if fees consume a large share of it.

## How Ophis helps with cross-chain swaps

Ophis connects its swap experience to cross-chain providers including Across, Bungee, and NEAR Intents. The app requests supported routes so you can review the outcome without arranging every step in a separate service.

Its published network coverage includes 13 EVM blockchains, including Ethereum, Base, Arbitrum, Optimism, and Robinhood Chain. Bitcoin and Solana are also available as destinations through NEAR Intents. See the [Ophis supported-chain list](https://ophis.fi/supported-chains/).

If Robinhood Chain is your destination, the [Ophis Robinhood Chain swap guide](https://ophis.fi/blog/dex-aggregator-robinhood/) explains how to check assets and review a same-chain trade once your funds arrive.

**Network support does not mean every route is available in both directions.** Your starting network, destination, token pair, and amount all affect whether a quote can be offered. Use the app's available options and live quote to check your particular swap.

**[Check your crosschain swap route on Ophis](https://swap.ophis.fi/).**

## How to make a crosschain swap with Ophis

### 1. Connect the wallet holding your funds

Open [the Ophis swap app](https://swap.ophis.fi/) and connect a compatible wallet. Confirm which network currently holds the asset you want to sell.

### 2. Choose the starting token and network

Select your source network, the token you are selling, and the amount. Check the available balance on that specific network.

### 3. Choose the destination token and network

Select the asset you want to receive and where you want it delivered. If the app asks for a receiving address, use an address you control on the correct destination network.

### 4. Review the available quote

Check the estimated output, minimum received, route costs, and delivery estimate where provided. Make sure the destination is correct before continuing.

If a route is unavailable, another amount or supported pair may have a quote. Do not assume that increasing your tolerance for price changes will solve a route-availability problem.

### 5. Approve and sign as prompted

You may need to approve a token before using it. Review each wallet request, including the spending permission and the swap details, before confirming.

### 6. Follow delivery through to completion

A crosschain swap has more than one stage. Completion on the starting network does not necessarily mean the destination asset has arrived. Follow the order status and check the receiving balance before treating the whole swap as finished.

For more background on choosing a trade and signing an order, read [Getting started with Ophis](https://docs.ophis.fi/getting-started/).

## What should you check before confirming?

### The amount you will receive after costs

A low advertised fee is only one part of a swap. Compare the expected final amount alongside any minimum received figure and separate costs shown.

For illustration, if two routes start with the same 100 units and deliver 98.8 or 98.2 units of the same destination asset, the first provides more output. Delivery time and other route conditions may still affect your choice. These numbers are examples, not Ophis quotes.

Ophis has its own trading fees, and a cross-chain route can add provider and network costs. The [pricing page](https://ophis.fi/pricing/) explains the Ophis fee model; review your route's quote for the specific trade.

### Any gas needed in your wallet

Supported Ophis token orders let solvers handle swap settlement gas. Token approvals and other direct transactions can still require the source network's gas token. Cross-chain provider costs also remain relevant even when an order is described as gasless. The [gasless swaps explanation](https://ophis.fi/blog/gasless-swaps-how-intents-work/) covers this distinction.

### The destination address and asset

Check the receiving address, network, and token together. Similar names do not guarantee that two tokens are the same asset, and the intended recipient must be able to use the destination address.

### Delivery time and route status

Cross-chain delivery depends on more than the first transaction. Network confirmations, provider processing, and available liquidity can affect the time needed.

Check the status if delivery takes longer than expected. Review the selected provider's recovery or refund process when relevant; do not assume every route handles delays in the same way.

## Can Ophis send to Bitcoin or Solana?

Yes. Ophis supports Bitcoin and Solana as destinations through NEAR Intents on available routes from supported EVM sources.

You provide a destination address you control and sign from your EVM wallet. Receiving through this flow does not require a second wallet connection or a signature on Bitcoin or Solana. You still need control of the destination address to use what arrives.

Bitcoin and Solana are destinations in this Ophis flow, rather than starting networks. Delivery is a separate stage and is not instant. The [native Bitcoin guide](https://docs.ophis.fi/agent-btc-cookbook/) explains that distinction.

## Frequently asked questions

### What is a crosschain swap?

A crosschain swap exchanges an asset on one blockchain for an asset on another. It can combine a token exchange with moving value between networks.

### Is a crosschain swap the same as a bridge?

A bridge focuses on moving value between networks. A crosschain swap can include a bridge and a token exchange within one coordinated flow. Some services use both terms for overlapping features.

### Can I swap from any blockchain to any other?

No. Routes depend on supported source networks, destinations, tokens, amounts, and liquidity. A network appearing in a support list does not guarantee every possible connection.

### How long does a crosschain swap take?

There is no single time for every route. Review any estimate provided, then follow the swap status until destination delivery completes.

### Does gasless mean the crosschain swap is free?

No. Gasless describes how certain settlement transactions are handled. Trading and provider fees can still apply, and some wallet actions require gas.

### What happens if no route is available?

You cannot complete the selected swap without an executable route. Check another supported amount or asset pair, or try again when liquidity and route availability change.

## Find a route for your next swap

Start with three details: the asset you have, the network it is on, and what you want to receive. Ophis helps you check the available route and review the result before signing.

**[Open Ophis and check your crosschain swap quote](https://swap.ophis.fi/).**
