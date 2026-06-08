---
id: comparison
title: How Ophis compares
description: Where the Ophis interface differs from other swap front-ends and aggregators (CoW Swap, Matcha, Velora), focused on natural-language input, cross-chain destinations, agent access, and the fee model.
sidebar_label: How Ophis compares
---

# How Ophis compares

Ophis is built on **CoW Protocol's** batch-auction settlement, so it inherits the
same foundations as CoW Swap: MEV protection by construction, solver competition,
a non-custodial design, and an open-source codebase. Those strengths are shared,
not unique to Ophis.

This page focuses on where the **Ophis interface** differs from other swap
front-ends and aggregators.

| | **Ophis** | **CoW Swap** | **Matcha** (0x) | **Velora** (ex-ParaSwap) |
| --- | --- | --- | --- | --- |
| **How you trade** | Natural language, e.g. "swap 100 USDC for ETH on Base" | Token picker (signed intents) | Token picker | Token picker |
| **Cross-chain destinations** | Solana and Bitcoin, live (via NEAR Intents) | Solana live (via NEAR Intents); no Bitcoin | EVM and Solana | EVM only |
| **Agent access** | Public natural-language `/api/intent` (no key) plus a hosted MCP server | Orderbook REST API and SDK | 0x Swap API | REST API and SDK |
| **Fee model** | 0% on ordinary trades; 25% of price improvement, capped at 0.5% of volume; never your principal | ~50% of surplus / quote improvement, capped near 1% of volume, plus a small volume fee on some orders | ~0.25% on most pairs, 0.05% on stablecoin pairs (Matcha Auto); 0.10% flat on select chains (Scroll, Mantle, Monad, Linea) | 0.15% (15 bps) interface fee on most swaps; 0.01% (1 bps) on stablecoin pairs |

The shared CoW Protocol foundation means execution quality, MEV protection, and
custody are on par with CoW Swap. What Ophis adds on top is the natural-language
front door, an agent-first API surface, Solana and Bitcoin as cross-chain
destinations (Bitcoin remains unique among these front-ends), and a fee that takes
25% of price improvement, capped at 0.5% of volume.

:::note

Competitor fee and chain details reflect each project's public documentation as of
June 2026 and may change. Sources:
[CoW Protocol fees](https://docs.cow.fi/governance/fees),
[Matcha fees](https://help.matcha.xyz/en/articles/3953360-are-there-any-fees-to-make-a-trade),
[Velora UI fees](https://help.velora.xyz/en/articles/6554779-paraswap-ui-fees).

:::
