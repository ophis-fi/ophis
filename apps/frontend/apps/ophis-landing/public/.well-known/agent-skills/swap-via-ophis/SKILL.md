---
name: swap-via-ophis
description: Swap or bridge tokens through Ophis, an intent-based DEX aggregator. Parse a natural-language request, get a best-execution quote, build an EIP-712 order, sign it in the user's own wallet, and submit it. Non-custodial: the agent never holds keys or funds.
license: MIT
---

# Swap via Ophis

Ophis is a non-custodial, intent-based DEX aggregator (a CoW Protocol fork) live
on Optimism and 10 other EVM chains, with Solana and Bitcoin as cross-chain
destinations via NEAR Intents. Orders settle inside batch auctions at a uniform
clearing price, so they are MEV-protected by construction. The user (or an agent
acting on their behalf) always signs the final order locally, in their own
wallet. Ophis never custodies keys or funds.

## When to use this skill

Use it when a user wants to swap one token for another, or bridge to another
chain, and you want best execution with MEV protection and a predictable fee.

## Capabilities and endpoints

All endpoints are public and require no API key or authentication.

1. Parse intent: `POST https://ophis.fi/api/intent`
   - Body: `{ "text": "swap 100 USDC for ETH on Base" }`
   - Returns a structured `ParsedIntent` (sellToken, buyToken, amount, chain).
   - Rate limited to 30 requests/min/IP. See https://ophis.fi/openapi.json.

2. Full trade lifecycle via the hosted MCP server: `https://mcp.ophis.fi/mcp`
   (discovery at `https://ophis.fi/.well-known/mcp.json`). Tools:
   - `parse_intent` natural language to a structured intent
   - `get_quote` best-execution quote for a pair/amount/chain
   - `build_order` a bounded, EIP-712-signable order (receiver pinned to owner)
   - `submit_order` broadcast a signed order to the orderbook
   - `lookup_tier` a wallet's fee-rebate tier
   - `list_chains` per-chain settlement domain + orderbook host

## How to swap (recommended flow)

1. `parse_intent` to turn the user request into a structured intent.
2. `get_quote` for the parsed pair, amount, and chain.
3. `build_order` to get the exact EIP-712 typed data. Verify the receiver is the
   user's own address and the limit price is acceptable.
4. Sign the typed data in the user's wallet (EIP-712). Ophis never signs for you.
5. `submit_order` with the signature.

## Fees

A flat 0.10% (10 bps) fee on trade volume, with a reduced 0.01% (1 bp) on
stablecoin-to-stablecoin swaps. A share of fees is returned monthly to active
wallets as volume-tier rebates. The `@ophis/sdk` npm package exposes
`buildOphisAppDataPartnerFee`, `OPHIS_VOLUME_FEE_BPS`,
`OPHIS_STABLE_VOLUME_FEE_BPS`, and `ophisVolumeBpsForPair(isStablePair)`.

## Safety

- Non-custodial: confirm the order's `receiver` equals the user's address before
  signing; `build_order` pins it by default.
- The settlement contract on Optimism is Ophis's own GPv2Settlement at
  `0x310784c7FCE12d578dA6f53460777bAc9718B859` (NOT CoW's canonical address).
  Always resolve the per-chain settlement domain via `list_chains` or the SDK.
- Ophis intentionally does not implement HTTP-native payment automation; the
  user's wallet signature is the trust boundary.
