---
id: architecture
title: How it works
description: The Ophis intent lifecycle, parsing, batch auctions, solver competition, and settlement on CoW Protocol contracts.
sidebar_label: How it works
sidebar_position: 2
---

# How it works

Ophis sits on top of [CoW Protocol](https://docs.cow.fi/cow-protocol)'s
batch-auction settlement layer. The app opens a token-selection form; developers
can optionally use the natural-language parser before building an order.
Circle and other cross-chain routes have separate execution and recovery steps.

## The intent lifecycle

```
 plain English          structured order           batch auction          settlement
┌──────────────┐  parse ┌──────────────────┐ sign ┌──────────────────┐    ┌──────────────┐
│ "swap 100    │ ─────▶ │ sell: USDC       │ ───▶ │ solvers compete  │ ─▶ │ uniform-price│
│  USDC for    │  LLM   │ buy:  ETH        │ wallet│ for best execution│   │ on-chain     │
│  ETH on Base"│        │ amount: 100      │      │ (DEX / P2P / xchain)│  │ settlement   │
└──────────────┘        │ chain: base      │      └──────────────────┘    └──────────────┘
                        └──────────────────┘
```

### 1. Intent parsing

Free-form text is sent to a [Cloudflare Pages Function](./intent-api.md)
that proxies [LibertAI](https://libertai.io)'s **Qwen 3.6 27B**
(open-weights, hosted on Aleph Cloud) with a pinned system prompt and
`temperature: 0` to reduce extraction variability. The proxy:

- holds the LibertAI API key server-side (browsers never see it),
- validates symbol syntax and source-text spans, not token contracts,
- validates the chain against its 13 supported slugs (not yet Arc), and
- returns a structured `ParsedIntent` the UI uses to pre-fill the form.

The parser **only normalizes language**. It never places, signs, or
executes a trade, that is always the user's wallet on the frontend.

### 2. Order signing

Once the form is filled, the user signs an order with their own wallet
(EIP-712 for EOAs, ERC-1271 for smart-contract wallets). The signature
authorizes a _limit_, a minimum acceptable output, not a specific
execution path. Solvers may only do better than the limit, never worse.

### 3. Batch auction & solver competition

Signed orders collect into batches. For each batch, solvers search for
the best way to settle every order simultaneously, routing through
on-chain liquidity, matching orders against each other peer-to-peer
(no liquidity pool needed), or bridging cross-chain. Solvers bid, and
the one that maximises total surplus wins the right to settle.

On Optimism, Unichain, Robinhood Chain, and Arc, Ophis runs its own stack and operates the
solver itself, competing across several routing strategies (a baseline on-chain
router plus multiple DEX aggregators) that bid against each other per batch, so
there is genuine price competition even though the solver is Ophis-operated. The
on-chain allowlist (`GPv2AllowListAuthentication`) controls who may settle, and
additional independent solvers can be authorized over time. On the CoW-hosted
chains Ophis surfaces, CoW's established solver network competes. Your protection
is identical either way: the limit price in your signed order is enforced
on-chain, so any solver can only fill it at or better than the price you signed.

### 4. Uniform-price settlement

The winning solver settles the batch onchain using uniform clearing prices
per token pair and enforcing each order's signed limits. Offchain ERC-20 orders
avoid the user's public-mempool router transaction, and peer matching can avoid
an AMM leg. These mechanisms mitigate MEV; they do not eliminate all risks in
solver execution, external liquidity, sequencers or bridge delivery.
See [Security & audits](./audits.md#mev-protection-by-construction).

## What Ophis runs

| Component | Description |
| --- | --- |
| **Frontend** | A fork of the CoW Swap frontend with token selection, route review and provider-specific bridge flows. |
| **Intent-parser proxy** | A Cloudflare Pages Function in front of LibertAI Qwen 3.6 27B. See [Intent API](./intent-api.md). |
| **Self-hosted orderbook & solver** | Ophis operates Optimism, Unichain, Robinhood Chain and Arc; see the hosts in [Status](./status.md). CoW-hosted chains use `api.cow.fi` and CoW's solver network. |
| **Settlement contracts** | Ophis deployments of `GPv2Settlement`, alongside allowlist and fee-handling contracts. Deployment configuration and review scope matter; see [Security & audits](./audits.md). |
| **Rebate indexer** | Indexes volume-tier rebates that accrue to traders. See [Fees & rebates](./fees.md). |

## Cross-chain via NEAR Intents

Solana, Bitcoin, Monad, Hyperliquid, X Layer, Sui and Tron are available as
**output destinations** through NEAR Intents for supported sources and assets.
The user supplies the destination address and authorizes the source flow.
Destination delivery is separate from source settlement and can require recovery.
Across and Circle routes have different coverage and wallet restrictions; see
[Networks & assets](./networks-assets.md).

## Where to go next

- Make a swap: [Getting started](./getting-started.md)
- Integrate programmatically: [Intent API](./intent-api.md) ·
  [AI agents](./ai-agents.md)
- Fee mechanics: [Fees & rebates](./fees.md)
