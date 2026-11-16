---
id: architecture
title: How it works
description: Follow Ophis batch-auction orders, direct swaps, private swaps and cross-chain transfers from authorization to settlement.
sidebar_label: How it works
sidebar_position: 2
---

# How it works

Ophis compares available routes for your trade. Public swaps can use a signed batch-auction order or a direct transaction; cross-chain transfers and private swaps use separate execution flows.

## Batch-auction order lifecycle {/* #the-intent-lifecycle */}

<Steps>

1. **Choose the trade.** Select tokens, networks and an amount in the swap app, or build an order with the SDK.
2. **Sign the order.** Your wallet authorizes the sell amount and minimum output using EIP-712 for EOAs or ERC-1271 for smart-contract wallets.
3. **Enter the auction.** Solvers compare onchain liquidity and peer-to-peer matches, then bid to settle the batch.
4. **Settle the trade.** The winning solver submits the batch onchain with uniform clearing prices per token pair and enforced order limits.

</Steps>

Offchain order submission, uniform clearing prices and peer matching reduce front-running and sandwich opportunities. See [Security & audits](/audits#mev-protection-by-construction).

## Settlement operators

| Networks | Orderbook and solvers |
| --- | --- |
| Optimism, Unichain, Robinhood Chain, Arc | Ophis operates the orderbook and solver |
| Ethereum, Arbitrum, Avalanche, Base, BNB Chain, Gnosis, Ink, Linea, Plasma, Polygon | Partner-operated orderbooks and solver network |

The onchain `GPv2AllowListAuthentication` contract controls which solvers can settle orders. Each settlement enforces your signed limit price.

## Other swap paths

A direct swap executes a quoted transaction from your wallet and requires network gas. It does not enter a batch auction. The form shows the selected route and its minimum output before approval.

Private mode uses a RAILGUN shielded wallet on Ethereum, Arbitrum, Polygon or BNB Chain. Its supported pool routes and broadcaster fees differ from public batch auctions. See [private swaps](/networks-assets#private-swaps) and [Fees](/fees#private-swap-costs).

## Developer intent parsing

The [Intent API](/intent-api) converts natural language into a structured `ParsedIntent` for your app or agent to use when building an order.

```
 plain English          structured order           batch auction          settlement
┌──────────────┐  parse ┌──────────────────┐ sign ┌──────────────────┐    ┌──────────────┐
│ "swap 100    │ ─────▶ │ sell: USDC       │ ───▶ │ solvers compete  │ ─▶ │ uniform-price│
│  USDC for    │  LLM   │ buy:  ETH        │ wallet│ for best execution│   │ on-chain     │
│  ETH on Base"│        │ amount: 100      │      │ (DEX / peer match)│  │ settlement   │
└──────────────┘        │ chain: base      │      └──────────────────┘    └──────────────┘
                        └──────────────────┘
```

| Parser setting | Value |
| --- | --- |
| Model | LibertAI Qwen 3.6 27B, hosted on Aleph Cloud |
| Temperature | `0` |
| Chain validation | 14 supported slugs, including Arc |
| Output checks | Symbol syntax and source-text spans |

A Cloudflare Pages Function holds the LibertAI API key server-side and validates the response. Your integration resolves token contracts, requests a quote and asks the wallet to sign.

## Ophis components {/* #what-ophis-runs */}

<Cards>
<Card icon="app-window" title="Swap app">Select tokens, review quotes and follow bridge transfers.</Card>
<Card icon="code" title="Intent API" href="/intent-api">Turn natural-language requests into trade fields.</Card>
<Card icon="server" title="Orderbooks" href="/status">Submit signed orders to the service for your chain.</Card>
<Card icon="shield-check" title="Settlement contracts" href="/audits">Enforce signed orders through GPv2Settlement.</Card>
</Cards>

## Cross-chain transfers {/* #cross-chain-via-near-intents */}

| Provider | Flow |
| --- | --- |
| NEAR Intents | Source order or external deposit followed by destination delivery |
| Circle | Direct asset bridging with transfer tracking and recovery |
| Across | Bridging through supported source and destination networks |

For an external NEAR source, select the route in the standalone app, provide the destination and source refund addresses, then fund the quoted deposit. Keep the transfer record until delivery or refund completes.

## Next

<Cards>
<Card icon="rocket" title="Getting started" href="/getting-started">Make a wallet-signed swap.</Card>
<Card icon="globe" title="Networks and assets" href="/networks-assets">Check bridge coverage and wallet requirements.</Card>
<Card icon="receipt" title="Fees" href="/fees">See how each settlement path charges fees.</Card>
</Cards>
