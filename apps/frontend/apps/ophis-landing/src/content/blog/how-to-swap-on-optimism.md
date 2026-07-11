---
title: "Swap on Optimism: MEV-protected DEX aggregator + rebates"
description: "How to swap on Optimism with Ophis: intent orders with a hard limit price, MEV-protected batch settlement, a flat 0.10% fee, and volume rebates up to 50%."
pubDate: 2026-07-13
author: Ophis
tags: [optimism, dex-aggregator, mev, rebates, swaps]
draft: false
cover: ./how-to-swap-on-optimism.cover.jpg
coverAlt: "Ophis emblem with Optimism and supported chain logos"
---

To swap on Optimism, open the Ophis swap page with chain id 10 pre-selected, pick your pair, and sign the order your wallet shows. That order is an EIP-712 intent with a hard limit price, not a transaction: a competing solver network fills it and settles it in an MEV-protected batch. The fee is a flat 0.10% of trade volume, and active traders earn a share of a monthly WETH rebate pool, weighted by 30-day volume tier.

Ophis, the intent-based DEX aggregator at ophis.fi, is a fork of CoW Protocol's frontend with a natural-language intent layer and an agent stack (MCP server, SDK, plugins) on top. It runs on twelve EVM chains, and Optimism is one of two where the deployment is sovereign: Ophis operates its own orderbook and its own settlement contract there. This post covers the flow, what batch settlement changes versus a router, what it costs, and how integrators earn on referred flow.

## Swap on Optimism in four steps

