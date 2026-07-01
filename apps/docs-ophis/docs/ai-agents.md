---
id: ai-agents
title: AI agent integration
description: Wire the Ophis Intent API into LangChain, AutoGPT, or any function-calling agent, parse a request, build a deep link, let the user sign.
sidebar_label: AI agent integration
sidebar_position: 2
---

# AI agent integration

Ophis is designed to be agent-friendly. The [Intent API](./intent-api.md)
accepts free-form natural language and returns structured JSON your agent
can map directly to a pre-filled swap link. The agent does the parsing
and routing; **the human always reviews and signs.**

:::tip[New: the full walkthrough]

For a narrative guide, including the MEV and key-safety pitfalls of letting an
agent trade, read
[How to let an AI agent swap tokens](https://ophis.fi/blog/let-an-ai-agent-swap-tokens)
on the Ophis blog.

:::

## MCP server (recommended)

The fastest way to give an MCP-capable agent full Ophis access is the hosted
**Model Context Protocol** server:

```
https://mcp.ophis.fi/mcp
```

It speaks streamable-HTTP MCP and exposes twelve tools:

| Tool | What it does |
| --- | --- |
| `parse_intent` | Parse a natural-language request into a structured intent. |
| `resolve_token` | Resolve a token symbol to its canonical address from the trusted Ophis/CoW token list; fails closed (anti-spoof). Call this before quoting or building so you never trade against a spoofed address. |
| `get_quote` | Fetch an executable quote for a parsed intent. |
| `build_order` | Build a bounded, ready-to-sign order (receiver pinned to the owner by default). |
| `submit_order` | Submit a signed order to the correct per-chain orderbook. |
| `lookup_tier` | Look up a wallet's 30-day volume tier / rebate status. |
| `list_chains` | Resolve supported chains and their settlement / orderbook hosts. |
| `get_balances` | Read a wallet's native and ERC-20 balances on one chain via a public RPC. |
| `get_portfolio` | Read a wallet's token balances across multiple chains. |
| `get_gas` | Fetch the current gas price for a chain. |
| `get_token_chart` | Fetch a token's OHLCV price chart. |
| `expected_surplus` | Estimate how much better an Ophis sell-quote beats the open market (`beatBps`). |

Point any MCP client (Claude, Cursor, or a custom agent) at that URL. Ophis
never holds keys: `build_order` returns a bounded order the agent signs
locally; the signature is the trust boundary (see the warning below). A bare
request without an `Accept: text/event-stream` header returns HTTP 406; that is
the transport negotiating, not an outage.

If you'd rather make a single REST call than wire up the full toolset, use the
[Intent API](./intent-api.md) directly, as shown next.

## The integration flow

1. **Parse.** `POST` the user's request (or your agent-generated trade
   idea) to `https://ophis.fi/api/intent`.
2. **Read.** Receive a `ParsedIntent` with normalized `sellToken`,
   `buyToken`, `amount`, and `chain` entities.
3. **Build a deep link.** Map the chain slug to its chain ID and
   construct `https://ophis.fi/#/<chainId>/swap/<sellToken>/<buyToken>`.
4. **Hand off.** Open the link for the user to review and sign. Ophis
   never auto-signs, every order requires explicit wallet approval.

:::warning[The signature is the trust boundary]

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

# The 12 EVM chains the Intent API can return, mapped to their chain IDs.
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
    "unichain": 130,
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
    """Parse a natural-language swap request into a structured Ophis intent
    and a deep link the user can open to review and sign. Use this
    whenever a user wants to swap, buy, or sell a crypto token.
    The link must be shown to the user, never auto-execute a trade."""
    parsed = parse_intent(text)
    return {"intent": parsed, "deeplink": build_deeplink(parsed)}
