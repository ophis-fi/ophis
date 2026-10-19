---
id: comparison
title: How Ophis compares
description: Compare Ophis quotes, settlement, fees and developer tools for the trade you want to make.
sidebar_label: Compare Ophis
---

# How Ophis compares

Compare the amount you receive, wallet requirements and available routes for the same trade.

## Compare a quote

<Steps>

1. **Match the trade.** Use the same assets, amount, source network and destination on each service.
2. **Check the output.** Compare the final amount received after fees, including wallet gas and bridge costs.
3. **Review the flow.** Check order expiry, cancellation, destination-wallet requirements and bridge recovery before signing.

</Steps>

See [CoW fees](https://docs.cow.fi/governance/fees), [Matcha help](https://help.matcha.xyz/) and [Velora documentation](https://docs.velora.xyz/docs) for their current terms.

## Intent-based settlement {/* #what-intent-based-means */}

In an Ophis batch-auction swap, you sign the sell amount, receiver, minimum buy amount and expiry. Solvers find a route within those limits.

<Cards>
<Card icon="scale" title="Signed limits">The settlement contract enforces the minimum output you accept.</Card>
<Card icon="layers" title="Batch auctions">Orders settle at a uniform clearing price per token pair.</Card>
<Card icon="wallet" title="Wallet custody">Standard ERC-20 orders keep funds in your wallet until settlement.</Card>
</Cards>

Offchain orders and batch auctions reduce front-running and sandwich opportunities. Native-token and bridge deposits use the route's funding and recovery flow.

## CoW Protocol foundation {/* #ophis-is-built-on-cow-protocol */}

Ophis builds on CoW Protocol's settlement contracts.

| Stack | Networks | Operator |
| --- | --- | --- |
| Ophis-operated | Optimism, Unichain, Robinhood Chain, Arc | Ophis runs the orderbook and solver |
| CoW-hosted | Ten other mainnets | CoW runs the orderbooks and solver network |

## Available interfaces {/* #core-differences */}

| Interface | Use |
| --- | --- |
| Swap app | Select tokens, review quotes and authorize trades |
| SDK v0.4.3 / hosted MCP | Build batch-auction orders on 14 EVM mainnets, including Arc |
| Intent API | Parse natural-language requests into structured fields for your app or agent |
| Standalone NEAR Intents flow | Fund external deposits and track destination delivery |

| Additional NEAR sources and destinations |
| --- |
| Bitcoin, Solana, Monad, X Layer, Sui, Tron, Hyperliquid (Hypercore), Starknet, Zcash |

Circle and Across connect their supported networks through separate bridge flows. See [Networks & assets](/networks-assets) for source, asset and wallet requirements.

## Fee comparison

Ophis charges a 1 bp (0.01%) base fee plus a capped share of price improvement: 80% up to 99 bps on volatile pairs, 50% up to 20 bps on stable pairs. CoW-hosted chains add CoW Protocol's fees, and bridge routes add provider costs and gas. See [Fees](/fees) for the full table.

To compare venues, compare the final amount received for the same token pair and trade size.

## Next

<Cards>
<Card icon="receipt" title="Fees" href="/fees">Read the fee schedule and collection rules.</Card>
<Card icon="workflow" title="How it works" href="/architecture">Follow the order lifecycle.</Card>
<Card icon="activity" title="Status" href="/status">Find the services used by each network.</Card>
</Cards>