1. **Open the app.** [swap.ophis.fi/#/10/swap](https://swap.ophis.fi/#/10/swap) loads with Optimism (chain id 10) pre-selected. Connect a wallet. Ophis is self-custodial: it never holds your funds, and nothing moves without your EIP-712 or ERC-1271 signature.
2. **Sign an intent, not a transaction.** Enter the pair and amount, review the quote, and sign the order. The signature carries a hard limit price, the worst execution you can receive. Orders are gasless: no native token needed, the fee is taken in the sell token.
3. **Let solvers compete.** Your order goes to the Ophis orderbook off chain, where solvers race to fill it. The batch settles at a uniform clearing price, and 100% of any price improvement beyond your signed quote comes back to you as surplus. The fee takes no share of it.
4. **Watch the rebate meter.** The swap page shows your rolling 30-day volume tier and your progress toward the next one. From $20,000 of 30-day volume you enter the tier ladder, and a higher tier means a larger share of the monthly rebate pool.

Step for step, this is the same flow as on any other Ophis chain. What is different on Optimism sits underneath.

## A sovereign deployment: own orderbook, own settlement

On most of its chains, Ophis settles through CoW Protocol's canonical audited GPv2 contracts via api.cow.fi. On Optimism and Unichain, Ophis is sovereign: it runs its own orderbook and a bytecode-identical deployment of CoW Protocol's audited GPv2Settlement at a non-canonical address:

```
0x310784c7FCE12d578dA6f53460777bAc9718B859
```

For a trader in the app this changes nothing visible. For anyone building against the API it changes two things: Optimism orders sign against a different EIP-712 domain than canonical CoW deployments, and they submit to a different orderbook host. Do not hardcode either one. Resolve the per-chain settlement domain via `@ophis/sdk` or the MCP `list_chains` tool and both are always correct.

The settlement mechanics themselves are CoW Protocol's, and Ophis says so plainly: batch auctions, solver competition, and the GPv2 contract suite are documented at [docs.cow.fi](https://docs.cow.fi). Ophis adds the intent layer, the agent stack, and the fee-and-rebate economics below.

## What batch settlement changes versus a router aggregator

A router-style aggregator quotes you a route, then has you broadcast a transaction that executes that route on chain. Your price protection is a slippage tolerance: a percentage worse than the quote that you accept in advance. The pending transaction is public before it lands, and if it reverts, you still pay gas.

An intent flips each of those properties.

- **A hard limit price, signed.** The EIP-712 order states the minimum you will receive. There is no tolerance band to be filled to the bottom of; execution below your limit cannot settle at all.
- **[MEV protection](/blog/mev-protection-batch-auctions/) by construction.** Order flow stays off chain until settlement, orders settle in batch auctions, and every trade in a batch clears at a uniform clearing price. There is no pending swap in a public mempool to sandwich and no in-batch ordering to exploit. The protection is structural, not best-effort.
- **Surplus returned in full.** Solvers compete for every batch, and competition surfaces prices better than the signed quote. 100% of that improvement goes to the trader; the fee takes no share of surplus.

The [comparison page](https://docs.ophis.fi/comparison) goes deeper on the trade-offs, and [Ophis vs CoW Swap](/blog/ophis-vs-cow-swap/) covers what the fork changes.

## Fees and the rebate ladder

Pricing is one number: a flat 0.10% (10 bps) fee on trade volume, every trade. Same-chain stablecoin-to-stablecoin swaps pay 0.01% (1 bp).

Volume then earns part of that back. Tiers follow your rolling 30-day volume:

| Tier | 30-day volume | Rebate |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

Rebates are paid monthly in WETH from the fee Safe. The pool is 21.25% of collected WETH fees, split across qualifying wallets by tier-weighted 30-day volume. Your tier and progress are shown directly on the swap page, and the full mechanics live in the [fee docs](https://docs.ophis.fi/fees).

## Agents, bots, and integrators: earning on OP flow

Optimism flow does not have to come from a human clicking a UI. Three integration surfaces exist, and integrators earn on routed flow through the affiliate program: mint a referral code, and trades from your referred wallets are attributed to you.

- **MCP server.** A hosted, keyless endpoint at `https://mcp.ophis.fi/mcp` exposes twelve tools, from `parse_intent` and `get_quote` through `build_order` and `submit_order`. `list_chains` resolves the Optimism orderbook and settlement domain, `build_order` pins the receiver to the owner, and the server never holds keys or signs anything. The [agent walkthrough](/blog/let-an-ai-agent-swap-tokens/) covers the full safety model.
- **SDK.** `@ophis/sdk` (0.2.3 on npm) resolves the orderbook URL and the EIP-712 signing domain per chain. That is exactly the part integrations get wrong when they hardcode canonical endpoints on a sovereign chain. Details in the [AI agent docs](https://docs.ophis.fi/ai-agents).
- **Affiliate rebate.** Anyone can mint a referral code and earn 8% of the net fee Ophis keeps on every trade their referred wallets route, paid monthly in WETH. The regular tier is capped at $1M of referred volume per month; an invitation-only Partner tier pays 12%, uncapped. Mechanics in the [affiliate docs](https://docs.ophis.fi/affiliate).

For apps that want the interface without the plumbing, `@ophis/widget-react` embeds the swap form directly; see the [widget docs](https://docs.ophis.fi/widget).

## FAQ

### How is Ophis different from a router aggregator on Optimism?

A router aggregator executes your swap as an on-chain transaction through a router contract, protected only by a slippage tolerance. Ophis never broadcasts your trade: you sign an order with a hard limit price, competing solvers fill it, and the batch settles at a uniform clearing price. Sandwiching is blocked by construction rather than mitigated, and 100% of the price improvement beyond your signed quote is returned to you.

### Do failed swaps cost gas?

No. An Ophis order is a signed message, not a broadcast transaction, so there is no failed transaction to pay for. If no solver can fill your order at your limit price before it expires, it expires and nothing lands on chain. Fills are gasless for you as well, and the fee is taken in the sell token; the only native-token cost is a one-time approval the first time you sell a given token.

### How do rebates pay out?

Your tier follows your rolling 30-day volume, from 10% back at $20,000 up to 50% at $1,000,000 and above. Rebates are paid monthly in WETH from the fee Safe, out of a pool equal to 21.25% of collected WETH fees, split by tier-weighted 30-day volume. The swap page shows your current tier and progress at all times.

### Can I integrate Ophis into my app?

Yes, at whichever depth fits. `@ophis/widget-react` is a drop-in swap UI, `@ophis/sdk` handles per-chain orderbook and signing-domain resolution for programmatic orders, and agents can point at the hosted MCP server with no keys involved. To earn on that flow, mint a referral code at [swap.ophis.fi/#/affiliate](https://swap.ophis.fi/#/affiliate): trades from your referred wallets earn you 8% of the net fee Ophis keeps, paid monthly in WETH.

One signature, a solver auction, batch settlement, and a fee ladder that pays volume back. If you are starting from zero, the [getting-started guide](https://docs.ophis.fi/getting-started) walks through a first swap end to end. When you are ready, open [swap.ophis.fi/#/10/swap](https://swap.ophis.fi/#/10/swap) with Optimism pre-selected and place your first order.
