---
title: "How to swap on Unichain: gasless and MEV-protected"
description: "Step-by-step guide to swapping on Unichain with Ophis: connect a wallet, sign an EIP-712 order, and settle it in a MEV-protected batch."
pubDate: 2026-07-14
updatedDate: 2026-09-28
author: Ophis
tags: [unichain, swaps, mev, defi, how-to]
draft: false
cover: ./how-to-swap-on-unichain.cover.jpg
coverAlt: "Ophis emblem with Unichain and supported chain logos"
---

To swap on Unichain, open [swap.ophis.fi/#/130/swap](https://swap.ophis.fi/#/130/swap), connect your wallet, choose the pair, and sign an EIP-712 order. For a standard signed ERC-20 order, you do not broadcast the settlement transaction or pay its gas: competing solvers fill the order and settle it on-chain in an MEV-protected batch. Pricing is a 1 bp base plus capped reference-quote improvement capture.

Context in two sentences. Unichain is chain id 130, one of the 14 EVM chains Ophis supports. [Ophis](https://ophis.fi/) is an intent-based DEX aggregator, a fork of [CoW Protocol](https://docs.cow.fi)'s frontend with a natural-language intent layer and an agent stack on top, and on Unichain it runs a deployment of its own, which matters in one specific way covered below.

## Swap on Unichain, step by step

1. **Open the app pinned to Unichain.** Go to `https://swap.ophis.fi/#/130/swap`. The `130` in the URL is Unichain's chain id, so the swap form loads already pointed at the right network.

2. **Connect your wallet.** Standard signed ERC-20 orders keep funds in your wallet until settlement. Native-token placement and bridge deposits follow separate rules.

3. **Choose the pair and amount.** Use the app's token selector. Developers can optionally parse natural language through the Intent API before building an order.

4. **Review the quote.** The quote carries a hard limit price, and that limit is what you sign: the worst execution you can receive. Ophis charges a 1 bp base and retains 80% of reference-quote improvement on volatile pairs (99 bps cap), or 50% on stable pairs (20 bps cap); the remainder and all improvement above the cap go to you.

5. **Sign the order.** Your wallet shows an EIP-712 typed-data message, not a transaction. Signing costs nothing: ERC-20 orders are gasless, while approvals and other direct wallet transactions still require native gas.

6. **Wait for settlement.** Competing solvers race to fill the order, and the result settles on-chain in a batch. The order status updates on the page until the trade lands.

## Gasless settlement and MEV mitigation

The mechanism behind gasless signing and settlement is the same one that [mitigates common MEV](/blog/mev-protection-batch-auctions/).

On a regular DEX you broadcast a swap into a public mempool, where searchers can sandwich it: buy in front of you, sell behind you, pocket the spread. On Ophis your order is an intent that stays off-chain until settlement. Solvers batch orders with a uniform clearing price per token pair. This reduces ordering advantages, but external-pool settlement can still be public; no universal sandwich immunity is promised.

[Gaslessness](/blog/gasless-swaps-how-intents-work/) falls out of the same design. You sign, solvers settle, and the fee comes out of the traded amount, so a wallet with no ETH on Unichain can still trade.

## Ophis runs a sovereign deployment on Unichain

On most supported chains, Ophis settles through CoW Protocol's canonical audited GPv2 contracts via api.cow.fi. Unichain is one of four Ophis-operated chains, alongside [Optimism](/blog/how-to-swap-on-optimism/), [Robinhood Chain](/blog/swap-on-robinhood-chain/) and Arc, where Ophis operates a sovereign deployment instead: its own orderbook and a settlement deployment derived from CoW Protocol's GPv2 design at a non-canonical address.

If you swap through the page, this changes nothing; the app targets the right contracts for chain 130. It matters if you integrate programmatically: an order built for the canonical CoW settlement domain will not verify against the Unichain deployment. Resolve the per-chain settlement domain via `@ophis/sdk` or the MCP `list_chains` tool instead of hardcoding anything.

## Fees and volume rebates

Every trade pays a 1 bp base. Ophis retains 80% of reference-quote improvement on volatile pairs (99 bps cap) or 50% on stable pairs (20 bps cap).

Trade enough and part of it comes back. Rebate tiers run on rolling 30-day volume: Bronze ($20,000+) 10%, Silver ($50,000+) 15%, Gold ($100,000+) 25%, Palladium ($500,000+) 35%, Platinum ($1,000,000+) 50%. Rebates are paid monthly in WETH from the fee Safe, out of a pool of 21.25% of collected WETH fees split by tier-weighted 30-day volume. Your tier and progress show on the swap page, and the [fee docs](https://docs.ophis.fi/fees) have the full breakdown.

## Swapping on Unichain from an AI agent

The same rails are exposed to agents. Ophis runs a remote MCP server at [`https://mcp.ophis.fi/mcp`](https://mcp.ophis.fi/mcp), keyless and unauthenticated, with fourteen tools covering 14 EVM chains, including Unichain and Arc. `list_chains` resolves Unichain's orderbook host and settlement domain (the sovereign-deployment detail above, handled for you). `get_quote` and `build_order` prepare a bounded order with the receiver pinned to the owner, `validate_order` checks it, and `submit_order` relays the signature. The server never holds keys and never signs; the agent signs locally with its own key.

For the full safety model (bounded orders, pinned receivers, and what to lock down before an agent signs unattended), read [how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/) and the [AI agent docs](https://docs.ophis.fi/ai-agents).

## FAQ

### Do I need ETH on Unichain to pay for gas?

The solver pays settlement gas for standard signed ERC-20 orders. Approvals, native-token placement, wrapping, hard cancellation and refunds can still require ETH. An exact allowance may need renewing after a fill.

### What tokens can I trade on Unichain?

Solvers compete to fill the order you sign, so what matters in practice is the liquidity available for the pair on Unichain at your limit price. The limit remains the worst execution you can receive; improvement against the reference quote is shared under the capped pricing policy.

### Is there a fee?

Yes. A 1 bp base plus 80% of reference-quote improvement on volatile pairs (99 bps cap), or 50% on stable pairs (20 bps cap). See the [pricing page](/pricing/) for worked examples.

### Can AI agents swap on Unichain?

Yes. The Ophis MCP server covers Unichain along with the other supported chains, including Arc, resolves the sovereign orderbook and settlement domain via `list_chains`, and returns bounded orders that the agent signs with its own key. Ophis never holds keys.

## Start swapping

Check the [live service status](https://docs.ophis.fi/status) first, then open [swap.ophis.fi/#/130/swap](https://swap.ophis.fi/#/130/swap), connect a wallet, and sign your Unichain order. ERC-20 settlement is gasless and the current fee is the published sovereign 1 bp base plus capped improvement capture.
