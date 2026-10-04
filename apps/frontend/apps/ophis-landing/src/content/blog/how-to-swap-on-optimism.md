---
title: "Swap on Optimism: MEV-protected DEX aggregator + rebates"
description: "How to swap on Optimism with Ophis: intent orders, MEV-protected batch settlement, and solver-aligned pricing."
pubDate: 2026-07-13
updatedDate: 2026-10-04
author: Ophis
tags: [optimism, dex-aggregator, mev, rebates, swaps]
draft: false
cover: ./how-to-swap-on-optimism.cover.jpg
coverAlt: "Ophis emblem with Optimism and supported chain logos"
---

To swap on Optimism, open the Ophis swap page with chain id 10 pre-selected, pick your pair, and sign the order your wallet shows. That order is an EIP-712 intent with a hard limit price, not a transaction: a competing solver network fills it and settles it in an MEV-protected batch. Pricing is a 1 bp base plus capped reference-quote improvement capture; see the [current schedule](/pricing/).

Ophis, the intent-based DEX aggregator at ophis.fi, is a fork of CoW Protocol's frontend with a natural-language intent layer and an agent stack (MCP server, SDK, plugins) on top. It runs on 14 EVM chains, and Optimism is one of four where the deployment is sovereign, alongside [Unichain](/blog/how-to-swap-on-unichain/) [Robinhood Chain](/blog/swap-on-robinhood-chain/) and Arc: Ophis operates its own orderbook and settlement contracts there. This post covers the flow, what batch settlement changes versus a router, what it costs, and how integrators earn on referred flow.

## Swap on Optimism in four steps

