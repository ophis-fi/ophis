---
name: swap-via-ophis
description: Swap or bridge tokens through Ophis, an intent-based DEX aggregator. Parse a natural-language request, get a best-execution quote, build an EIP-712 order, sign it in the user's own wallet, and submit it. Non-custodial: the agent never holds keys or funds.
license: MIT
---

# Swap via Ophis

Ophis is an intent-based DEX aggregator built on CoW Protocol. The swap app
supports 14 EVM chains including Arc; published SDK/MCP mappings cover 13 and
exclude Arc. Supported NEAR routes add Solana, Bitcoin, Monad, Hyperliquid,
X Layer, Sui and Tron destinations. This MCP workflow describes same-chain
signed ERC-20 orders, not every bridge flow. Batch auctions mitigate common MEV;
they do not eliminate every execution risk. Signing happens in the user's wallet.

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

Outside the current Arc release exception, batch-auction orders carry a 1 bp base
plus 80% of reference-quote improvement on volatile pairs (99 bps cap), or 50%
on stable pairs (20 bps cap). Optimism, Unichain and Robinhood Chain operated
backends add improvement capture; hosted orders encode it in appData alongside
the base, and CoW Protocol's own fees apply upstream. Use
`buildOphisAppDataPartnerFee(chainId, isStablePair)` rather than a volume-only
hosted entry. Approvals and other wallet transactions require gas. Details:
https://docs.ophis.fi/fees. A share of fees is returned
monthly to active wallets as volume-tier rebates. The `@ophis/sdk` npm package exposes
`buildOphisAppDataPartnerFee`, `OPHIS_VOLUME_FEE_BPS`,
`OPHIS_STABLE_VOLUME_FEE_BPS`, and
`ophisVolumeBpsForChainAndPair(chainId, isStablePair)`.

## Safety

- Non-custodial: confirm the order's `receiver` equals the user's address before
  signing; `build_order` pins it by default.
- The settlement contract on Optimism is Ophis's own GPv2Settlement at
  `0x310784c7FCE12d578dA6f53460777bAc9718B859`, and on Unichain it is
  `0x108A678716e5E1776036eF044CAB7064226F714E` (NOT CoW's canonical address).
  Always resolve the per-chain settlement domain via `list_chains` or the SDK.
- Ophis intentionally does not implement HTTP-native payment automation; the
  user's wallet signature is the trust boundary.

## The full skill family

For shell-capable agents (curl, jq, Foundry's cast) there is a complete
Ophis skill family, quote / swap / order status / cancel / surplus report,
with a machine-readable contract-pinning policy, at
https://ophis.fi/.well-known/agent-skills/ophis/SKILL.md (per-file sha256
digests in https://ophis.fi/.well-known/agent-skills/index.json). This page
stays as the compact MCP-first overview.
