---
title: "DEX Aggregator on Robinhood Chain: Ophis Guide"
description: "Use Ophis as a DEX aggregator on Robinhood Chain. Compare routing sources, check fees, and follow a real WETH-to-USDG quote before your first swap."
slug: "dex-aggregator-robinhood"
primaryKeyword: "dex aggregator robinhood"
author: "Ophis"
pubDate: 2026-09-06
updatedDate: 2026-09-27
tags: [dex-aggregator, robinhood-chain, swaps, stock-tokens]
draft: false
cover: ./dex-aggregator-robinhood.cover.webp
coverAlt: "Three token routes converge through Ophis toward a green Robinhood Chain destination."
---

**Ophis is an independent DEX aggregator on Robinhood Chain. It brings available trading routes into one interface, where you choose tokens, review a quote and sign an order with a minimum amount to receive.** On this network, Ophis runs its own orderbook and solver services; supported orders settle through its batch-settlement contracts.

**[Check a Robinhood Chain swap quote on Ophis](https://swap.ophis.fi/#/4663/swap).** This guide covers wallet-held assets on the blockchain, separate from buying or selling through a Robinhood brokerage account.

Ophis is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. You can explore its supported market on the [Ophis Robinhood Chain page](https://ophis.fi/swap/robinhood-chain/).

## Ophis on Robinhood Chain at a glance

| Question | Answer |
| --- | --- |
| Which network? | Robinhood Chain mainnet, chain ID **4663**; ETH is its gas token. |
| Which assets? | WETH, USDG and supported Stock Tokens, subject to a quote, liquidity and asset eligibility. |
| How do I trade? | Connect a compatible wallet, choose a pair and amount, review the quote, then approve and sign as needed. |
| Who operates the service? | Ophis runs the orderbook and solver services on this network. |
| What does Ophis charge? | A **0.01% base fee plus capped price-improvement capture**; see the fee breakdown below. |
| Do I need gas? | Solvers pay settlement gas for supported signed token orders. Approvals and native-ETH order placement can require ETH. |

Verify the network in [Robinhood's connection guide](https://docs.robinhood.com/chain/connecting/) and the deployment model in [Ophis service documentation](https://docs.ophis.fi/status). For broader ecosystem context, read [DeFi on Robinhood Chain](https://ophis.fi/blog/defi-on-robinhood-chain/).

## What does a DEX aggregator do?

A decentralized exchange, usually shortened to DEX, lets people exchange tokens through blockchain-based trading systems. Different exchanges can offer different prices for the same pair of tokens.

A DEX aggregator helps search those trading options. Instead of checking several exchanges yourself, you choose the token you want to sell, the token you want to receive, and the amount.

Ophis uses intent-based trading: you sign the conditions of a trade you are willing to accept, and its solver services look for a route that meets those conditions. The useful comparison is the amount you receive after costs and the minimum your order enforces. The [Ophis introduction](https://docs.ophis.fi/) explains this approach.

For you, the process is straightforward: choose, review, and sign.

## Is Robinhood Chain the same as the Robinhood app?

Robinhood Chain is a blockchain network. A brokerage account and a wallet connected to that network are different ways of holding and using assets.

When you use Ophis, you connect a compatible wallet and trade supported assets available on the selected network. A balance shown in a brokerage account should not be assumed to be available in that wallet.

Before starting, check that your wallet holds the asset you intend to sell **on Robinhood Chain**. Holding a token with the same name on another blockchain does not make it available for a same-chain swap. If you need to move assets first, our [crosschain swap guide](https://ophis.fi/blog/crosschain-swap/) explains how to check an available route.

## Which liquidity sources does Ophis use?

Ophis's [Robinhood deployment guide](https://ophis.fi/blog/swap-on-robinhood-chain/#three-active-solver-lanes) documents these routing sources:

| Source | How Ophis uses it |
| --- | --- |
| **KyberSwap** | An Ophis-operated routing service requests aggregated routes from KyberSwap. |
| **LI.FI** | An Ophis-operated routing service requests same-chain routes from LI.FI. |
| **Direct Uniswap v4** | Ophis reads the supported native ETH/USDG pool directly, without an external route API. |

KyberSwap and LI.FI are route providers in this setup, not separate operators of Ophis's solver services. A configured source does not guarantee an executable quote for every pair or amount.

**Routing status reviewed September 27, 2026:** the [direct-routing rollout record](https://github.com/ophis-fi/ophis/blob/08739fc0/docs/operations/direct-dex-routes.md) also describes the existing UP33 integration and implemented PancakeSwap, RamsesX and Fables routes. That record still requires production rollout, so implementation alone is not confirmation that those newer routes are available in your live quote.

Ophis combines route selection with a signed minimum output and batch settlement designed to mitigate front-running and sandwich attacks. Read the [security model](https://ophis.fi/security/) for the protection and its limits. The live quote is the practical check for your trade.

## What can you swap?

Start by identifying the asset on the correct network. [Robinhood's official token-contract reference](https://docs.robinhood.com/chain/contracts/) lists these two assets used in the example below:

| Asset | Robinhood Chain contract |
| --- | --- |
| **WETH**, wrapped ETH | [`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`](https://robinhoodchain.blockscout.com/address/0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73) |
| **USDG**, Global Dollar | [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) |

WETH is the token form of ETH; native ETH is also used to pay network gas. Ophis can request quotes for supported token pairs and Stock Tokens when a route and sufficient liquidity are available. A token appearing in a list is not a promise that every trade size can be filled.

For Stock Tokens, pay attention to the asset information in the app. Ophis can display checks against published token records, information about corporate actions such as stock splits, and available trading-restriction data. If the information cannot be retrieved, do not treat the asset as verified.

A familiar ticker alone is not enough to identify a token. Check the token details, applicable eligibility requirements, and product terms. The [tokenized-assets overview](https://ophis.fi/tokenized-stocks-rwa/) provides more context.

## A real WETH-to-USDG quote example

On **September 26, 2026 at 23:08 UTC**, we requested an indicative quote from Ophis's public Robinhood Chain orderbook:

| Quote detail | Recorded result |
| --- | --- |
| Requested sale | **0.01 WETH** |
| Returned buy amount | **26.891814 USDG** |
| Quoted execution-fee amount | **0.00000639474819 WETH**, included in the requested sale |
| Quote expiry | September 26, 2026 at 23:09:14 UTC |

The [saved request and response](/evidence/robinhood-quote-2026-09-26.json) show the amounts and quote ID **10825**. The request included Ophis's 0.01% base-fee metadata and used a neutral address. No order was signed or submitted. This is evidence of a returned quote at that time, not a completed trade or a price available now.

The returned buy amount is an estimate, **not the signed minimum**. The app prepares the final order with the applicable fees and your slippage setting. The quoted execution-fee field is not the whole Ophis fee policy. Request a fresh quote for your wallet and compare the final amounts before signing.

## How to swap on Robinhood Chain with Ophis

### 1. Open the Robinhood Chain swap page

Visit [Ophis on Robinhood Chain](https://swap.ophis.fi/#/4663/swap). Check that Robinhood Chain is selected before choosing your assets.

### 2. Connect a compatible wallet

Use a wallet that supports the network and contains the asset you want to sell. Review any connection request in your wallet.

### 3. Choose your tokens and amount

Select what you want to sell and receive, then enter the amount.

### 4. Review the quote

Check the expected amount, minimum received, fees, and any asset notices. If no quote is available, the selected pair or amount may not have an executable route at that time.

### 5. Approve if needed, then sign

Your wallet may request a token approval before your first swap of that token. Review this separately from the swap order. Sign the order when its details match what you intend to do.

### 6. Follow the order status

Keep track of the order in Ophis until it completes or its status changes. Signing submits your instructions; it does not by itself mean the trade has finished.

The [existing Robinhood Chain guide](https://ophis.fi/blog/swap-on-robinhood-chain/) covers the process in more depth.

## What fees should you expect?

Ophis charges a **0.01% base fee plus a capped share of price improvement** over its reference quote. On Robinhood Chain, the published Ophis fee policy is:

| Pair category | Improvement capture | Maximum Ophis charge, including the base |
| --- | --- | --- |
| Volatile pairs | 80% of improvement, capped at 0.99% of trade volume | 1.00% |
| Stable pairs | 50% of improvement, capped at 0.20% of trade volume | 0.21% |

These are caps, not a fixed charge on every swap. Improvement is measured against the reference quote, not your slippage limit. Execution costs, token approvals and price impact are separate considerations. Robinhood Chain uses Ophis's own deployment, so it does not add the upstream CoW-hosted fee layer. See the [current pricing policy](https://ophis.fi/pricing/) and [fee documentation](https://docs.ophis.fi/fees).

Supported signed token swaps have their settlement gas handled by the solver. However, token approvals, selling native ETH, and other direct wallet transactions can require ETH for gas.

“Gasless swap” therefore describes how settlement is handled. It does not mean that trading has no costs or that you will never need a gas balance. Read the [gasless swaps guide](https://ophis.fi/blog/gasless-swaps-how-intents-work/) for the practical distinctions.

## How does Ophis compare with KyberSwap and LI.FI?

These services can reach overlapping liquidity. Compare the flow you want to use as well as the quote:

| Option | What you use it for | What to compare |
| --- | --- | --- |
| **Ophis** | Sign an intent with a minimum output; Ophis handles routing and batch settlement on Robinhood Chain. | Net output, signed minimum, Ophis fees and any approval or native-ETH placement gas. |
| **KyberSwap** | Use its swap interface or aggregator API to build a route across supported DEX liquidity. Its published network list includes Robinhood Chain. | The quote for the same assets and amount, route costs, transaction gas and any integration fee. |
| **LI.FI** | Use its routing tools for supported swaps and bridges. Ophis's Robinhood integration uses same-chain routes. | Whether you need a same-chain swap or a bridge, the available route, total costs and destination amount. |

Sources: [KyberSwap Aggregator](https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator), [KyberSwap network support](https://docs.kyberswap.com/getting-started/supported-exchanges-and-networks), and [LI.FI's system overview](https://docs.li.fi/introduction/lifi-architecture/system-overview).

For a useful comparison, use the **same network, token contracts, amount and time**, then compare final output and minimum received. This table describes product differences; the quote example above is not a head-to-head price benchmark.

## FAQ

### Which DEX aggregator can I use on Robinhood Chain?

Ophis supports Robinhood Chain through its own orderbook and settlement deployment. Open the Robinhood Chain swap page, choose supported tokens and an amount, and check the available quote before signing an order with your wallet.

### Is Ophis an official Robinhood product?

No. Ophis is an independent protocol supporting Robinhood Chain. It is not affiliated with or endorsed by Robinhood Markets, Inc.

### Can I use Ophis to trade assets in my Robinhood brokerage account?

The Ophis flow described here uses a connected blockchain wallet. Do not assume assets held in a brokerage account are available for an Ophis swap.

### Can I swap Stock Tokens on Ophis?

Ophis supports quotes for eligible, supported Stock Token pairs when executable liquidity is available. Review the asset information and applicable restrictions before signing.

### Do I need ETH to swap on Robinhood Chain?

You may need ETH for a token approval, a native-ETH sell, or another direct transaction. Supported signed token orders let the solver handle settlement gas.

### Does a DEX aggregator guarantee the lowest price?

No. An aggregator searches the routes it can access. Your result depends on the pair, amount, available liquidity, and costs. Compare the actual quote and minimum received.

### Why is there no quote for my Robinhood Chain swap?

Check the selected network, token contracts and amount. A pair may lack liquidity, an asset may carry restrictions, a service may be unavailable, or the amount may be too small to cover execution costs. Review the app's error message and the [Ophis service checks](https://docs.ophis.fi/status). Do not sign an order using an expired quote.

### What happens if my order does not fill?

An unfilled signed ERC-20 order can expire without a settlement transaction. An approval you already submitted can still have cost gas. Selling native ETH uses an on-chain order-placement transaction, so an unfilled native-ETH order follows the refund process described in the [Robinhood engineering guide](https://ophis.fi/blog/swap-on-robinhood-chain/#what-happens-if-my-order-cannot-be-filled).

## Check your next Robinhood Chain swap

Start with the asset you have and the asset you want. Ophis brings route selection, quote review, and wallet signing into one flow, so you can decide with the trade details in front of you.

**[Open Ophis on Robinhood Chain and check your quote](https://swap.ophis.fi/#/4663/swap).**
