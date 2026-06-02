---
id: status
title: Status
sidebar_label: Status
description: Live Ophis services, health endpoints, and the per-chain settlement model.
---

# Status

A directory of the live Ophis surfaces and their health endpoints. There is no
synthetic uptime dashboard — each row links to the relevant live surface, or to
a self-reporting health endpoint where one exists, so you can check current
state directly.

## Services

| Surface | URL | Health check |
| --- | --- | --- |
| Swap app | [swap.ophis.fi](https://swap.ophis.fi) | Loads the intent UI. |
| Landing | [ophis.fi](https://ophis.fi) | — |
| Docs | [docs.ophis.fi](https://docs.ophis.fi) | This site. |
| Explorer | [explorer.ophis.fi](https://explorer.ophis.fi) | Order/trade search. |
| Intent API | `POST https://ophis.fi/api/intent` | See [Intent API](/intent-api). |
| MCP server | `https://mcp.ophis.fi/mcp` | Streamable-HTTP; a request without an `Accept: text/event-stream` header returns HTTP 406 — that is expected, not an outage. See [AI agents](/ai-agents). |
| Rebate indexer | [rebates.ophis.fi/health](https://rebates.ophis.fi/health) | JSON. `last_pipeline_run_at` is the nightly-pipeline liveness signal (it advances at 02:00 UTC daily); `last_fetch` is insert-only and only moves on a new tagged trade, so a stale `last_fetch` during a quiet period is normal. |
| Optimism orderbook | [optimism-mainnet.ophis.fi](https://optimism-mainnet.ophis.fi) | Ophis-operated CoW orderbook for chain 10 (see below). |

## Settlement model per chain

Ophis settles across two kinds of chains:

- **CoW-hosted chains** — Ethereum, BNB Chain, Gnosis, Polygon, Base, Arbitrum,
  Avalanche, Linea, Ink, and Plasma. Orders settle through CoW Protocol's
  production orderbooks (`api.cow.fi`) using the canonical CoW contracts. Their
  status mirrors [CoW Protocol's status](https://status.cow.fi).
- **Ophis-operated chain** — Optimism (chain 10). Orders settle through Ophis's
  self-hosted orderbook at `optimism-mainnet.ophis.fi` using an Ophis-deployed
  (non-canonical) `GPv2Settlement` contract. Always resolve per-chain settlement
  and orderbook hosts via the `@ophis/sdk` helpers or the MCP `list_chains` tool
  rather than hardcoding addresses.

Solana and Bitcoin are supported as **destinations** via
[NEAR Intents](https://near.org/intents), not as source-chain orderbooks.

## Incidents

Operational incidents and maintenance are announced on
[x.com/ophis_fi](https://x.com/ophis_fi). The canonical source of truth for what
is deployed is the [`ophis-fi/ophis`](https://github.com/ophis-fi/ophis)
repository.