```

The tool returns both the structured intent (so your agent can reason
about the trade) and a link (so the user can sign it).

## AutoGPT / function-calling agents

Any function-calling agent. AutoGPT commands, OpenAI Assistants, or a
custom tool loop, can register the parser with this schema:

```json
{
  "type": "function",
  "function": {
    "name": "ophis_parse_intent",
    "description": "Parse a natural-language crypto swap request into a structured intent (sellToken, buyToken, amount, chain). Returns a deep link the user opens to review and sign. Never auto-executes a trade.",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "The swap request in natural language, e.g. 'swap 100 USDC for ETH on Base'. Max 280 characters."
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

The Intent API only normalizes language, it does not place orders. To submit
orders programmatically, build and sign a
[CoW Protocol order](https://docs.cow.fi/cow-protocol/reference/apis/orderbook)
yourself. Four things must each be exactly right, every one fails **silently**
(a rejected order, a wrong-chain trade, or zero fee collected) if you guess.

The helpers below live in **`@ophis/sdk`**, published on npm (v0.2.2, public).
Install it with `npm install @ophis/sdk`, or copy the values from the call-outs
if you prefer to vendor them.

### 1. Resolve the orderbook host from the chain ID

:::danger[Optimism and Unichain do not live on api.cow.fi]

Optimism and Unichain break the `api.cow.fi/<slug>` pattern. Ophis self-hosts
their orderbooks at `optimism-mainnet.ophis.fi` and `unichain-mainnet.ophis.fi`.
Posting one of their orders to `api.cow.fi/<slug>` (a host that does not serve
Ophis) **silently bypasses the Ophis solver and zeroes the partner fee**. Resolve
hosts via `@ophis/sdk` `getOphisOrderbookUrl` per chain rather than hardcoding.

:::

```typescript
import { getOphisOrderbookUrl } from '@ophis/sdk';

const orderbookUrl = getOphisOrderbookUrl(10); // -> https://optimism-mainnet.ophis.fi
// Throws on an invalid or unsupported chainId rather than guessing a host.
```

### 2. Build the partner-fee appData correctly

The partner fee is a flat 0.10% (10 bps) fee on trade volume, applied to every
trade, written into the order's `appData` at `metadata.partnerFee`. Use the
CIP-75 **volume** shape `{ volumeBps: 10, recipient }`, **not** the
price-improvement shape `{ priceImprovementBps, maxVolumeBps, recipient }`:
the two shapes use different denominators, so slotting a value into the wrong
field is a silent magnitude error. Hash the appData with cow-sdk's deterministic
serializer, **never** `keccak256(JSON.stringify(doc))`. JSON key order isn't
stable, so the hash won't match what solvers expect.

Stablecoin-to-stablecoin swaps pay a reduced 0.01% (1 bp): same-chain pairs
where both tokens are stablecoins use `{ volumeBps: 1, recipient }` instead of
`{ volumeBps: 10, recipient }`. The `@ophis/sdk` exposes
`OPHIS_STABLE_VOLUME_FEE_BPS` and a helper `ophisVolumeBpsForPair(isStablePair)`
to pick the right rate. The SDK is chain-only and cannot detect the pair itself,
so integrators pass `isStablePair` based on their own token classification.

```typescript
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/cow-sdk';
import { keccak256, toUtf8Bytes } from 'ethers';
import { buildOphisAppDataPartnerFee } from '@ophis/sdk';

// buildOphisAppDataPartnerFee(chainId) REQUIRES a chainId and THROWS on a
// missing/invalid one (a forgotten arg fails loud, not as a silent `undefined`).
// It returns the metadata.partnerFee value on every chain in the SDK's
// OPHIS_FEE_CHAIN_IDS (the Ophis-operated chains plus the CoW-hosted chains the
// fork serves), or `undefined` on any other chain.
//
// On Optimism the fee is an ENFORCED FLOOR: the self-hosted backend rejects
// (HTTP 400) any order to the Ophis fee recipient whose partner fee is below the
// floor (10 bps, or 1 bp for a same-chain stablecoin pair), or that uses a
// Surplus/PriceImprovement policy. Carry this fragment unchanged on OP: do not
// lower the bps and do not drop the fee, or the order is rejected.
const partnerFee = buildOphisAppDataPartnerFee(10);
// -> the Ophis flat-volume partner-fee fragment { volumeBps: 10, recipient }
//    for this chain (enforced as a minimum on Optimism: at least the floor)

const metadataApi = new MetadataApi();
const doc = await metadataApi.generateAppDataDoc({
  appCode: 'ophis',
  metadata: {
    partnerFee,
    hooks: {}, // pin empty, appData hooks are arbitrary on-chain calls
  },
});
const fullAppData = await stringifyDeterministic(doc);
const appDataHash = keccak256(toUtf8Bytes(fullAppData)); // bytes32 -> order.appData
```

### 3. Sign with the correct EIP-712 domain

CoW orders are signed with **EIP-712 typed data** (`signTypedData`), never
`signMessage`. The `verifyingContract` is chain-specific, and the Ophis-operated
chains do **not** use CoW's canonical settlement.

:::danger[The Optimism and Unichain settlements are not the canonical CoW one]

On Optimism, Ophis's GPv2Settlement is `0x310784c7…B859`, and on Unichain it is
`0x108A678716e5E1776036eF044CAB7064226F714E`, **not** the canonical
`0x9008D19f…ab41`. cow-sdk defaults to the canonical address, so signing an OP
order with the SDK default yields a domain separator the deployed contract
rejects, every order fails. Build the domain from the chain ID instead.

:::

```typescript
import { getOphisOrderDomain } from '@ophis/sdk';

// CoW's EIP-712 order struct is named `Order` (the Solidity library is
// GPv2Order, but the EIP-712 type name, which feeds the type hash, is
// `Order`; a wrong name produces a valid-looking but unusable signature).
const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
};

// ethers v6, signer.signTypedData(domain, types, value). The domain's
// verifyingContract must be the Ophis OP settlement (getOphisOrderDomain).
const signature = await wallet.signTypedData(getOphisOrderDomain(10), ORDER_TYPES, order);
// NOT wallet.signMessage(order), that produces an invalid order signature.
```

### 4. Pin the order `receiver`

A CoW order's `receiver` is part of the signed payload and is fully
caller-controlled. Pin it to the order owner: a non-owner receiver sends the
bought tokens elsewhere on settlement, and the signature makes that
irreversible. In the UI a wallet prompt gates this; an autonomous signer has no
such gate, so guard it in code before signing.

```typescript
import { assertReceiverIsOwner } from '@ophis/sdk';

assertReceiverIsOwner(owner, order.receiver); // throws if receiver !== owner
```

## Autonomous agent trading (advanced)

Everything above keeps a **human in the signing loop**. For an agent that signs
*without* human review, off-chain helpers are not enough, a compromised or
prompt-injected agent will sign whatever it is told. Safety has to be enforced
where the agent cannot reach it:

1. **Funds in a smart account (Safe).** The agent never holds the fund-owning
   key; it only *proposes* orders. The account's EIP-1271 validator (or a Safe
   module) approves only order hashes that satisfy policy.
2. **A deterministic policy gate** between the (untrusted) LLM and any signature,
   owning every order field:
   - token resolution from a chain-scoped allowlist only, never an LLM-emitted address;
   - `receiver` pinned to the account;
   - `appData` pinned to the Ophis canonical, hooks forced empty;
   - limit price within X% of an independent, staleness-checked oracle (CoW
     guarantees you won't fill *below* your limit, not that your limit is sane);
   - per-trade notional + rolling daily caps; short `validTo`; avoid `presign`.
3. **Containment:** a bounded vault-relayer allowance (the blast radius if policy
   fails once), a guardian key that can revoke signing or pause, keys in an
   HSM/TEE, and a tamper-evident audit trail.
4. **Defense in depth:** enforce the policy in two places, the EIP-1271
   validator/signer **and** server-side at orderbook ingestion.

:::warning[The signing gate must be in code, not prose]

Today "the human always signs" is a documented social contract, not an enforced
boundary. Autonomous signing is fine to pursue, but only once that promise is
replaced by the policy-enforced kit above. Otherwise an autonomous integrator is
one unpinned `receiver` away from draining itself.

:::
