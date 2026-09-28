---
title: "Ophis vs CoW Swap: what a CoW Protocol fork changes"
description: "Ophis is a CoW Protocol fork with batch auctions, an agent stack, and solver-aligned sovereign pricing on Optimism, Unichain, and Robinhood Chain."
pubDate: 2026-07-11
updatedDate: 2026-09-28
author: Ophis
tags: [cow-protocol, comparison, defi, swaps, mev]
draft: false
cover: ./ophis-vs-cow-swap.cover.jpg
coverAlt: "Ophis emblem ringed by supported chain logos, a CoW Protocol fork"
---

Ophis is a fork of CoW Protocol's frontend. On most chains an Ophis order settles through CoW Protocol's canonical audited GPv2 contracts and solver competition; on Optimism, Unichain, Robinhood Chain and Arc, Ophis operates sovereign deployments with its own orderbook and a settlement derived from GPv2 at a non-canonical address. What the fork changes is the layer on top: natural-language intent input, an agent stack, chain-aware pricing, monthly WETH volume rebates, and an affiliate program.

That is the whole comparison in three sentences. The rest of this page unpacks it plainly, because Ophis (the intent-based DEX aggregator at [ophis.fi](https://ophis.fi/)) exists because of CoW Protocol, not despite it. A maintained side-by-side also lives in the [comparison docs](https://docs.ophis.fi/comparison).

## The same settlement engine

Ophis did not reimplement settlement. A CoW Protocol fork inherits the three properties that matter, by construction rather than by imitation:

**Batch auctions.** You do not broadcast a swap transaction. You sign an EIP-712 order with a hard limit price, competing solvers race to fill it, and fills settle in batches at a uniform clearing price.

**The [MEV mitigation](/blog/mev-protection-batch-auctions/) model.** Offchain orders and uniform clearing prices per token pair reduce common ordering advantages. Settlement using external pools can still be public; no universal sandwich immunity is promised.

**Wallet authorization.** Standard signed ERC-20 orders keep funds in the wallet until settlement, with gas paid by the solver. Approvals and other transactions cost gas; native-token and bridge deposits have separate recovery rules.

If you have used CoW Swap, all three behave exactly the way you expect. It is the same mechanism.

## Where orders settle

The Ophis app supports fourteen chains: Ethereum, Optimism, BNB, Gnosis, Unichain, Robinhood Chain, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, Linea, and Arc. They split into two groups:

| Chains | Orderbook | Settlement |
| --- | --- | --- |
| Ethereum, BNB, Gnosis, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, Linea | CoW Protocol's, via api.cow.fi | CoW Protocol's canonical audited GPv2 contracts |
| Optimism, Unichain, Robinhood Chain, Arc | Ophis-operated | A settlement deployment derived from GPv2 at a non-canonical address |

On the ten hosted chains, an Ophis order is an order in CoW's orderbook, settled by the same contracts CoW Swap uses there. On Optimism, Unichain, [Robinhood Chain](/blog/swap-on-robinhood-chain/) and Arc, Ophis runs the stack itself: its own orderbook and its own settlement deployment. On Optimism that contract is 0x310784c7FCE12d578dA6f53460777bAc9718B859.

The practical consequence for anyone integrating: never hardcode api.cow.fi or the canonical settlement domain. Resolve supported orderbooks and signing domains with `@ophis/sdk` or MCP `list_chains`. SDK v0.4.3 and the hosted MCP server include Arc (5042). Signing against the wrong domain is the classic fork failure mode, and the tooling exists so you never have to guess.

## What Ophis adds

**Optional natural-language parsing.** The [Intent API](https://docs.ophis.fi/intent-api) turns text into structured fields (30 requests per minute per IP). It does not quote, sign or execute the trade; those are separate SDK/MCP or app steps.

**An agent stack.** A remote, keyless MCP server at [mcp.ophis.fi/mcp](https://mcp.ophis.fi/mcp) exposes fourteen tools, from `parse_intent` and `get_quote` to `validate_order`, `submit_order`, and `lookup_tier`. The server never holds keys and never signs; `build_order` pins the receiver to the owner and caps slippage, and the agent signs locally with its own key. Around the server: the `@ophis/sdk` npm package, GOAT and AgentKit plugins, and a [Safe app](https://safe.ophis.fi/) for smart-account trading. The full walkthrough is [how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/).

**Published, chain-aware pricing.** Outside the current Arc release exception, the standard schedule charges a 1 bp base and retains 80% of reference-quote improvement on volatile pairs (99 bps cap), or 50% on stable pairs (20 bps cap). On the ten chains that settle through CoW Protocol's canonical contracts, CoW Protocol's fees apply separately upstream. The current schedule and worked examples are in the [fee docs](https://docs.ophis.fi/fees).

**Volume rebates.** Arc is not indexed for volume-tier or referral rebates. On indexed chains, a rolling 30-day volume tier earns a share of a monthly WETH rebate pool paid from the fee Safe. The pool is 21.25% of WETH fees, split across qualifying wallets by tier-weighted 30-day volume:

| Tier | 30-day volume | Pool-allocation weight |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

Your current tier and progress toward the next one show directly on the swap page.

**An affiliate program.** Mint a referral code and earn 8% of the verified base fee Ophis keeps on eligible trades your referred wallets route on indexed chains, paid monthly in WETH from the same Safe. The regular tier caps at $1M of referred volume per month; an invitation-only Partner tier (12%, uncapped) exists. Details in the [affiliate docs](https://docs.ophis.fi/affiliate).

## When CoW Swap is the right pick

A comparison written by the fork owes you the cases where the original wins:

- **You want canonical contracts only.** CoW Swap uses CoW Protocol's canonical audited contracts; Ophis matches that only on its ten hosted chains.
- **You want the longer track record.** CoW Protocol built and has operated this settlement design in production; a fork is younger by definition.
- **You want the smallest trust surface.** Ophis adds a frontend, an agent stack, and, on four chains, an operator role. The added code is open source, but it is added surface. If minimizing surface is the priority, use the original.

For CoW Swap's current fee model, check [docs.cow.fi](https://docs.cow.fi); this page makes no claims about it.

## FAQ

### Is Ophis audited?

Upstream CoW audits cover relevant shared code, not every Ophis modification or deployment. Ophis-specific code has internal/tool-assisted reviews; this is not an organizational audit by the tool authors. See [Security & audits](https://docs.ophis.fi/audits) for report scopes and source links.

### Can I keep my CoW workflow on Ophis?

Mostly, yes. You still build and sign a CoW Protocol order: same order struct, same EIP-712 signing flow. On the ten hosted chains your existing tooling already targets the right orderbook, because it is CoW's. On Optimism, Unichain, Robinhood Chain and Arc you must use the Ophis orderbook and non-canonical settlement domain. SDK v0.4.3 and the hosted MCP server resolve all four.

### Why fork CoW Protocol at all?

Three reasons. First, an agent-first product: a keyless MCP server, an Intent API, receiver pinning, and slippage caps need a different surface than a human-first swap UI. Second, sovereign chains: on Optimism, Unichain, Robinhood Chain and Arc, Ophis operates the orderbook and settlement deployment directly. Third, the economics: standard-policy revenue combines a low fixed base with capped price-improvement capture (Arc currently differs), while tiered monthly WETH rebates and affiliate shares are paid from the fee Safe.

### What does a trade on Ophis cost?

Every supported chain pays the 1 bp Ophis base. Under the standard schedule, excluding Arc's current release exception, capped improvement capture can bring the maximum to 100 bps on volatile pairs or 21 bps on stable pairs. CoW-hosted chains pay CoW Protocol's fees separately upstream. On indexed chains, volume tiers weight a wallet's share of a monthly WETH rebate pool; Arc earns no rebates. See the [canonical fee documentation](https://docs.ophis.fi/fees) for the current schedule.

## Try it

The fastest comparison is one trade. Open [swap.ophis.fi](https://swap.ophis.fi/), choose the pair and amount, and review the limit price you are signing before you sign it. Building an agent instead? Start with the [AI agent docs](https://docs.ophis.fi/ai-agents).
