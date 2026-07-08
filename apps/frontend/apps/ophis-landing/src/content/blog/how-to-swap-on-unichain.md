---
title: "How to swap on Unichain: gasless and MEV-protected"
description: "Step-by-step guide to swapping on Unichain with Ophis: connect a wallet, sign an EIP-712 order, and solvers settle it in a batch. Gasless, MEV-protected, 0.10% fee."
pubDate: 2026-07-14
author: Ophis
tags: [unichain, swaps, mev, defi, how-to]
draft: false
cover: ./how-to-swap-on-unichain.cover.jpg
coverAlt: "Ophis emblem with Unichain and supported chain logos"
---

To swap on Unichain, open [swap.ophis.fi/#/130/swap](https://swap.ophis.fi/#/130/swap), connect your wallet, pick or describe the pair, and sign an EIP-712 order. You never broadcast a transaction and you pay no gas for the swap itself: a network of competing solvers fills the order and settles it on-chain in a batch, MEV-protected by construction. The rest of this guide walks through each step, explains what happens after you sign, and covers the cost (a flat 0.10% fee, 0.01% for same-chain stablecoin-to-stablecoin trades).

Context in two sentences. Unichain is chain id 130, one of the twelve chains Ophis supports. [Ophis](https://ophis.fi/) is an intent-based DEX aggregator, a fork of [CoW Protocol](https://docs.cow.fi)'s frontend with a natural-language intent layer and an agent stack on top, and on Unichain it runs a deployment of its own, which matters in one specific way covered below.

## Swap on Unichain, step by step

1. **Open the app pinned to Unichain.** Go to `https://swap.ophis.fi/#/130/swap`. The `130` in the URL is Unichain's chain id, so the swap form loads already pointed at the right network.

2. **Connect your wallet.** Ophis is self-custodial: it never holds your funds, and nothing moves without a signature from your wallet (EIP-712 for regular accounts, ERC-1271 for smart-contract accounts).

3. **Pick the pair, or describe it.** Fill the form the usual way (sell token, buy token, amount), or type the trade in plain language, "swap 250 USDC for WETH", and the intent layer fills the form for you.

4. **Review the quote.** The quote carries a hard limit price, and that limit is what you sign: the worst execution you can receive. If solvers find a better price at settlement, 100% of the improvement goes to you, and the fee takes no share of that surplus.

5. **Sign the order.** Your wallet shows an EIP-712 typed-data message, not a transaction. Signing costs nothing: orders are gasless, no native token needed, and the 0.10% fee is taken in the token you sell.

6. **Wait for settlement.** Competing solvers race to fill the order, and the result settles on-chain in a batch. The order status updates on the page until the trade lands.

## Why there is no gas and no sandwich

The mechanism behind gasless signing and settlement is the same one that [removes MEV](/blog/mev-protection-batch-auctions/).

On a regular DEX you broadcast a swap into a public mempool, where searchers can sandwich it: buy in front of you, sell behind you, pocket the spread. On Ophis your order is an intent that stays off-chain until settlement. Solvers batch orders together and settle each batch at a uniform clearing price, so there is no transaction ordering inside a batch to exploit. The protection is structural (batch auction, uniform clearing price, off-chain order flow), not a best-effort add-on.

[Gaslessness](/blog/gasless-swaps-how-intents-work/) falls out of the same design. You sign, solvers settle, and the fee is taken in the token you sell, so a wallet with no ETH on Unichain can still trade.

## Ophis runs a sovereign deployment on Unichain

On most supported chains, Ophis settles through CoW Protocol's canonical audited GPv2 contracts via api.cow.fi. Unichain is one of only two chains, alongside [Optimism](/blog/how-to-swap-on-optimism/), where Ophis operates a sovereign deployment instead: its own orderbook and a bytecode-identical deployment of CoW Protocol's audited GPv2Settlement at a non-canonical address.

If you swap through the page, this changes nothing; the app targets the right contracts for chain 130. It matters if you integrate programmatically: an order built for the canonical CoW settlement domain will not verify against the Unichain deployment. Resolve the per-chain settlement domain via `@ophis/sdk` or the MCP `list_chains` tool instead of hardcoding anything.

## Fees and volume rebates

Every trade pays a flat 0.10% of volume. Same-chain stablecoin-to-stablecoin trades pay 0.01%. The fee is charged in the sell token and takes no share of any surplus your order earns.

Trade enough and part of it comes back. Rebate tiers run on rolling 30-day volume: Bronze ($20,000+) 10%, Silver ($50,000+) 15%, Gold ($100,000+) 25%, Palladium ($500,000+) 35%, Platinum ($1,000,000+) 50%. Rebates are paid monthly in WETH from the fee Safe, out of a pool of 21.25% of collected WETH fees split by tier-weighted 30-day volume. Your tier and progress show on the swap page, and the [fee docs](https://docs.ophis.fi/fees) have the full breakdown.

## Swapping on Unichain from an AI agent

The same rails are exposed to agents. Ophis runs a remote MCP server at [`https://mcp.ophis.fi/mcp`](https://mcp.ophis.fi/mcp), keyless and unauthenticated, with twelve tools that cover every supported chain, Unichain included. `list_chains` resolves Unichain's orderbook host and settlement domain (the sovereign-deployment detail above, handled for you). `get_quote` and `build_order` prepare a bounded order with the receiver pinned to the owner. `submit_order` relays the signature. The server never holds keys and never signs; the agent signs locally with its own key.

For the full safety model (bounded orders, pinned receivers, and what to lock down before an agent signs unattended), read [how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/) and the [AI agent docs](https://docs.ophis.fi/ai-agents).

## FAQ

### Do I need ETH on Unichain to pay for gas?

No. Orders are gasless (no native token needed): you sign a typed-data message, settlement happens in the solver's batch, and the fee is taken in the sell token. A wallet holding only the token you want to sell can trade, aside from a one-time on-chain approval the first time it sells a given token.

### What tokens can I trade on Unichain?

Solvers compete to fill the order you sign, so what matters in practice is the liquidity available for the pair on Unichain at your limit price. The limit is the worst execution you can receive, and 100% of any price improvement beyond it goes to you.

### Is there a fee?

Yes. A flat 0.10% of trade volume, reduced to 0.01% for same-chain stablecoin-to-stablecoin pairs, charged in the sell token. It takes no share of surplus, and volume rebate tiers (10% to 50% by rolling 30-day volume) weight your share of a monthly WETH rebate pool.

### Can AI agents swap on Unichain?

Yes. The Ophis MCP server covers Unichain along with every other supported chain, resolves the sovereign orderbook and settlement domain via `list_chains`, and returns bounded orders that the agent signs with its own key. Ophis never holds keys.

## Start swapping

Open [swap.ophis.fi/#/130/swap](https://swap.ophis.fi/#/130/swap), connect a wallet, and sign your first Unichain order. Gasless, MEV-protected, and 0.10% flat.