1. **Open the app.** [swap.ophis.fi/#/10/swap](https://swap.ophis.fi/#/10/swap) loads with Optimism (chain id 10) pre-selected. Connect a wallet. Standard signed ERC-20 orders keep funds in your wallet until settlement. Native-token placement and bridges have separate deposit rules.
2. **Sign an intent, not a transaction.** Enter the pair and amount, review the quote, and sign the order. The signature carries a hard limit price, the worst execution you can receive. Standard ERC-20 settlement is solver-paid; approvals and other wallet transactions can still require gas.
3. **Let solvers compete.** Your order goes to the Ophis orderbook off chain, where solvers race to fill it. The batch settles at a uniform clearing price, and improvement is shared under the published capped pricing policy.
4. **Watch the rebate meter.** The swap page shows your rolling 30-day volume tier and your progress toward the next one. From $20,000 of 30-day volume you enter the tier ladder, and a higher tier means a larger share of the rebate pool.

Step for step, this is the same flow as on any other Ophis chain. What is different on Optimism sits underneath.

## A sovereign deployment: own orderbook, own settlement

On most of its chains, Ophis settles through CoW Protocol's canonical audited GPv2 contracts via api.cow.fi. On Optimism, Unichain, Robinhood Chain and Arc, Ophis operates its own orderbook and settlement deployment derived from CoW Protocol. The Optimism settlement address is:

```
0x310784c7FCE12d578dA6f53460777bAc9718B859
```

For a trader in the app this changes nothing visible. For anyone building against the API it changes two things: Optimism orders sign against a different EIP-712 domain than canonical CoW deployments, and they submit to a different orderbook host. Do not hardcode either one. Resolve the per-chain settlement domain via `@ophis/sdk` or the MCP `list_chains` tool and both are always correct.

The settlement mechanics themselves are CoW Protocol's, and Ophis says so plainly: batch auctions, solver competition, and the GPv2 contract suite are documented at [docs.cow.fi](https://docs.cow.fi). Ophis adds the intent layer, the agent stack, and the fee-and-rebate economics below.

## What batch settlement changes versus a router aggregator

A router-style aggregator quotes you a route, then has you broadcast a transaction that executes that route on chain. Your price protection is a slippage tolerance: a percentage worse than the quote that you accept in advance. The pending transaction is public before it lands, and if it reverts, you still pay gas.

An intent flips each of those properties.

- **A hard limit price, signed.** The EIP-712 order states the minimum you will receive. Your slippage setting determines that bound, just as router minimum-output bounds constrain execution. Neither guarantees a fill at the original quote.
- **[MEV protection](/blog/mev-protection-batch-auctions/) by construction.** Order flow stays off chain until settlement, orders settle in batch auctions, and each token pair clears at a uniform price. This mitigates common MEV; external-pool settlement can still be public and exposed to adversarial conditions.
- **Capped, published improvement sharing.** Ophis retains 80% of reference-quote improvement on volatile pairs, capped at 99 bps of volume, or 50% on stable pairs, capped at 20 bps. The trader receives the remainder and everything above the cap.

The [comparison page](https://docs.ophis.fi/comparison) goes deeper on the trade-offs, and [Ophis vs CoW Swap](/blog/ophis-vs-cow-swap/) covers what the fork changes.

## Fees and the rebate ladder

Every trade pays a 1 bp base. Ophis retains 80% of reference-quote improvement on volatile pairs, capped at 99 bps of volume, or 50% on stable pairs, capped at 20 bps.

Volume then earns part of that back. Tiers follow your rolling 30-day volume:

| Tier | 30-day volume | Rebate |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

View rewards and payout status in your dashboard. The pool is 21.25% of collected WETH fees, split across qualifying wallets by tier-weighted 30-day volume. Your tier and progress are shown directly on the swap page, and the full mechanics live in the [fee docs](https://docs.ophis.fi/fees).

## Agents, bots, and integrators: earning on OP flow

Optimism flow does not have to come from a human clicking a UI. Three integration surfaces exist, and integrators earn on routed flow through the affiliate program: mint a referral code, and trades from your referred wallets are attributed to you.

- **MCP server.** A hosted, keyless endpoint at `https://mcp.ophis.fi/mcp` exposes fourteen tools, from `parse_intent` and `get_quote` through `build_order`, `validate_order`, and `submit_order`. `list_chains` resolves the Optimism orderbook and settlement domain, `build_order` pins the receiver to the owner, and the server never holds keys or signs anything. The [agent walkthrough](/blog/let-an-ai-agent-swap-tokens/) covers the full safety model.
- **SDK.** `@ophis/sdk` resolves the orderbook URL and the EIP-712 signing domain per chain. That is exactly the part integrations get wrong when they hardcode canonical endpoints on a sovereign chain. Details in the [AI agent docs](https://docs.ophis.fi/ai-agents).
- **Affiliate rebate.** Anyone can mint a referral code and earn 8% of the verified base fee Ophis keeps on every trade their referred wallets route, with rewards and payout status in your dashboard. The regular tier is capped at $1M of referred volume per month; an invitation-only Partner tier pays 12%, uncapped. Mechanics in the [affiliate docs](https://docs.ophis.fi/affiliate).

For apps that want the interface without the plumbing, `@ophis/widget-react` embeds the swap form directly; see the [widget docs](https://docs.ophis.fi/widget).

## FAQ

### How is Ophis different from a router aggregator on Optimism?

A router aggregator executes your swap as an on-chain transaction through a router contract, protected only by a slippage tolerance. Ophis never broadcasts your order as a public-mempool router swap: you sign an order with a hard limit price, solvers fill it, and the batch settles at a uniform clearing price. The signed limit remains enforceable, while any reference-quote improvement is shared under Ophis's published capped policy.

### Do failed swaps cost gas?

No. An Ophis order is a signed message, not a broadcast transaction, so there is no failed transaction to pay for. If no solver can fill your order at your limit price before it expires, it expires and nothing lands on chain. Fills are gasless for you as well, and the fee comes out of the traded amount; approvals, native-token placement, wrapping, hard cancellation and refunds can still require gas.

### How do rebates pay out?

Your tier follows your rolling 30-day volume, with weights from 10% at $20,000 up to 50% at $1,000,000 and above. These are pool-allocation weights, not a promised percentage refund of your own fees. View rewards and payout status in your dashboard. Rebate eligibility is calculated from a pool equal to 21.25% of collected WETH fees, split by tier-weighted 30-day volume. The swap page shows your current tier and progress at all times.

### Can I integrate Ophis into my app?

Yes, at whichever depth fits. `@ophis/widget-react` is a drop-in swap UI, `@ophis/sdk` handles per-chain orderbook and signing-domain resolution for programmatic orders, and agents can point at the hosted MCP server with no keys involved. To earn on that flow, mint a referral code at [swap.ophis.fi/#/affiliate](https://swap.ophis.fi/#/affiliate): trades from your referred wallets earn you 8% of the verified base fee Ophis keeps, with rewards and payout status in your dashboard.

One signature, a solver auction, batch settlement, and a fee ladder that pays volume back. If you are starting from zero, the [getting-started guide](https://docs.ophis.fi/getting-started) walks through a first swap end to end. When you are ready, open [swap.ophis.fi/#/10/swap](https://swap.ophis.fi/#/10/swap) with Optimism pre-selected and place your first order.
