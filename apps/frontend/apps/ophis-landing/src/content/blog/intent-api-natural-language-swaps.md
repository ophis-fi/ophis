---
title: "The Ophis Intent API: turn natural language into a signable swap"
description: "The Ophis Intent API is a free public endpoint (POST swap.ophis.fi/api/intent) that parses natural-language swap requests into typed swap entities. Send free-form text, get back sellToken, buyToken, amount, and chain."
pubDate: 2026-07-18
author: Ophis
tags: [intent-api, api, agents, intents, defi]
draft: true
# cover: ./intent-api-natural-language-swaps.cover.jpg  # add a 2:1 cover image (jpg), then uncomment and set draft:false
coverAlt: "Ophis emblem with an API request turning a natural-language sentence into typed swap parameters"
---

The Ophis Intent API is a free public endpoint that parses a natural-language swap request into typed swap entities. You POST free-form text to `https://swap.ophis.fi/api/intent`, and you get back a structured intent naming the `sellToken`, the `buyToken`, the `amount`, and the `chain`, ready to hand to a signing flow or a swap deep link. It is the keyless front door to the same rails that power the [Ophis](https://ophis.fi/) app, the SDK, and the MCP server.

This article is the how-to. It covers exactly what you send, what comes back, the rate limit, worked examples in three languages, and how to take a parsed intent all the way to a signed order or a shareable link. For the field-by-field specification, the spec target is [docs.ophis.fi/intent-api](https://docs.ophis.fi/intent-api); this page is the hub that points you there.

## What is the Intent API?

An intent is a description of a trade you want, not the transaction that performs it. On a normal DEX you assemble calldata: a router address, a path, slippage, deadlines. An intent skips all of that. You say what you want ("swap 250 USDC for WETH on Base"), and the parsing happens server-side.

The Intent API does the parsing step and nothing else. It is stateless, it holds no keys, and it never signs or submits anything. It reads a sentence and returns typed parameters (parsing is backed by a LibertAI-hosted model). That separation is the point: parsing is a public, keyless operation, while signing stays entirely on your side.

## What you send and what you get back

You send a single JSON body with a `text` field:

```json
{ "text": "swap 250 USDC for WETH on Base" }
```

The response wraps the parsed result. `entities` is an array of typed spans, one per slot the parser recognized:

```json
{
  "ok": true,
  "data": {
    "intent": "swap",
    "entities": [
      { "type": "amount",    "value": "250",  "raw": "250",  "start": 5,  "end": 8 },
      { "type": "sellToken", "value": "USDC",  "raw": "USDC", "start": 9,  "end": 13 },
      { "type": "buyToken",  "value": "WETH",  "raw": "WETH", "start": 18, "end": 22 },
      { "type": "chain",     "value": "base",  "raw": "Base", "start": 26, "end": 30 }
    ]
  }
}
```

The `intent` field names the action. Each entity span has a `type` (`amount`, `sellToken`, `buyToken`, or `chain`), a normalized `value`, the `raw` text it matched, and the `start`/`end` character offsets in your input. Tokens come back as symbols, `amount` as a human-units string, and `chain` as a network name such as `base` or `optimism` (you map that name to a chain id when you build the order). When the text omits a chain, no `chain` span is returned, so your client can prompt for one or fall back to a default. The parser is permissive about content: text it cannot read as a swap returns `ok: true` with `intent: "unknown"` and an empty `entities` array, and an unknown token symbol is echoed back in its span rather than rejected. Failures use a separate envelope, `ok: false` with an `error` object carrying a `code`: a malformed request (a missing `text` field, or text over 280 characters) returns `BAD_INPUT`, and operational conditions surface as an HTTP error status with `RATE_LIMITED` (429), `FORBIDDEN` (403), `TIMEOUT` (504), or `UPSTREAM` (502). So treat any non-2xx response or `ok: false` as a failure, and on success confirm you got every entity you need (a sell token, a buy token, an amount, and a chain) and that the tokens resolve on the target chain before you build an order.

The endpoint is free and rate-limited to 30 requests per minute per IP, sized for interactive use and agent loops. The MCP `parse_intent` tool calls this same endpoint, so it shares the same limit.

## Worked examples

Every call hits the same canonical host, `https://swap.ophis.fi/api/intent`. Here is the same request in three languages.

**curl:**

```bash
curl -s https://swap.ophis.fi/api/intent \
  -H 'content-type: application/json' \
  -d '{"text":"swap 250 USDC for WETH on Base"}'
```

**JavaScript (fetch):**

```javascript
const res = await fetch("https://swap.ophis.fi/api/intent", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "swap 250 USDC for WETH on Base" }),
})
const { ok, data } = await res.json()
if (ok) {
  // entities is an array of typed spans; fold it into a lookup by type:
  const slots = Object.fromEntries(data.entities.map((e) => [e.type, e.value]))
  console.log(slots) // { amount: "250", sellToken: "USDC", buyToken: "WETH", chain: "base" }
}
```

**Python (requests):**

```python
import requests

res = requests.post(
    "https://swap.ophis.fi/api/intent",
    json={"text": "swap 250 USDC for WETH on Base"},
)
body = res.json()
if body["ok"]:
    slots = {e["type"]: e["value"] for e in body["data"]["entities"]}
    print(slots)  # {'amount': '250', 'sellToken': 'USDC', 'buyToken': 'WETH', 'chain': 'base'}
```

The `chain` span comes back as a network name. Here are the supported networks and the chain ids you map them to when you build the order. Ophis is live on 12 EVM chains, and reaches Solana and Bitcoin destinations through NEAR Intents:

| Chain | Chain id |
| --- | --- |
| Ethereum | 1 |
| Optimism | 10 |
| BNB Chain | 56 |
| Gnosis | 100 |
| Unichain | 130 |
| Polygon | 137 |
| Base | 8453 |
| Arbitrum | 42161 |
| Avalanche | 43114 |
| Linea | 59144 |
| Ink | 57073 |
| Plasma | 9745 |
| Solana | via NEAR Intents |
| Bitcoin | via NEAR Intents |

## From parsed intent to execution

The Intent API gives you typed parameters. Turning them into a settled trade is a second step, and you have two paths.

**Sign an EIP-712 order.** Resolve the token symbols to addresses on the parsed chain, build an order (sell token, buy token, sell amount, a minimum buy amount as your limit price, and an expiry), and have the wallet sign it as [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data. The [`@ophis/sdk`](https://docs.ophis.fi/sdk) and the MCP `build_order` tool do this assembly for you, including resolving the correct settlement domain per chain. You sign locally and submit the signature. Nothing custodial happens: tokens stay in your wallet until a batch that includes your order settles.

**Build a swap deep link.** For a human-in-the-loop flow, hand the parsed pair off to a prefilled swap URL and let the person review and sign in the app. The app reads the intent from the URL so the form opens ready to confirm. This is the right path when you want an agent or a bot to surface a trade for approval rather than sign it unattended.

Either way, execution runs on the same mechanism. Orders clear in [CoW Protocol batch auctions at a uniform clearing price](/blog/mev-protection-batch-auctions/), so there is no transaction ordering inside a batch to exploit and no public mempool swap to sandwich. The protection is structural, not a best-effort add-on. And because you sign an order rather than broadcast a transaction, the flow is [gasless](/blog/gasless-swaps-how-intents-work/): a solver settles on-chain and pays the gas, and the fee comes out of the token you sell.

## Using the Intent API from an agent

The Intent API is a natural function-calling tool. Register it with a schema that takes one string, and your model can turn a user request into typed swap parameters with a single call, no keys and no auth. It is the keyless alternative to the [MCP server](https://mcp.ophis.fi/mcp) at `mcp.ophis.fi/mcp`: MCP gives an agent the full quote-build-submit loop over a structured protocol, while the Intent API is a plain HTTP endpoint you can wire into any stack that can POST JSON.

A common pattern pairs them. The Intent API parses the sentence into an intent, and then the SDK or MCP tools take that intent through `get_quote`, `build_order`, and `submit_order`, with the receiver pinned to the owner and the order bounded by the limit you set. The agent signs with its own key; Ophis never holds keys and never signs. The full safety model for unattended signing is in [how to let an AI agent swap tokens](/blog/let-an-ai-agent-swap-tokens/), and the framework-native path (function-calling tools for GOAT and AgentKit) is in [the GOAT SDK walkthrough](/blog/ai-agent-swaps-goat-agentkit/).

The fee depends on how you route. The swap app charges a flat 0.10% (10 bps) of volume, reduced to 0.01% (1 bp) for same-chain stablecoin-to-stablecoin pairs; SDK and keyless-MCP integrations settle on a 5 bps base. Either way the fee is taken in the sell token and takes no share of any price improvement your order earns. High-volume wallets also share a monthly WETH rebate pool (21.25% of collected WETH fees), allocated by a 30-day volume tier weighted from 10% up to 50%.

## FAQ

### What is the Intent API?

It is a free public HTTP endpoint, `POST https://swap.ophis.fi/api/intent`, that parses a natural-language swap request into typed swap entities. You send free-form text and get back a structured intent whose `entities` array carries the `sellToken`, `buyToken`, `amount`, and `chain`. It parses only; it never signs or holds funds.

### Is the Intent API free?

Yes. It is public and keyless, rate-limited to 30 requests per minute per IP. The MCP `parse_intent` tool calls the same endpoint and shares that limit.

### How do I sign the resulting order?

Resolve the parsed symbols to token addresses on the returned chain, build an order with a limit price and expiry, and sign it as EIP-712 typed data with your wallet. The `@ophis/sdk` and the MCP `build_order` tool assemble the order and resolve the per-chain settlement domain for you, so you only sign and submit.

### Do you hold my keys?

No. The Intent API parses text and returns parameters; it never receives, stores, or uses a private key. Signing happens locally in your wallet or agent, and Ophis never holds funds. Tokens stay in your wallet until a batch that includes your signed order settles.

## Start parsing intents

Send your first request to [`https://swap.ophis.fi/api/intent`](https://swap.ophis.fi/api/intent) with a line of free-form text, read the typed intent back, and hand it to a signed EIP-712 order or a prefilled swap link. For the field-level specification, the reference lives at [docs.ophis.fi/intent-api](https://docs.ophis.fi/intent-api).
