---
id: partner-materials-verification
title: Partner materials verification
description: Factual-status review of the July 2026 partner programme and price-simulation materials.
sidebar_label: Partner materials verification
sidebar_position: 9
---

# Partner materials verification

This page records the fact-check of **Ophis-Partner-Price-Simulation.pdf** and
**Ophis-Partner-Program-2026-07-v2.pdf** (both dated 30 July 2026). It separates
reproducible repository facts from point-in-time claims made by the decks.

## Confirmed against the current repository

- Ophis supports 13 EVM chains: Ethereum, Arbitrum One, Avalanche, Base, BNB
  Smart Chain, Gnosis, Ink, Linea, Optimism, Plasma, Polygon, Robinhood Chain,
  and Unichain.
- Ophis operates its own orderbook/settlement stack on Optimism (10), Unichain
  (130), and Robinhood Chain (4663). The other ten chains use CoW-hosted
  infrastructure.
- The current Ophis base fee is **1 bp (0.01%)** on every supported chain.
  Price-improvement capture is a separate policy: 80% up to 99 bps for
  volatile pairs, or 50% up to 20 bps for stablecoin pairs.
- The affiliate programme currently documents an 8% self-serve share capped at
  $1 million of referred monthly volume and a 12% partner share with uncapped
  referred volume, paid monthly in WETH.
- The trader rebate pool is documented as 21.25% of WETH fees held by the Ophis
  fee Safe, distributed by tier-weighted rolling 30-day volume.
- The SDK currently reports version 0.4.2; the agent-swap package is 0.3.2.
  Ophis also documents hosted MCP and agent integrations, including GOAT,
  Coinbase AgentKit, elizaOS, Bankr, and HeyAnon.
- Native Bitcoin and Solana destinations are documented as cross-chain routes
  through NEAR Intents; they are not additional EVM chains.

## Corrections required in the July programme deck

The deck's **10 bps retail fee** and **5 bps SDK fee** are stale and must not be
used for current partner pricing. Replace them with the current **1 bp Ophis
base fee**, then describe price-improvement capture separately. On CoW-hosted
chains, CoW's upstream protocol fee is an additional, separate charge; it is
not an Ophis base fee and should not be blended into the Ophis rate.

The deck's chain, attribution, non-custodial signing, settlement-regime, and
Robinhood reporting-limit descriptions should be read alongside the live
[partner guide](./partners.md), [fees](./fees.md), and
[affiliate terms](./affiliate.md), which are the authoritative sources.

## Status of the price simulation

The simulation reports 792 production quote attempts, a 13-minute observation
window, 66 comparable cells, and 198 Ophis quotes. Those are **snapshot claims
from the supplied PDF**, not a continuously verified benchmark. The repository
does not contain the raw responses, source code, or signed/settled trade records
referenced by the deck, so the reported win rate, basis-point medians, latency,
and availability figures cannot be independently reproduced from the current
checkout.

The deck correctly limits its conclusion to an observed result rather than a
universal best-price claim. It also correctly states that no trade was signed
or settled and that gas definitions were not equivalent. Any public use should
retain those limitations, the exact collection timestamp, fee configuration,
asset/order matrix, and a link to an immutable raw-evidence archive.

## Current development status

As of the current repository snapshot, the latest partner-facing developments
include the self-hosted Robinhood Chain orderbook lane, published chain-aware
SDK builders and policy packs, hosted MCP/agent adapters, and the documented
WETH affiliate and trader-rebate programmes. Live availability and deployment
health should be checked on the [status page](./status.md); pricing and fee
terms should always be taken from the live [fees](./fees.md) page rather than
from the July snapshot decks.
