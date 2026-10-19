---
id: intro
title: Ophis DEX Aggregator Documentation
description: Ophis lets you swap tokens across networks with your own wallet.
slug: /
sidebar_label: Introduction
sidebar_position: 1
---

# Ophis

Ophis is a token swap service built on CoW Protocol that finds routes for the trade you approve in your wallet.

## Make a swap

<Steps>

1. **Choose your tokens.** Open [the swap app](https://swap.ophis.fi), select the networks and tokens, and enter an amount.
2. **Review the quote.** Check the fees, destination address and minimum amount you will receive.
3. **Authorize the trade.** Sign the order in your wallet, or fund the quoted deposit for an external-source swap.

</Steps>

## How trading works

<Cards>
<Card icon="wallet" title="Wallet approval">You approve each order in your own wallet.</Card>
<Card icon="scale" title="Signed limits">The settlement contract enforces the minimum amount you accept.</Card>
<Card icon="layers" title="Batch auctions">Solvers find routes and settle trades at a uniform price per token pair.</Card>
<Card icon="globe" title="Cross-chain swaps" href="/networks-assets">Use NEAR Intents, Circle or Across routes in the swap app.</Card>
</Cards>

Standard ERC-20 orders keep funds in your wallet until settlement; native-token and bridge routes use onchain deposits.

## Swap fees

| Component | Rate |
| --- | --- |
| Ophis base fee | 1 bp |
| Volatile-pair improvement capture | 80% of reference-quote improvement, capped at 99 bps of volume |
| Stable-pair improvement capture | 50% of reference-quote improvement, capped at 20 bps of volume |
| CoW-hosted chains | CoW Protocol's own fees apply in addition |

See [Fees](/fees) for order eligibility and bridge costs.

## Build with Ophis

<Cards>
<Card icon="braces" title="SDK" href="/partners">Build and submit wallet-signed orders in your app.</Card>
<Card icon="bot" title="MCP server" href="/ai-agents">Connect your AI assistant to Ophis tools.</Card>
<Card icon="code" title="Intent API" href="/intent-api">Parse natural-language requests into structured trade fields.</Card>
<Card icon="app-window" title="Swap widget" href="/widget">Embed the swap interface in your app.</Card>
</Cards>

Find the [source code](https://github.com/ophis-fi/ophis), [OpenAPI spec](https://ophis.fi/openapi.json) and [machine-readable summary](https://ophis.fi/llms.txt) online.

## Next

<Cards>
<Card icon="rocket" title="Getting started" href="/getting-started">Make your first swap.</Card>
<Card icon="terminal" title="Ophis CLI" href="/cli">Swap and bridge from your terminal.</Card>
<Card icon="shield-check" title="Security and audits" href="/audits">Review wallet custody and settlement contracts.</Card>
</Cards>
