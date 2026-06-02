---
id: intent-api
title: Intent API
description: POST /api/intent, turn a plain-English swap request into a structured ParsedIntent. Public, no key, rate-limited.
sidebar_label: Intent API
sidebar_position: 1
---

# Intent API

The Intent API parses a plain-English swap request into a structured
`ParsedIntent` that the Ophis frontend, or your own app or agent, can
use to pre-fill a swap form or construct a deep link.

It is Ophis's **only bespoke integration API**. To place orders
programmatically you use the standard CoW Protocol orderbook API per chain
(see [AI agent integration](./ai-agents.md)). The Intent API itself does not
place, sign, or execute trades; order signing always happens in the user's
wallet.

- **Base URL:** `https://ophis.fi`
- **Endpoint:** `POST /api/intent`
- **Auth:** none, no API key required.
- **Backed by:** LibertAI Qwen 3.6 27B (open-weights, on Aleph Cloud),
  behind a Cloudflare Pages Function proxy. The LibertAI key is held
  server-side and never reaches callers.
- **Machine-readable spec:** [openapi.json](https://ophis.fi/openapi.json)

## Access control

| Control | Behaviour |
| --- | --- |
| **Origin allowlist** | Requests with a non-null `Origin` header are checked against `https://ophis.fi` plus Cloudflare Pages preview subdomains. Browser calls from other origins get `403 FORBIDDEN`. |
| **Non-browser callers** | curl and server-side scripts that omit `Origin` entirely are **allowed**, subject to the rate limit. This is the path agents use. |
| **Rate limit** | 30 requests per IP per rolling 60-second window. Exceeding returns `429` with a `Retry-After` header. |
| **Caching** | Identical normalized text (lowercased + trimmed) within an origin bucket is served from a 5-minute edge cache. Cache hits return the header `x-ophis-cache: hit` and don't consume an upstream model call. The rate-limit counter still increments on a cache hit. |

:::note[Origin is a speed bump, not a security boundary]

The `Origin` check raises the bar for casual browser abuse but can be
omitted by any non-browser client. The real protections are the per-IP
rate limit and the fact that the endpoint only normalizes text, it
moves no funds.

:::

## Request

`POST /api/intent` with a JSON body:

```json
{ "text": "swap 100 USDC for ETH on Base" }
```

| Field | Type | Constraints |
| --- | --- | --- |
| `text` | string | Required. 1–280 characters. Plain-English swap request. Case-insensitive. |

The model is pinned to `temperature: 0`, so identical normalized inputs
produce identical outputs.

### Example

```bash
curl -sS https://ophis.fi/api/intent \
  -H 'content-type: application/json' \
  -d '{"text":"swap 100 USDC for ETH on Base"}'
```

## Response

On success, `200 OK` with a `ParsedIntent`:

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

### `ParsedIntent`

| Field | Type | Description |
| --- | --- | --- |
| `intent` | `"swap"` \| `"unknown"` | `unknown` (with an empty `entities` array) if the text isn't a swap request. |
| `entities` | `Entity[]` | The recognised entities, in any order. |

### `Entity`

| Field | Type | Description |
| --- | --- | --- |
| `type` | `"sellToken"` \| `"buyToken"` \| `"amount"` \| `"chain"` | The kind of entity. `sellToken` is what you pay with; `buyToken` is what you want. |
| `value` | string | Canonical form (e.g. `USDC`, `0.5`, `optimism`). |
| `raw` | string | The exact substring from the input. |
| `start` | integer | 0-indexed start offset of `raw` (inclusive). |
| `end` | integer | 0-indexed end offset of `raw` (exclusive). `text.slice(start, end) === raw`. |

**Token values** are validated against an internal allowlist (200+
DEX-traded symbols). Unknown symbols are filtered out, the response
still includes the other entities, with the unknown one omitted.

**Chain values** are lowercase slugs, limited to the chains the network
selector can route to:

```
ethereum  arbitrum  avalanche  base  bnb  gnosis
ink  linea  optimism  plasma  polygon
```

## Errors

Errors return `{ "ok": false, "error": { "code", "message" } }`:

| Status | `code` | When |
| --- | --- | --- |
| `400` | `BAD_INPUT` | Missing/empty `text`, `text` over 280 chars, or an invalid JSON body. |
| `403` | `FORBIDDEN` | The `Origin` header is present but not on the allowlist. |
| `429` | `RATE_LIMITED` | More than 30 requests in 60s from your IP. Honour `Retry-After`. |
| `500` | `UPSTREAM` | Operator configuration error (the model key is unset). |
| `502` | `UPSTREAM` / `INVALID_JSON` | The upstream parser was unreachable, returned a non-2xx, or produced output that failed schema validation. |
| `504` | `TIMEOUT` | The upstream parser didn't respond within 5 seconds. |

The full set of error codes is
`TIMEOUT | UPSTREAM | INVALID_JSON | BAD_INPUT | RATE_LIMITED | FORBIDDEN`.

```json
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "too many requests" } }
```

## Response headers

Every response sets `cache-control: no-store`, `x-content-type-options: nosniff`,
`x-frame-options: DENY`, and `referrer-policy: no-referrer`. A cache hit
additionally sets `x-ophis-cache: hit`.

## Trust model

Ophis is non-custodial. This endpoint **does not place, sign, or execute
trades**, it only normalizes natural language into structured entities.
Order signing always happens in the user's wallet on the frontend. To
submit orders programmatically, use the
[CoW Protocol orderbook API](https://docs.cow.fi/cow-protocol/reference/apis/orderbook)
directly against the relevant orderbook host.
