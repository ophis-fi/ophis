# @ophis/mcp-server

Agent-facing **MCP server** for the Ophis DEX, deployed as a Cloudflare Worker
with the Streamable-HTTP transport at **`https://mcp.ophis.fi/mcp`**.

It exposes the Ophis trading surface to autonomous agents and MCP clients
without making them re-derive the fork's non-obvious, easy-to-get-wrong details
(non-canonical settlement contracts on the Ophis-operated chains, the self
-hosted Optimism orderbook host, the CIP-75 partner-fee appData shape, and
receiver pinning).

## Security model

The server holds **no private keys and never signs**. `build_order` returns a
*bounded, ready-to-sign* EIP-712 payload with the order **receiver pinned to the
owner** (the #1 autonomous-agent drain vector); the agent signs with its own key
and submits. This is the V1 "bounded capability" pattern — an off-chain misuse
guard, not an on-chain authorization boundary. It is public and unauthenticated:
every backing endpoint is already public, and the tools are read/build-only.

## Tools

| Tool | Purpose |
|------|---------|
| `parse_intent` | Plain-English swap request → structured intent (LibertAI Qwen via `swap.ophis.fi/api/intent`). |
| `resolve_token` | Resolve a token symbol to its canonical address from the trusted Ophis/CoW list; fails closed (anti-spoof). |
| `list_chains` | Supported chains, orderbook hosts, settlement contracts, partner-fee config. |
| `get_quote` | Best-execution quote from the chain's Ophis orderbook (`/api/v1/quote`). |
| `expected_surplus` | Estimate price improvement versus a public aggregator (KyberSwap), in basis points. |
| `build_order` | A bounded, ready-to-sign CoW order: correct per-chain settlement + orderbook, CIP-75 partner fee in appData, receiver pinned to owner. |
| `submit_order` | Relay a **pre-signed** order to the orderbook (`/api/v1/orders`). No keys held here. |
| `lookup_tier` | A wallet's fee-rebate tier + live status (`rebates.ophis.fi/tier/:wallet`). |
| `get_integrator_earnings` | What an integrator's own-fee routing earned, by appCode: routed volume + own-fee + referral rebate paid-to-date across all served chains, with figures split sovereign (Optimism, Unichain: swept in full) vs CoW-hosted (gross, not guaranteed) (`rebates.ophis.fi/earnings/:appCode`). |
| `get_balances` | Native + ERC-20 balances for an address on one chain. |
| `get_portfolio` | Native + ERC-20 balances across multiple chains. |
| `get_gas` | Current gas price for a chain (informational; trades are gasless for the trader). |
| `get_token_chart` | OHLCV price history for a token. |
| `validate_order` | Offline preflight for an externally-built order (no network, no keys): catches wrong appCode, orderbook host, EIP-712 domain, appData hash mismatch, unpinned receiver, and expired or non-zero-fee orders. |

## Typical agent flow

```
parse_intent("swap 100 USDC for WETH on Optimism")
  → resolve_token({ chainId, symbol }) for BOTH the sell and buy symbols   // canonical addresses, fails closed (anti-spoof); for a native-coin request like ETH, resolve the wrapped symbol (WETH)
  → get_quote({ chainId, sellToken, buyToken, kind:'sell', amount, from })
  → build_order({ chainId, owner, sellToken, buyToken, sellAmount, buyAmount /* slippage-adjusted */, kind })
  → (agent confirms with the user, then signs `order` as EIP-712 using `signing`)
  → submit_order({ chainId, order, signature, from, fullAppData })
```

## Develop

```bash
pnpm --filter @ophis/mcp-server test         # unit tests (pure logic)
pnpm --filter @ophis/mcp-server typecheck
pnpm --filter @ophis/mcp-server dev          # wrangler dev (local Streamable HTTP)
npx @modelcontextprotocol/inspector@latest   # point at http://localhost:8787/mcp
```

`dev` / `deploy` / `dry-run` auto-build the workspace SDK first (`pre*` scripts),
so a clean checkout works without a manual `@ophis/sdk` build.

## Deploy

Auto-deploys on push to `main` via `.github/workflows/mcp-deploy.yml`, using the
least-privilege `CLOUDFLARE_WORKERS_TOKEN` secret (Workers Scripts + Routes
only). Manual:

```bash
pnpm --filter @ophis/mcp-server deploy        # builds the SDK, then wrangler deploy → mcp.ophis.fi
```

Custom domain `mcp.ophis.fi` is provisioned from `wrangler.jsonc` (`routes`).
