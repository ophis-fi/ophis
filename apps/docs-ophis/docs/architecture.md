---
id: architecture
title: How it works
description: The Ophis intent lifecycle — parsing, batch auctions, solver competition, and settlement on CoW Protocol contracts.
sidebar_label: How it works
sidebar_position: 2
---

# How it works

Ophis sits on top of [CoW Protocol](https://docs.cow.fi/cow-protocol)'s
batch-auction settlement layer and adds a natural-language front door.
This page traces a swap from a sentence to an on-chain settlement.

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
`temperature: 0` for deterministic extraction. The proxy:

- holds the LibertAI API key server-side (browsers never see it),
- validates extracted tokens against an internal allowlist of 200+
  DEX-traded symbols,
- validates the chain against the set the network selector can actually
  route to, and
- returns a structured `ParsedIntent` the UI uses to pre-fill the form.

The parser **only normalizes language**. It never places, signs, or
executes a trade — that is always the user's wallet on the frontend.

### 2. Order signing

Once the form is filled, the user signs an order with their own wallet
(EIP-712 for EOAs, ERC-1271 for smart-contract wallets). The signature
authorizes a _limit_ — a minimum acceptable output — not a specific
execution path. Solvers may only do better than the limit, never worse.

### 3. Batch auction & solver competition

Signed orders collect into batches. For each batch, solvers search for
the best way to settle every order simultaneously — routing through
on-chain liquidity, matching orders against each other peer-to-peer
(no liquidity pool needed), or bridging cross-chain. Solvers bid, and
the one that maximises total surplus wins the right to settle.

### 4. Uniform-price settlement

The winning solver settles the batch on-chain. Every trade in a batch
clears at the **same uniform price**, which is what eliminates these
order-level MEV vectors by construction:

- **No front-running** — there's no pending-order mempool race to win.
- **No sandwiching** — the protocol does not reorder trades for value.
- **No priority-gas auction** — execution order inside a batch is not
  for sale.

## What Ophis runs

| Component | Description |
| --- | --- |
| **Frontend** | A fork of the CoW Swap frontend with the natural-language intent layer added. |
| **Intent-parser proxy** | A Cloudflare Pages Function in front of LibertAI Qwen 3.6 27B. See [Intent API](./intent-api.md). |
| **Self-hosted orderbook** | Ophis runs CoW Protocol orderbook instances per chain (e.g. `optimism-mainnet.ophis.fi`). CoW-aligned chains use `api.cow.fi`. |
| **Settlement contracts** | CoW Protocol's `GPv2Settlement` (unchanged code), deployed and operated by Ophis on Optimism, alongside Ophis-specific allowlist + fee-handling contracts. See [Security & audits](./audits.md). |
| **Rebate indexer** | Indexes positive-slippage rebates that accrue to traders. See [Fees & rebates](./fees.md). |

## Cross-chain via NEAR Intents

Solana and Bitcoin are available as **output destinations**. When a swap
targets one of them, [NEAR Intents](https://near.org/intents) brokers the
bridge: the user signs with their EVM wallet and provides a destination
address on the target network. No second wallet, no manual bridging step.

## Where to go next

- Make a swap: [Getting started](./getting-started.md)
- Integrate programmatically: [Intent API](./intent-api.md) ·
  [AI agents](./ai-agents.md)
- Fee mechanics: [Fees & rebates](./fees.md)
