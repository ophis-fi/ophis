---
id: ai-agents
title: AI agent integration
description: Wire the Ophis Intent API into LangChain, AutoGPT, or any function-calling agent — parse a request, build a deep link, let the user sign.
sidebar_label: AI agent integration
sidebar_position: 2
---

# AI agent integration

Ophis is designed to be agent-friendly. The [Intent API](./intent-api.md)
accepts free-form natural language and returns structured JSON your agent
can map directly to a pre-filled swap link. The agent does the parsing
and routing; **the human always reviews and signs.**

## The integration flow

1. **Parse.** `POST` the user's request (or your agent-generated trade
   idea) to `https://ophis.fi/api/intent`.
2. **Read.** Receive a `ParsedIntent` with normalized `sellToken`,
   `buyToken`, `amount`, and `chain` entities.
3. **Build a deep link.** Map the chain slug to its chain ID and
   construct `https://ophis.fi/#/<chainId>/swap/<sellToken>/<buyToken>`.
4. **Hand off.** Open the link for the user to review and sign. Ophis
   never auto-signs — every order requires explicit wallet approval.

:::warning The signature is the trust boundary
Ophis intentionally does **not** implement [x402](https://x402.org) or any
HTTP-native payment automation. An order only becomes real when the user
signs it in their wallet; bypassing that step would break self-custody.
Agents must always hand off to the user for signing.
:::

Server-side callers (no browser `Origin` header) are allowed, subject to
the 30 req/min/IP rate limit. Honour `429` + `Retry-After`.

## Minimal example (curl)

```bash
curl -sS https://ophis.fi/api/intent \
  -H 'content-type: application/json' \
  -d '{"text":"swap 100 USDC for ETH on Base"}'
```

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

## Python helper

```python
import requests

OPHIS = "https://ophis.fi"

# The 11 EVM chains the Intent API can return, mapped to their chain IDs.
# Keep in sync with the API's supported-network list; build_deeplink()
# raises on any future slug not listed here rather than misrouting it.
CHAIN_SLUG_TO_ID = {
    "ethereum": 1,
    "optimism": 10,
    "bnb": 56,
    "gnosis": 100,
    "polygon": 137,
    "base": 8453,
    "ink": 57073,
    "linea": 59144,
    "arbitrum": 42161,
    "avalanche": 43114,
    "plasma": 9745,
}


def parse_intent(text: str) -> dict:
    """Call the Ophis Intent API and return the ParsedIntent payload."""
    resp = requests.post(f"{OPHIS}/api/intent", json={"text": text}, timeout=10)
    resp.raise_for_status()
    body = resp.json()
    if not body["ok"]:
        raise RuntimeError(f'{body["error"]["code"]}: {body["error"]["message"]}')
    return body["data"]


def build_deeplink(parsed: dict) -> str:
    """Turn a ParsedIntent into a swap deep link for the user to sign."""
    by_type = {e["type"]: e["value"] for e in parsed["entities"]}
    sell = by_type.get("sellToken", "_")
    buy = by_type.get("buyToken", "_")
    chain_slug = by_type.get("chain")
    if chain_slug is None:
        chain_id = 1  # no chain in the request -> default to Ethereum
    elif chain_slug in CHAIN_SLUG_TO_ID:
        chain_id = CHAIN_SLUG_TO_ID[chain_slug]
    else:
        # The parser may return a chain this map doesn't cover yet. Fail
        # loud instead of silently routing the user to the wrong chain.
        raise ValueError(f"unmapped chain slug {chain_slug!r}; update CHAIN_SLUG_TO_ID")
    # The user sets/confirms the amount and signs in the app.
    return f"{OPHIS}/#/{chain_id}/swap/{sell}/{buy}"


intent = parse_intent("swap 100 USDC for ETH on Base")
print(build_deeplink(intent))  # https://ophis.fi/#/8453/swap/USDC/ETH
```

## LangChain tool

Wrap the API as a [LangChain](https://python.langchain.com) tool your
agent can call when a user wants to trade:

```python
from langchain_core.tools import tool


@tool
def ophis_swap_intent(text: str) -> dict:
    """Parse a plain-English swap request into a structured Ophis intent
    and a deep link the user can open to review and sign. Use this
    whenever a user wants to swap, buy, or sell a crypto token.
    The link must be shown to the user — never auto-execute a trade."""
    parsed = parse_intent(text)
    return {"intent": parsed, "deeplink": build_deeplink(parsed)}
```

The tool returns both the structured intent (so your agent can reason
about the trade) and a link (so the user can sign it).

## AutoGPT / function-calling agents

Any function-calling agent — AutoGPT commands, OpenAI Assistants, or a
custom tool loop — can register the parser with this schema:

```json
{
  "type": "function",
  "function": {
    "name": "ophis_parse_intent",
    "description": "Parse a plain-English crypto swap request into a structured intent (sellToken, buyToken, amount, chain). Returns a deep link the user opens to review and sign. Never auto-executes a trade.",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "The swap request in plain English, e.g. 'swap 100 USDC for ETH on Base'. Max 280 characters."
        }
      },
      "required": ["text"]
    }
  }
}
```

Implement the handler by `POST`ing `{ "text": <text> }` to
`https://ophis.fi/api/intent` (see the Python helper above), then surface
the resulting deep link to the user.

## Submitting orders programmatically

The Intent API only normalizes language — it does not place orders. To
submit orders programmatically, use the
[CoW Protocol orderbook API](https://docs.cow.fi/cow-protocol/reference/apis/orderbook)
directly:

- CoW-aligned chains use `api.cow.fi`.
- Ophis-specific orderbook deployments follow the same schema (e.g.
  Optimism mainnet at `optimism-mainnet.ophis.fi`).

Even then, the order must carry a valid signature from the user's wallet
— the self-custody model is non-negotiable.
