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
    'Choose tokens and an amount, review and sign your order, then follow settlement.',
  totalTime: 'PT2M',
  supply: [
    { '@type': 'HowToSupply', name: 'An EVM wallet' },
    { '@type': 'HowToSupply', name: 'A token balance to swap from on a supported chain' },
  ],
  tool: [{ '@type': 'HowToTool', name: 'Ophis at ophis.fi' }],
  step: [
    {
      '@type': 'HowToStep',
      name: 'Choose tokens and amount',
      url: 'https://docs.ophis.fi/getting-started#1--intent-parse-the-request',
      text: 'Open swap.ophis.fi, connect your wallet, and select the tokens, networks, and amount. Review the quote, destination address, and spending limit before signing. Ophis is non-custodial; fee terms depend on whether the chain is Ophis-operated or CoW-hosted.',
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
      text: 'The winning solver settles the signed order without exposing it as a public-mempool router swap. The signed limit price is enforced on-chain. Ophis retains its published capped share of improvement on every supported chain; CoW-hosted chains additionally apply CoW Protocol upstream fees.',
    },
  ],
};

<Head>
  <script type="application/ld+json">{JSON.stringify(howToLd)}</script>
</Head>

# Getting started

Choose your tokens, review the quote, and sign with your wallet.

## Your first swap

1. Open [the swap app](https://swap.ophis.fi/#/swap) and connect a wallet.
2. Select the token and network you want to pay from, then enter the amount.
3. Open **You receive** to select the destination network and token. For
   Solana or Bitcoin, enter an address on that destination network.
4. Review the quote, fees, destination address, and spending limit. Approve
   the displayed amount if needed, then **sign the order with your wallet**.

:::note[Non-custodial by design]

Ophis never takes possession of your funds. The signed order is
broadcast to the solver auction; your tokens move only when a solver
settles the batch on-chain.

:::

## How it works

Three steps from token selection to settlement:

<span id="1--intent-parse-the-request" />

### 1 · Choose tokens and amount

The swap form opens directly. Select the assets and networks, enter the
amount, and review the quote and spending limit. Developers and agents can
still use the [Intent API](./intent-api.md) for natural-language requests.

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

Skip the UI entirely, the [Intent API](./intent-api.md) exposes a
natural-language parser as a public endpoint, and the
[AI agent guide](./ai-agents.md) shows how to wire it into an agent.

:::
