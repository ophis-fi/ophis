---
id: getting-started
title: Getting started
description: Make your first Ophis swap by choosing tokens, reviewing the quote and signing with your wallet.
sidebar_label: Getting started
sidebar_position: 1
---

import Head from '@docusaurus/Head';

export const howToLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'How to make a batch-auction swap on Ophis',
  description: 'Choose tokens and an amount, review and sign your order, then follow settlement.',
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
      text: 'Open swap.ophis.fi/#/swap and connect your EVM wallet. Select the token and network in You sell, enter an amount, then select the token and network in You receive.',
    },
    {
      '@type': 'HowToStep',
      name: 'Review and sign',
      url: 'https://docs.ophis.fi/getting-started#2--auction-solver-competition',
      text: 'Check the quote, fees, destination address and spending limit. Approve the displayed token amount if requested, then sign the order in your wallet.',
    },
    {
      '@type': 'HowToStep',
      name: 'Track settlement',
      url: 'https://docs.ophis.fi/getting-started#3--settle-on-chain-mev-protected',
      text: 'Follow the order in the app. A solver finds a route and settles the trade within your signed limits. For a cross-chain route, follow the transfer until the destination receives the tokens.',
    },
  ],
};

<Head>
  <script type="application/ld+json">{JSON.stringify(howToLd)}</script>
</Head>

# Getting started

Choose your tokens, review the quote and approve your first swap in your wallet.

## Your first swap

<Steps>

1. **Choose tokens and amount.** <span id="1--intent-parse-the-request" /> Open [swap.ophis.fi/#/swap](https://swap.ophis.fi/#/swap) and connect your EVM wallet. Select the token and network in **You sell**, enter an amount, then select the token and network in **You receive**.
2. **Review and sign.** <span id="2--auction-solver-competition" /> Check the quote, fees, destination address and spending limit. Approve the displayed token amount if requested, then sign the order in your wallet.
3. **Track settlement.** <span id="3--settle-on-chain-mev-protected" /> Follow the order in the app. A solver finds a route and settles the trade within your signed limits. For a cross-chain route, follow the transfer until the destination receives the tokens.

</Steps>

:::tip[Keep gas for approvals]

Signing an ERC-20 order is gasless. Token approvals, wrapping and deposits require the network's gas currency. Standard ERC-20 orders keep your tokens in your wallet until settlement.

:::

## Fund an external swap

Use the standalone app to swap from a NEAR Intents source such as Bitcoin or Solana.

<Steps>

1. **Select the route.** Choose the source in **You sell** and the destination in **You receive**.
2. **Enter your addresses.** Check the destination address and provide a refund address on the source chain.
3. **Fund the deposit.** Confirm the quote and send the specified amount before its deadline, including any required memo.
4. **Keep the transfer record.** Use it to track delivery or recover a refund.

</Steps>

See [Networks & assets](/networks-assets#externally-funded-swaps-through-near-intents) for address requirements and bridge coverage.

## Supported networks

| Network group | Coverage |
| --- | --- |
| App and CLI total | 15 EVM networks, including the Sepolia testnet |
| EVM mainnets (14) | Ethereum, Arbitrum One, Avalanche, Base, BNB Smart Chain, Gnosis Chain, Ink, Linea, Optimism, Plasma, Polygon, Robinhood Chain, Unichain, and Arc |
| Testnet | Sepolia |
| NEAR Intents sources and destinations | Solana, Bitcoin, Monad, Hyperliquid (Hypercore), X Layer, Sui, Tron, Starknet, Zcash |

Use the token selector to find assets on each network. Arc is available in the swap app (chain ID 5042), uses USDC for gas and connects through Circle bridges.

## Stock tokens {/* #robinhood-stock-tokens */}

On Robinhood Chain, Ophis checks Stock Tokens against Robinhood's canonical registry and displays trading restrictions and the corporate-action multiplier. A split changes the share-equivalent display while the raw ERC-20 balance stays the same.

See Robinhood's [network configuration](https://docs.robinhood.com/chain/connecting/), [Stock Token guide](https://docs.robinhood.com/chain/stock-tokens/) and [bridging guide](https://docs.robinhood.com/chain/bridging/).

## Next

<Cards>
<Card icon="terminal" title="Ophis CLI" href="/cli">Make swaps from your terminal.</Card>
<Card icon="receipt" title="Fees" href="/fees">Check base fees and price-improvement capture.</Card>
<Card icon="workflow" title="How it works" href="/architecture">Follow an order from signing to settlement.</Card>
<Card icon="code" title="Intent API" href="/intent-api">Add natural-language parsing to your app.</Card>
</Cards>
