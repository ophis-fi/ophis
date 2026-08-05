---
id: status
title: Status
sidebar_label: Status
description: Live Ophis services, health endpoints, and the per-chain settlement model.
---

# Status

A directory of the live Ophis surfaces and their health endpoints. There is no
synthetic uptime dashboard: each row links to the relevant live surface, or to
a self-reporting health endpoint where one exists, so you can check current
state directly.

## Services

| Surface             | URL                                                              | Health check                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swap app            | [swap.ophis.fi](https://swap.ophis.fi)                           | Loads the intent UI.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Landing             | [ophis.fi](https://ophis.fi)                                     | Loads.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Docs                | [docs.ophis.fi](https://docs.ophis.fi)                           | This site.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Explorer            | [explorer.ophis.fi](https://explorer.ophis.fi)                   | Order/trade search.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Intent API          | `POST https://ophis.fi/api/intent`                               | See [Intent API](/intent-api).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| MCP server          | `https://mcp.ophis.fi/mcp`                                       | Streamable-HTTP; a request without an `Accept: text/event-stream` header returns HTTP 406: that is expected, not an outage. See [AI agents](/ai-agents).                                                                                                                                                                                                                                                                                              |
| Rebate indexer      | [rebates.ophis.fi/health](https://rebates.ophis.fi/health)       | JSON. `last_pipeline_run_at` is nullable until a nightly pipeline completes and is the liveness signal thereafter; do not treat `ok: true` alone as proof that the nightly pipeline has run. `last_fetch` moves only when a new tagged trade is inserted. Cloudflare `530` / error `1033` means the tunnel replica is disconnected. |
| Optimism orderbook  | [version check](https://optimism-mainnet.ophis.fi/api/v1/version)   | HTTP 200 plus a version string confirms the public chain-10 orderbook is reachable. |
| Unichain orderbook  | [version check](https://unichain-mainnet.ophis.fi/api/v1/version)   | HTTP 200 plus a version string confirms reachability. It returned Cloudflare 530 / error 1033 during the 5 August 2026 audit; verify this endpoint before routing. |
| Robinhood orderbook | [version check](https://robinhood-mainnet.ophis.fi/api/v1/version) | HTTP 200 plus a version string confirms the public chain-4663 orderbook is reachable. |

The Robinhood deployment is also covered by a daily read-only production
canary. It verifies chain identity, Ophis settlement/relayer/EthFlow bytecode,
WETH and USDG metadata, the official Stock Token registry and ERC-8056
multiplier, the default token list, and orderbook version. Its workflow is
[`robinhood-mainnet-canary.yml`](https://github.com/ophis-fi/ophis/actions/workflows/robinhood-mainnet-canary.yml).

## Settlement model per chain

Ophis settles across two kinds of chains:

“Production” below means the contracts and configured routing surface exist; it
does not promise current uptime. Use the linked checks above before routing.

- **CoW-hosted chains**: Ethereum, BNB Chain, Gnosis, Polygon, Base, Arbitrum,
  Avalanche, Linea, Ink, and Plasma. Orders settle through CoW Protocol's
  production orderbooks (`api.cow.fi`) using the canonical CoW contracts. Their
  status mirrors [CoW Protocol's status](https://status.cow.fi).
- **Ophis-operated chains**: Optimism (chain 10), Unichain (chain 130), and
  Robinhood Chain (chain 4663). Orders settle through Ophis's self-hosted
  orderbooks at `optimism-mainnet.ophis.fi`, `unichain-mainnet.ophis.fi`, and
  `robinhood-mainnet.ophis.fi` using Ophis-deployed (non-canonical) `GPv2Settlement`
  contracts. Always resolve per-chain settlement and orderbook hosts via the
  `@ophis/sdk` helpers or the MCP `list_chains` tool rather than hardcoding addresses.

Solana and Bitcoin are supported as **destinations** via
[NEAR Intents](https://near.org/intents), not as source-chain orderbooks.

## Incidents

Operational incidents and maintenance are announced on
[x.com/ophisfi](https://x.com/ophisfi). The canonical source of truth for what
is deployed is the [`ophis-fi/ophis`](https://github.com/ophis-fi/ophis)
repository.
