---
id: intent-api
title: Intent API
description: Parse a natural-language swap request into structured tokens, amount and chain fields.
sidebar_label: Intent API
sidebar_position: 1
---

import Head from '@docusaurus/Head';

export const howToLd = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to call the Ophis Intent API",
  "description": "Turn a natural-language swap request into structured fields with the Ophis Intent API.",
  "totalTime": "PT3M",
  "tool": [
    {
      "@type": "HowToTool",
      "name": "An HTTP client such as curl"
    },
    {
      "@type": "HowToTool",
      "name": "The @ophis/sdk package on npm (optional)"
    }
  ],
  "step": [
    {
      "@type": "HowToStep",
      "name": "Send the request",
      "url": "https://docs.ophis.fi/intent-api#request",
      "text": "Send POST /api/intent to https://ophis.fi with a JSON body containing text."
    },
    {
      "@type": "HowToStep",
      "name": "Read the response",
      "url": "https://docs.ophis.fi/intent-api#response",
      "text": "Read intent and entities from data when ok is true."
    },
    {
      "@type": "HowToStep",
      "name": "Handle errors",
      "url": "https://docs.ophis.fi/intent-api#errors",
      "text": "Read error.code and error.message when ok is false, and honour Retry-After for rate limits."
    }
  ]
};

<Head>
  <script type="application/ld+json">{JSON.stringify(howToLd)}</script>
</Head>


# Intent API

Turn a natural-language swap request into structured fields for your app or agent.

<Cards>
<Card icon="key-round" title="Public access">Call the endpoint without an API key.</Card>
<Card icon="braces" title="Structured output">Read the tokens, amount and chain from a ParsedIntent.</Card>
<Card icon="wallet" title="Wallet signing" href="/ai-agents">Use the parsed fields to build an order for your wallet to sign.</Card>
</Cards>

## Parse a request

<Steps>

1. **Send the request.** Send POST /api/intent to https://ophis.fi with a JSON body containing text.
2. **Read the response.** Read intent and entities from data when ok is true.
3. **Handle errors.** Read error.code and error.message when ok is false, and honour Retry-After for rate limits.

</Steps>

```bash
curl -sS https://ophis.fi/api/intent \
  -H 'content-type: application/json' \
  -d '{"text":"swap 100 USDC for ETH on Base"}'
```

## Request fields {/* #request */}

| Setting | Value |
| --- | --- |
| Base URL | `https://ophis.fi` |
| Endpoint | `POST /api/intent` |
| Authentication | No API key required |
| `text` | Required string, 1–280 characters, case-insensitive |
| Specification | [openapi.json](https://ophis.fi/openapi.json) |

```json
{ "text": "swap 100 USDC for ETH on Base" }
```

## Response fields {/* #response */}

A successful request returns `200 OK` with a `ParsedIntent` in `data`:

```json
{
  "ok": true,
  "data": {
    "intent": "swap",
    "entities": [
      { "type": "amount",    "value": "100",  "raw": "100",  "start": 5,  "end": 8 },
      { "type": "sellToken", "value": "USDC",  "raw": "USDC", "start": 9,  "end": 13 },
      { "type": "buyToken",  "value": "ETH",   "raw": "ETH",  "start": 18, "end": 21 },
      { "type": "chain",     "value": "base",  "raw": "Base", "start": 25, "end": 29 }
    ]
  }
}
```

### ParsedIntent

| Field | Type | Description |
| --- | --- | --- |
| `intent` | `"swap"` \| `"unknown"` | `unknown` with empty `entities` for text outside swap requests. |
| `entities` | `Entity[]` | Recognised entities, in any order. |

### Entity

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"sellToken"` \| `"buyToken"` \| `"amount"` \| `"chain"` | The token you sell, token you buy, amount or chain. |
| `value` | string | Canonical form, such as `USDC`, `0.5` or `optimism`; token symbols use 2–12 letters/digits with at least one letter, excluding common non-token words. |
| `raw` | string | A case-insensitive match in the input that the value derives from. |
| `start` | integer | Model-proposed start offset, inclusive and within the input. |
| `end` | integer | Model-proposed end offset, exclusive and within the input. |

:::tip[Validate before quoting]

Find `raw` in the input again before using it for highlighting. Resolve each token to its chain and contract address, then request a quote before building an order.

:::

## Chain values

The parser returns these lowercase slugs:

| Slug | Slug |
| --- | --- |
| `ethereum` | `arbitrum` |
| `arc` | `avalanche` |
| `base` | `bnb` |
| `gnosis` | `ink` |
| `linea` | `optimism` |
| `plasma` | `polygon` |
| `robinhood` | `unichain` |

## Access controls {/* #access-control */}

| Control | Behaviour |
| --- | --- |
| Browser origins | A non-null `Origin` must be `https://ophis.fi` or `https://swap.ophis.fi`; other origins receive `403 FORBIDDEN`. |
| Server calls | curl and server-side scripts can omit `Origin`. |
| Rate limit | 30 requests per IP per rolling 60-second window; excess requests receive `429` and `Retry-After`. |
| Edge cache | Identical lowercased, trimmed text within an origin bucket is cached for 5 minutes. |
| Cache hits | `x-ophis-cache: hit`; counts toward the rate limit and saves an upstream model call. |
| Parser | LibertAI Qwen 3.6 27B on Aleph Cloud, through a Cloudflare Pages Function. |
| Model access | The LibertAI key stays on the server; `temperature: 0` reduces output variation. |

## Error codes {/* #errors */}

Errors return `{ "ok": false, "error": { "code", "message" } }`:

| Status | `code` | Cause or action |
| --- | --- | --- |
| `400` | `BAD_INPUT` | Missing or empty `text`, text over 280 characters, or invalid JSON. |
| `403` | `FORBIDDEN` | The supplied `Origin` is outside the allowlist. |
| `429` | `RATE_LIMITED` | More than 30 requests in 60s from your IP; honour `Retry-After`. |
| `500` | `UPSTREAM` | The server's model key is unset. |
| `502` | `UPSTREAM` / `INVALID_JSON` | The parser was unreachable, returned a non-2xx response or failed schema validation. |
| `504` | `TIMEOUT` | The parser exceeded the 5-second timeout. |

```json
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "too many requests" } }
```

## Response headers

| Header | Value |
| --- | --- |
| `cache-control` | `no-store` |
| `x-content-type-options` | `nosniff` |
| `x-frame-options` | `DENY` |
| `referrer-policy` | `no-referrer` |
| `x-ophis-cache` | `hit` on a cache hit |

## Next

<Cards>
<Card icon="bot" title="Agent integration" href="/ai-agents">Connect an agent and build a signed order.</Card>
<Card icon="code" title="SDK integration" href="/partners">Build and submit orders with the Ophis SDK.</Card>
</Cards>
