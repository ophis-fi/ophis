---
id: status
title: Status
sidebar_label: Status
description: Check Ophis services, health endpoints and settlement providers.
---

# Status

Check service availability through the Ophis apps and health endpoints below.

## Service checks {/* #services */}

| Service | URL | Check |
| --- | --- | --- |
| Swap app | [swap.ophis.fi](https://swap.ophis.fi) | The token-picker swap form loads. |
| Landing | [ophis.fi](https://ophis.fi) | The homepage loads. |
| Docs | [docs.ophis.fi](https://docs.ophis.fi) | Documentation pages load. |
| Explorer | [explorer.ophis.fi](https://explorer.ophis.fi) | Order and trade search loads. |
| Intent API | `POST https://ophis.fi/api/intent` | Send a request using the [Intent API](/intent-api) format. |
| MCP server | `https://mcp.ophis.fi/mcp` | Use Streamable-HTTP with `Accept: text/event-stream`; see [AI agents](/ai-agents). |
| Indexer | [rebates.ophis.fi/health](https://rebates.ophis.fi/health) | Check the JSON fields below. |
| Optimism orderbook | [version check](https://optimism-mainnet.ophis.fi/api/v1/version) | HTTP 200 and a version string confirm chain-10 orderbook reachability. |
| Unichain orderbook | [version check](https://unichain-mainnet.ophis.fi/api/v1/version) | HTTP 200 and a version string confirm chain-130 orderbook reachability. |
| Robinhood orderbook | [version check](https://robinhood-mainnet.ophis.fi/api/v1/version) | HTTP 200 and a version string confirm chain-4663 orderbook reachability. |
| Arc orderbook | [version check](https://arc-mainnet.ophis.fi/api/v1/version) | Check chain-5042 orderbook reachability. |

## Health responses

| Response or field | Meaning |
| --- | --- |
| MCP HTTP 406 | Include `Accept: text/event-stream` in your request. |
| `last_pipeline_run_at` | Time of the last completed nightly pipeline; null until the first completion. |
| `last_fetch` | Updates when a new tagged trade is inserted. |
| Cloudflare `530` / error `1033` | The tunnel replica is disconnected. |

:::tip
Use `last_pipeline_run_at` to check pipeline liveness, including responses with `ok: true`. For an orderbook response other than HTTP 200, wait for recovery before routing orders.
:::

The [daily Robinhood canary](https://github.com/ophis-fi/ophis/actions/workflows/robinhood-mainnet-canary.yml) checks chain identity, settlement/relayer/EthFlow bytecode, WETH and USDG metadata, the Stock Token registry, ERC-8056 multiplier, token list and orderbook version.

## Settlement providers {/* #settlement-model-per-chain */}

| Provider | Chains | Settlement |
| --- | --- | --- |
| CoW-hosted | Ethereum, BNB Chain, Gnosis, Polygon, Base, Arbitrum, Avalanche, Linea, Ink, Plasma | Production orderbooks at `api.cow.fi` and canonical CoW contracts; check [CoW Protocol status](https://status.cow.fi). |
| Ophis-operated | Optimism (chain 10), Unichain (chain 130), Robinhood Chain (chain 4663), Arc (chain 5042) | Ophis orderbooks listed above and Ophis-deployed `GPv2Settlement` contracts. |
| [NEAR Intents](https://near.org/intents) | Solana, Bitcoin, Monad, Hyperliquid (Hypercore), X Layer, Sui, Tron, Starknet, Zcash | Sources and destinations in the standalone app; external-source swaps begin with a deposit. |

Resolve SDK-supported chains through `@ophis/sdk` v0.4.3 or MCP `list_chains`; both include Arc.

## Next

<Cards>
<Card icon="globe" title="Networks & assets" href="/networks-assets">Check supported assets and bridge requirements.</Card>
<Card icon="shield-check" title="Security & audits" href="/audits">Find settlement addresses and security controls.</Card>
<Card icon="braces" title="Intent API" href="/intent-api">Send natural-language requests from your application.</Card>
</Cards>
