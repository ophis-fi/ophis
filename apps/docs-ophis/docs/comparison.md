---
id: comparison
title: How Ophis compares
description: Compare Ophis settlement, network coverage, fees and agent access using current product boundaries and primary sources.
sidebar_label: How Ophis compares
---

# How Ophis compares

Reviewed **September 27, 2026**. Compare the net output of current quotes for
the same assets, size and destination. A headline interface fee alone does not
measure execution cost, liquidity or safety.

## What "intent-based" means

An intent specifies an outcome rather than a fixed route. In an Ophis
batch-auction swap you authorize a sell amount, receiver, minimum buy amount
and expiry. A solver may settle only within those limits. Uniform clearing
prices apply per token pair, not across unrelated assets.

Offchain orders and batch auctions mitigate common MEV. The solver's external
liquidity transaction can still be public; this is not universal sandwich
immunity. See [Security & audits](./audits.md).

## Ophis is built on CoW Protocol

Ophis uses CoW settlement primitives. It operates its own stacks on Optimism,
Unichain, Robinhood Chain and Arc, and uses CoW-hosted orderbooks on ten other
chains. Shared foundations do not imply identical solver competition,
execution quality, infrastructure or audit coverage.

Standard signed ERC-20 orders keep funds in the wallet until settlement.
Native-token deposits and bridge routes have separate custody and recovery
rules. Ophis-specific changes are described in the security documentation.

## Core differences

### Natural-language input vs token-picker

The swap app provides token selection and quotes. The optional public
[Intent API](./intent-api.md) translates natural language into structured
fields; it does not quote, authorize or settle a trade. Agents can use the
MCP server or SDK for the subsequent workflow, retaining wallet authorization.

### Cross-chain scope

The app supports **14 EVM chains**, including Arc. SDK v0.4.3 and hosted MCP chain
mappings cover the same 14 networks, including Arc. NEAR Intents adds Bitcoin,
Solana, Monad, X Layer, Sui, Tron and Hyperliquid destinations on supported
routes. Circle and Across routes have different source, asset and wallet
restrictions; no provider covers every possible chain pair.

See [Networks & assets](./networks-assets.md) for exact boundaries. A destination
wallet may be needed, and source settlement is not proof of final delivery.

### Fee transparency

The standard schedule charges a **1 bp base**, plus **80% of reference-quote
improvement on volatile pairs capped at 99 bps**, or **50% on stable pairs
capped at 20 bps**. CoW-hosted chains additionally apply upstream protocol fees.
Bridge fees and gas are separate; use [Fees & rebates](./fees.md), not this
summary, for cost assumptions. Arc follows the same backend improvement policy
as Optimism, Unichain and Robinhood Chain.

Competitor pricing can vary with route, pair and order type. Check current
[CoW fees](https://docs.cow.fi/governance/fees),
[Matcha help](https://help.matcha.xyz/) and
[Velora documentation](https://docs.velora.xyz/docs) alongside a live quote.
Velora documents intent, OTC, TWAP and cross-chain products; describing it as
only a traditional same-chain aggregator is no longer accurate.

### Where the surplus goes

Reference-quote improvement and surplus over the signed limit are not the
same measure. On Optimism, Unichain and Robinhood Chain the backend applies Ophis's capped
improvement policy. On hosted chains Ophis encodes its policy in appData;
CoW applies protocol policies **before** partner policies, calculating fees
iteratively. Do not add capture percentages against the original improvement.
See [CoW's calculation order](https://docs.cow.fi/governance/fees).

### Agent-first API

Ophis offers a keyless natural-language parser, a hosted MCP endpoint, SDKs
and wallet-policy tooling. Parsing is not execution permission. Read tools,
order building, signing and submission remain separate stages. See
[AI agent integration](./ai-agents.md) for supported tools and chain mappings.

## Where each excels

Choose by the actual route and workflow: supported contracts and networks,
net output after fees, expiry/cancellation, bridge recovery and wallet control.
Do not infer the best price or deepest liquidity from a site's chain count.

## Trade-offs, stated plainly

Ophis-operated lanes depend on their configured venue liquidity and runtime
availability. A displayed DEX identifies a liquidity venue, not necessarily
an independent solver operator. CoW-hosted routes depend on upstream service
and fee policies. Both can fail to find an acceptable fill.

## Reference table

| Ophis surface | Current scope |
| --- | --- |
| Swap app | 14 EVM chains; route-specific cross-chain providers |
| SDK v0.4.3 / hosted MCP | 14 EVM chains, including Arc |
| Intent API | Parses fields; does not execute swaps |
| Batch-auction fees | Standard base plus capped improvement; upstream fees on hosted chains |
| MEV protection | Mechanism-level mitigation, not a universal guarantee |
| Rebates | Eligible collected WETH, tier-weighted; not a guaranteed return |

## Read next

- [Fees & rebates](./fees.md): fee scope, stablecoin treatment and rebates.
- [How it works](./architecture.md): order lifecycle and per-chain settlement.
- [Status](./status.md): service checks.
- [FAQ](./faq.mdx): custody, cancellation and supported networks.
