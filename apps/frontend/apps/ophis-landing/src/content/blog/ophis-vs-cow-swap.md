---
title: "Ophis vs CoW Swap: what a CoW Protocol fork changes"
description: "Ophis is a CoW Protocol fork: same batch auctions and MEV protection, plus an agent stack, a 0.10% base fee, and sovereign deployments on Optimism and Unichain."
pubDate: 2026-07-11
author: Ophis
tags: [cow-protocol, comparison, defi, swaps, mev]
draft: false
cover: ./ophis-vs-cow-swap.cover.jpg
coverAlt: "Ophis emblem ringed by supported chain logos, a CoW Protocol fork"
---

Ophis is a fork of CoW Protocol's frontend. On most chains an Ophis order settles through CoW Protocol's canonical audited GPv2 contracts and the same solver competition that fills CoW Swap (often written cowswap) orders; on Optimism and Unichain, Ophis operates sovereign deployments: its own orderbook and a bytecode-identical GPv2Settlement at a non-canonical address. What the fork changes is the layer on top: natural-language intent input, an agent stack, a flat 0.10% Ophis fee, monthly WETH volume rebates, and an affiliate program.

That is the whole comparison in three sentences. The rest of this page unpacks it plainly, because Ophis (the intent-based DEX aggregator at [ophis.fi](https://ophis.fi/)) exists because of CoW Protocol, not despite it. A maintained side-by-side also lives in the [comparison docs](https://docs.ophis.fi/comparison).

## The same settlement engine

Ophis did not reimplement settlement. A CoW Protocol fork inherits the three properties that matter, by construction rather than by imitation:

**Batch auctions.** You do not broadcast a swap transaction. You sign an EIP-712 order with a hard limit price, competing solvers race to fill it, and fills settle in batches at a uniform clearing price.

**The [MEV protection](/blog/mev-protection-batch-auctions/) model.** Order flow stays off-chain until settlement, and a uniform clearing price leaves no in-batch ordering to exploit, so there is nothing for a sandwich bot to reorder. The protection is structural, not best-effort.

**Non-custody.** Ophis never holds funds. Assets move only against a valid EIP-712 or ERC-1271 signature, and orders are [gasless](/blog/gasless-swaps-how-intents-work/): no native token needed, the fee is taken in the sell token.

If you have used CoW Swap, all three behave exactly the way you expect. It is the same mechanism.

## Where orders settle

Ophis supports twelve chains: Ethereum, Optimism, BNB, Gnosis, Unichain, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, and Linea. They split into two groups:

| Chains | Orderbook | Settlement |
| --- | --- | --- |
| Ethereum, BNB, Gnosis, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, Linea | CoW Protocol's, via api.cow.fi | CoW Protocol's canonical audited GPv2 contracts |
| Optimism, Unichain | Ophis-operated (sovereign) | A bytecode-identical deployment of CoW Protocol's audited GPv2Settlement at a non-canonical address |

On the ten hosted chains, an Ophis order is an order in CoW's orderbook, settled by the same contracts CoW Swap uses there. On Optimism and Unichain, Ophis runs the stack itself: its own orderbook and its own settlement deployment. On Optimism that contract is 0x310784c7FCE12d578dA6f53460777bAc9718B859.

The practical consequence for anyone integrating: never hardcode api.cow.fi or the canonical settlement domain. Resolve the per-chain orderbook and signing domain with `@ophis/sdk` or the MCP `list_chains` tool. Signing against the wrong domain is the classic fork failure mode, and the tooling exists so you never have to guess.

## What Ophis adds

**Natural-language intents.** Describe the trade ("swap 100 USDC for ETH on Optimism") and sign the resulting EIP-712 order with a hard limit price. The same parser is exposed as a free [Intent API](https://docs.ophis.fi/intent-api) (30 requests per minute per IP), so any function-calling agent can use it too.

**An agent stack.** A remote, keyless MCP server at [mcp.ophis.fi/mcp](https://mcp.ophis.fi/mcp) exposes twelve tools, from `parse_intent` and `get_quote` to `submit_order` and `lookup_tier`. The server never holds keys and never signs; `build_order` pins the receiver to the owner and caps slippage, and the agent signs locally with its own key. Around the server: the `@ophis/sdk` npm package, GOAT and AgentKit plugins, and a [Safe app](https://safe.ophis.fi/) for smart-account trading. The full walkthrough is [how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/).

**A flat, published fee.** The Ophis fee is 0.10% of trade volume on every trade, and 0.01% for same-chain stablecoin-to-stablecoin pairs. On Optimism and Unichain, where Ophis runs its own settlement, that is the entire cost and 100% of any price improvement beyond your signed quote is yours. On the ten chains that settle through CoW Protocol's canonical contracts, CoW Protocol's protocol fee applies on top, so the all-in cost is about 0.12% (about 0.013% on stable pairs) and half of any price improvement goes to the protocol; [docs.cow.fi](https://docs.cow.fi) has CoW Protocol's schedule. The Ophis schedule is in the [fee docs](https://docs.ophis.fi/fees).

**Volume rebates.** A rolling 30-day volume tier earns a share of a monthly WETH rebate pool paid from the fee Safe. The pool is 21.25% of WETH fees, split across qualifying wallets by tier-weighted 30-day volume:

| Tier | 30-day volume | Rebate |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

Your current tier and progress toward the next one show directly on the swap page.

**An affiliate program.** Mint a referral code and earn 8% of the net fee Ophis keeps on every trade your referred wallets route, paid monthly in WETH from the same Safe. The regular tier caps at $1M of referred volume per month; an invitation-only Partner tier (12%, uncapped) exists. Details in the [affiliate docs](https://docs.ophis.fi/affiliate).

## When CoW Swap is the right pick

A comparison written by the fork owes you the cases where the original wins:

- **You want canonical contracts only.** CoW Swap uses CoW Protocol's canonical audited contracts; Ophis matches that only on its ten hosted chains.
- **You want the longer track record.** CoW Protocol built and has operated this settlement design in production; a fork is younger by definition.
- **You want the smallest trust surface.** Ophis adds a frontend, an agent stack, and, on two chains, an operator role. The added code is open source, but it is added surface. If minimizing surface is the priority, use the original.

For CoW Swap's current fee model, check [docs.cow.fi](https://docs.cow.fi); this page makes no claims about it.

## FAQ

### Is Ophis audited?

Ophis does not claim an audit of its own. On the ten hosted chains, orders settle through CoW Protocol's audited GPv2 contracts, unchanged. On Optimism and Unichain they settle through bytecode-identical deployments of those same audited contracts, so what runs is the audited bytecode at a different address, and anyone can verify that byte for byte. Everything Ophis adds on top is open source at [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis).

### Can I keep my CoW workflow on Ophis?

Mostly, yes. You still build and sign a CoW Protocol order: same order struct, same EIP-712 signing flow. On the ten hosted chains your existing tooling already targets the right orderbook, because it is CoW's. On Optimism and Unichain you must point at the Ophis orderbook and sign against the non-canonical settlement domain; `@ophis/sdk` and the MCP `list_chains` tool resolve both from a chain ID.

### Why fork CoW Protocol at all?

Three reasons. First, an agent-first product: a keyless MCP server, an Intent API, receiver pinning, and slippage caps need a different surface than a human-first swap UI. Second, sovereign chains: on Optimism and Unichain, Ophis operates the orderbook and the settlement deployment directly. Third, the economics: the flat 0.10% fee is taken in the sell token, and the tiered monthly WETH rebates and the 8% affiliate share are paid from the fee Safe, which requires controlling the fee path end to end.

### What does a trade on Ophis cost?

The Ophis fee is a flat 0.10% of volume, or 0.01% for same-chain stablecoin pairs, taken in the sell token; orders are gasless, so you need no native token. On Optimism and Unichain that is the whole cost and you keep 100% of any price improvement. On the ten chains that settle through CoW Protocol's contracts, CoW Protocol's protocol fee applies on top (all-in about 0.12%, or about 0.013% on stable pairs) and half of any price improvement goes to the protocol; see [docs.cow.fi](https://docs.cow.fi). Volume tiers (10% to 50% by 30-day volume) weight your share of a monthly WETH rebate pool, with tier progress shown on the swap page.

### Is Ophis a cowswap alternative?

Yes. Ophis (sometimes searched as a cowswap alternative) is a CoW Protocol fork, so it gives you the same batch-auction, MEV-protected settlement CoW Swap uses, on the same solver network on the ten hosted chains. What differs is the layer on top: natural-language intents, an agent stack (a keyless MCP server and a free Intent API), a flat 0.10% fee, monthly WETH volume rebates, and sovereign deployments on Optimism and Unichain. If you want CoW Swap's mechanism with an agent-first surface, Ophis is the closest fork.

## Try it

The fastest comparison is one trade. Open [swap.ophis.fi](https://swap.ophis.fi/), describe the swap in plain text, and review the limit price you are signing before you sign it. Building an agent instead? Start with the [AI agent docs](https://docs.ophis.fi/ai-agents).
