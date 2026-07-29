---
id: getting-started
title: Getting started
description: Make your first swap on Ophis and understand the three-step intent flow.
sidebar_label: Getting started
sidebar_position: 1
---

import Head from '@docusaurus/Head';

{/* HowTo schema.org structured data for AEO / answer engines, built from the
    three-step intent flow described below. JSON.stringify handles all
    quote/apostrophe escaping at build time. A type=application/ld+json block is
    inert data (not executed JS), so it is not governed by script-src. */}
export const howToLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'How to make your first swap on Ophis',
  description:
    'Ophis turns a natural-language sentence into a settled, MEV-protected swap in three steps: intent parsing, a solver auction, and on-chain batch settlement.',
  totalTime: 'PT2M',
  supply: [
    { '@type': 'HowToSupply', name: 'An EVM wallet' },
    { '@type': 'HowToSupply', name: 'A token balance to swap from on a supported chain' },
  ],
  tool: [{ '@type': 'HowToTool', name: 'Ophis at ophis.fi' }],
  step: [
    {
      '@type': 'HowToStep',
      name: 'Intent: parse the request',
      url: 'https://docs.ophis.fi/getting-started#1--intent-parse-the-request',
      text: 'Open ophis.fi, connect your wallet, and type the swap as a plain sentence such as swap 100 USDC for ETH on Base. An open LLM extracts the sell token, buy token, amount, and chain into a structured order and pre-fills the swap form. Ophis is non-custodial and charges a flat 0.10% (10 bps) fee on trade volume, or 0.01% (1 bp) on same-chain stablecoin-to-stablecoin swaps.',
    },
    {
      '@type': 'HowToStep',
      name: 'Auction: solver competition',
      url: 'https://docs.ophis.fi/getting-started#2--auction-solver-competition',
      text: 'Review the quote and sign the order with your wallet. The signed order is broadcast to a batch auction where solvers compete to find the best path: an on-chain DEX, a peer-to-peer match in the same batch, or a cross-chain route.',
    },
    {
      '@type': 'HowToStep',
      name: 'Settle: on-chain, MEV-protected',
      url: 'https://docs.ophis.fi/getting-started#3--settle-on-chain-mev-protected',
      text: 'The winning solver settles the signed order without exposing it as a public-mempool router swap. The signed limit price is enforced on-chain; on Robinhood Chain, paying a higher priority fee does not buy earlier sequencer ordering. Ophis takes no cut of surplus: on the Ophis-operated chains (Optimism, Unichain, Robinhood Chain) 100% of price surplus goes to the trader; on CoW-hosted chains CoW Protocol retains 50% of quote improvement.',
    },
  ],
};

<Head>
  <script type="application/ld+json">{JSON.stringify(howToLd)}</script>
</Head>

# Getting started

Ophis turns a sentence into a settled, MEV-protected swap. There's no
token-picker to fight and no router to configure, you describe the
trade, review it, and sign.

## Your first swap

1. Open [ophis.fi](https://ophis.fi) and connect a wallet.
2. Type what you want in your own words, for example:
   - `swap 100 USDC for ETH on Base`
   - `buy 50 USDC of PEPE on ethereum`
   - `1 ETH to USDC on op`
3. Ophis parses your sentence into a structured order (sell token, buy
   token, amount, chain) and pre-fills the swap form.
4. Review the quote and **sign the order with your wallet.** Nothing
   leaves your wallet until a solver settles the trade.

:::note[Non-custodial by design]

Ophis never takes possession of your funds. The signed order is
broadcast to the solver auction; your tokens move only when a solver
settles the batch on-chain.

:::

## How it works

Three steps from your sentence to settlement:

### 1 · Intent, parse the request

You type the swap as a sentence. An open LLM (LibertAI's Qwen 3.6 27B,
hosted on Aleph Cloud) extracts the sell token, buy token, amount, and
chain into a structured order. The model runs behind a server-side proxy
so its API key never reaches the browser. See the
[Intent API](./intent-api.md) for the public endpoint.

### 2 · Auction, solver competition

Your signed order is broadcast to a batch auction. Solvers race to find
the best path, an on-chain DEX, a peer-to-peer match against another
order in the same batch, or a cross-chain route, and bid for the right
to settle it. On Optimism, Unichain, and Robinhood Chain, Ophis currently operates the solver itself,
competing across several routing strategies, see [How it works](./architecture.md).

### 3 · Settle, on-chain, MEV-protected

The winning solver settles your order in a batch where every trade
clears at the same uniform price. Your signed limit price is enforced
on-chain, and Ophis orders are not exposed as public-mempool router swaps.
On Robinhood Chain, the sequencer is first-come-first-served, so paying a
higher priority fee does not buy an earlier place in the ordering.

For the full lifecycle, see [How it works](./architecture.md).

## Supported networks

Ophis surfaces **13 EVM chains** as full source _and_ destination in the
network selector: Ethereum, Arbitrum One, Avalanche, Base, BNB Smart
Chain, Gnosis Chain, Ink, Linea, Optimism, Plasma, Polygon, Robinhood Chain, and Unichain
(plus the Sepolia testnet). On any of these you can both pay from and receive into
your EVM wallet.

|          |                 |                 |
| -------- | --------------- | --------------- |
| Ethereum | Arbitrum One    | Avalanche       |
| Base     | BNB Smart Chain | Gnosis Chain    |
| Ink      | Linea           | Optimism        |
| Plasma   | Polygon         | Robinhood Chain |
| Unichain |                 |                 |

In addition, **Solana** and **Bitcoin** are available as cross-chain
_destinations only_ via [NEAR Intents](https://near.org/intents): trade
from any EVM source chain to those networks without a second wallet. They
are not source chains, you cannot start a swap from a Solana or Bitcoin
balance. You paste a destination address and sign with your EVM wallet;
NEAR Intents brokers the bridge.

The current token catalog covers stablecoins, ETH/BTC pegs, DeFi
blue-chips, AI/RWA, memes, and gaming. The in-app token selector is the
live source of truth because token availability can change by chain.

### Robinhood Stock Tokens

Robinhood Chain includes tokenized equities and ETFs. Ophis verifies a selected
Stock Token against Robinhood's live canonical deployment registry and shows its
corporate-action multiplier and trading restrictions in the swap form. A split
can change the share-equivalent display without rebasing the raw ERC-20 balance;
the executable trade price remains the signed Ophis solver quote.

- [Robinhood Chain network configuration](https://docs.robinhood.com/chain/connecting/)
- [Stock Token integration and multiplier](https://docs.robinhood.com/chain/stock-tokens/)
- [Bridge assets to Robinhood Chain](https://docs.robinhood.com/chain/bridging/)

Swaps are gasless. Wallet approvals, wrapping, and other direct transactions
still require ETH. Robinhood's public RPC is rate-limited; production
integrations should use a supervised provider endpoint and reserve the public
RPC for wallet configuration and fallback use.

:::tip[Building on Ophis?]

Skip the UI entirely, the [Intent API](./intent-api.md) exposes the same
natural-language parser as a public endpoint, and the
[AI agent guide](./ai-agents.md) shows how to wire it into an agent.

:::
